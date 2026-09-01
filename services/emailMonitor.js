/**
 * services/emailMonitor.js  v4 — dual-sender support
 *
 * Supports two alert email senders:
 *   config.email.alertSender   — primary (system1)
 *   config.email.alertSender2  — secondary (track9999) — optional
 *
 * Strategy: search each sender separately, merge+deduplicate UIDs,
 * process in ascending UID order. No IDLE — pure 30s poll loop.
 */

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const config           = require('../config/settings');
const AlertParser      = require('./alertParser');
const logger           = require('../utils/logger');

const POLL_INTERVAL_MS    = 30_000;
const LOOKBACK_DAYS       = 30;
const RECONNECT_INIT_MS   = 5_000;
const RECONNECT_MAX_MS    = 5 * 60_000;
const RECONNECT_MULTIPLIER = 2;

class EmailMonitor {
  constructor(onAlert) {
    this.onAlert     = onAlert;
    this.alertParser = new AlertParser();
    this.client      = null;
    this.running     = false;
    this._polling    = false;
    this._lastProcessedUID  = 0;
    this._onStateChange     = null;
    this._reconnectDelay    = RECONNECT_INIT_MS;
    this._pollTimer         = null;
    this.stats = {
      connectedAt: null, lastEmailAt: null, lastPollAt: null,
      lastPollFound: 0, reconnects: 0,
      emailsReceived: 0, alertsSent: 0, alertsSkipped: 0,
    };
  }

  async start() {
    this._validateConfig();
    const senders = this._getSenders();
    logger.info(`Email monitor starting — watching ${config.email.user}`);
    logger.info(`Alert senders: ${senders.join(' | ')}`);
    this.running = true;
    await this._connect();
  }

  async stop() {
    this.running = false;
    clearInterval(this._pollTimer);
    if (this.client) { try { await this.client.logout(); } catch {} }
  }

  isConnected() { return !!(this.client?.usable); }

  setLastProcessedUID(uid) { this._lastProcessedUID = uid || 0; }
  onUIDProcessed(cb)       { this._onStateChange = cb; }

  _getSenders() {
    const s = [config.email.alertSender];
    if (config.email.alertSender2) s.push(config.email.alertSender2);
    return s;
  }

  async _connect() {
    logger.info(`Connecting to IMAP — ${config.email.host}:${config.email.port} ...`);

    this.client = new ImapFlow({
      host: config.email.host, port: config.email.port, secure: true,
      auth: { user: config.email.user, pass: config.email.password },
      logger: false, socketTimeout: 30_000,
    });

    this.client.on('error', (err) => {
      logger.error(`IMAP socket error: ${err.message}`);
      this._scheduleReconnect();
    });

    try {
      await this.client.connect();
      await this.client.mailboxOpen('INBOX');
    } catch (err) {
      logger.error(`IMAP connect failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.stats.connectedAt = new Date();
    this._reconnectDelay   = RECONNECT_INIT_MS;
    logger.success(`IMAP connected — ${config.email.host}`);

    clearInterval(this._pollTimer);
    await this._poll();
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    logger.info(`Poll loop active — every ${POLL_INTERVAL_MS / 1000}s`);
  }

  async _poll() {
    if (this._polling) return;
    if (!this.client?.usable) { this._scheduleReconnect(); return; }

    this._polling = true;
    this.stats.lastPollAt = new Date();

    try {
      const since = new Date();
      since.setDate(since.getDate() - LOOKBACK_DAYS);

      // Search for each sender independently and merge UIDs
      const senders = this._getSenders();
      const allUIDs = new Set();

      for (const sender of senders) {
        try {
          const uids = await this.client.search({ from: sender, since }, { uid: true });
          if (Array.isArray(uids)) uids.forEach(u => allUIDs.add(u));
        } catch (err) {
          logger.error(`Search error for sender ${sender}: ${err.message}`);
        }
      }

      const uidList = [...allUIDs].sort((a, b) => a - b);

      if (uidList.length === 0) {
        logger.debug(`Poll: 0 emails from any alert sender`);
        this.stats.lastPollFound = 0;
        return;
      }

      // First run — set watermark, skip history
      if (this._lastProcessedUID === 0) {
        const maxUID = Math.max(...uidList);
        logger.info(`First run: ${uidList.length} existing emails — watermark set to ${maxUID}`);
        this._lastProcessedUID = maxUID;
        if (this._onStateChange) this._onStateChange(maxUID);
        return;
      }

      const newUIDs = uidList.filter(uid => uid > this._lastProcessedUID);
      this.stats.lastPollFound = newUIDs.length;

      if (newUIDs.length === 0) {
        logger.debug(`Poll: all ${uidList.length} emails already processed (watermark: ${this._lastProcessedUID})`);
        return;
      }

      logger.info(`📬 Poll: ${newUIDs.length} new email(s) — UIDs ${newUIDs[0]}–${newUIDs[newUIDs.length-1]}`);

      for await (const msg of this.client.fetch(
        newUIDs.join(','), { source: true, uid: true }, { uid: true }
      )) {
        await this._processMessage(msg);
        if (msg.uid > this._lastProcessedUID) {
          this._lastProcessedUID = msg.uid;
          if (this._onStateChange) this._onStateChange(msg.uid);
        }
      }

    } catch (err) {
      logger.error(`Poll error: ${err.message}`);
      if (!this.client?.usable) this._scheduleReconnect();
    } finally {
      this._polling = false;
    }
  }

  async _processMessage(msg) {
    try {
      const parsed  = await simpleParser(msg.source);
      const fromAddr = parsed.from?.value?.[0]?.address || '';

      // Accept emails from any known sender
      const senders = this._getSenders();
      const isKnown = senders.some(s => fromAddr.toLowerCase().includes(s.toLowerCase()));
      if (!isKnown) {
        logger.debug(`Ignored email from unknown sender: ${fromAddr}`);
        return;
      }

      this.stats.emailsReceived++;
      this.stats.lastEmailAt = new Date();

      const emailDate = parsed.date
        ? parsed.date.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false })
        : 'unknown';
      logger.info(`📧 Email [UID ${msg.uid}] — "${parsed.subject}" — from: ${fromAddr} — sent: ${emailDate}`);

      const result = this.alertParser.parse(parsed);
      if (!result) {
        this.stats.alertsSkipped++;
        logger.info(`   ↳ Filtered`);
        return;
      }

      this.stats.alertsSent++;
      logger.success(`   ↳ Parsed OK — forwarding to WhatsApp`);
      await this.onAlert(result, parsed);

    } catch (err) {
      logger.error(`processMessage [UID ${msg.uid}] error: ${err.message}`);
    }
  }

  _scheduleReconnect() {
    if (!this.running) return;
    clearInterval(this._pollTimer);
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
    this.stats.reconnects++;
    logger.warn(`Reconnecting in ${delay/1000}s (attempt #${this.stats.reconnects})...`);
    setTimeout(async () => {
      if (!this.running) return;
      try {
        if (this.client) { try { await this.client.logout(); } catch {} this.client = null; }
        await this._connect();
        this._reconnectDelay = RECONNECT_INIT_MS;
        logger.success(`Reconnected`);
      } catch (err) {
        logger.error(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _validateConfig() {
    if (!config.email.user)        throw new Error('Missing .env: EMAIL_USER');
    if (!config.email.password)    throw new Error('Missing .env: EMAIL_PASSWORD');
    if (!config.email.alertSender) throw new Error('Missing .env: ALERT_SENDER');
    if (!config.email.host)        throw new Error('Cannot determine IMAP host');
  }
}

module.exports = EmailMonitor;

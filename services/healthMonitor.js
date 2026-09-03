/**
 * services/healthMonitor.js
 *
 * Prints a live status line every 60 seconds.
 * Warns if the poll hasn't found emails for an unexpectedly long time.
 */

const config = require('../config/settings');
const logger = require('../utils/logger');

class HealthMonitor {
  constructor(emailMonitor, whatsappBot, historyStore) {
    this.email    = emailMonitor;
    this.whatsapp = whatsappBot;
    this.history  = historyStore;
    this._timer   = null;
    this._start   = new Date();
  }

  start() {
    logger.info(`Health monitor reporting every ${config.health.reportInterval / 1000}s`);
    this._timer = setInterval(() => this._report(), config.health.reportInterval);
    setTimeout(() => this._report(), 5_000);
  }

  stop() { clearInterval(this._timer); }

  _report() {
    const s      = this.email.stats;
    const uptime = this._dur(Date.now() - this._start.getTime());

    let imapStatus = '🔴 Disconnected';
    if (typeof this.email.getState === 'function') {
      const st = this.email.getState();
      if (st === 'CONNECTED') imapStatus = '🟢 Connected';
      else if (st === 'RECONNECTING' || st === 'DEGRADED') imapStatus = '🟡 Degraded/Reconnecting';
      else if (st === 'CONNECTING') imapStatus = '🟡 Connecting';
      else if (st === 'STOPPED') imapStatus = '⚪ Stopped';
    } else {
      imapStatus = this.email.isConnected() ? '🟢 Connected' : '🔴 Disconnected';
    }
    const waStatus   = this.whatsapp.isReady()  ? '🟢 Ready'     : '🔴 Not ready';

    const lastEmail = s.lastEmailAt ? this._ago(s.lastEmailAt) : 'none yet';
    const lastPoll  = s.lastPollAt  ? this._ago(s.lastPollAt)  : 'never';

    logger.info(
      `📊 HEALTH | uptime: ${uptime} | IMAP: ${imapStatus} | WA: ${waStatus} | ` +
      `emails: ${s.emailsReceived} | sent: ${s.alertsSent} | skipped: ${s.alertsSkipped} | ` +
      `reconnects: ${s.reconnects} | last email: ${lastEmail} | last poll: ${lastPoll} | ` +
      `last poll found: ${s.lastPollFound} new | ` +
      `UID watermark: ${this.history.getLastProcessedUID()} | ` +
      `DB: ${this.history.globalTotal()} alerts / ${this.history.distinctVehicles()} vehicles`
    );

    // ── Stale email warning ───────────────────────────────────────────────
    if (s.lastPollAt) {
      const msSincePoll = Date.now() - s.lastPollAt.getTime();
      if (msSincePoll > 120_000) { // no poll in 2 minutes
        logger.warn(`⚠️  Poll is overdue — last ran ${this._ago(s.lastPollAt)}`);
      }
    }

    // ── Reconnect warning ─────────────────────────────────────────────────
    if (s.reconnects > 10) {
      const uptimeH = (Date.now() - this._start.getTime()) / 3_600_000;
      const rph = (s.reconnects / uptimeH).toFixed(1);
      if (parseFloat(rph) > 5) {
        logger.warn(`⚠️  High reconnect rate: ${rph}/hr — check IMAP credentials and network`);
      }
    }
  }

  _dur(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  _ago(date) {
    const ms = Date.now() - date.getTime();
    if (ms < 60_000)    return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  }
}

module.exports = HealthMonitor;

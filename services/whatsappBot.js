/**
 * services/whatsappBot.js  v6
 *
 * New commands:
 *   !score [plate]       — score for a single vehicle (all time)
 *   !leaderboard [1|3|7|14] — ranked leaderboard for the period
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode       = require('qrcode-terminal');
const config       = require('../config/settings');
const logger       = require('../utils/logger');
const alertTypes   = require('../data/alertTypes.json');
const VehicleScorer = require('./vehicleScorer');
const MessageFormatter = require('./messageFormatter');

const VALID_PERIODS   = ['1h','2h','3h','6h','12h','24h'];
const SCORE_PERIODS   = [1, 3, 7, 14];
const SEV_ORDER       = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const MUTABLE_CATEGORIES = alertTypes
  .filter(t => t.type !== 'unknown')
  .map((t, i) => ({ n: i + 1, type: t.type, label: t.label, emoji: t.emoji }));

const scorer = new VehicleScorer();

class WhatsAppBot {
  constructor() {
    this.client      = null;
    this.targetGroup = null;
    this._readyCbs   = [];
    this._ready      = false;
    this._history    = null;
    this._sendQueue  = Promise.resolve();
  }

  setHistoryStore(store) { this._history = store; }
  isReady()              { return this._ready; }

  async initialize() {
    logger.info('Initializing WhatsApp client...');
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
      puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] },
    });
    this._attachEvents();
    await this.client.initialize();
  }

  onReady(cb) {
    if (this._ready) {
      Promise.resolve().then(async () => {
        try { await cb(); } catch (err) { logger.error(`onReady callback error: ${err?.message || err}`); }
      });
    } else {
      this._readyCbs.push(cb);
    }
  }

  _enqueueSend(fn) {
    this._sendQueue = this._sendQueue.then(async () => {
      try {
        await this._ensureActiveContext();
        await fn();
      } catch (err) {
        logger.error(`Send worker error: ${err?.message || err}`);
      }
    });
    return this._sendQueue;
  }

  async _ensureActiveContext() {
    if (!this.client?.pupPage) return;
    try {
      await this.client.pupPage.evaluate(() => true);
    } catch (err) {
      if (/detached Frame|Execution context/i.test(err?.message || '')) {
        logger.warn(`WhatsApp browser context transition detected — stabilizing active frame...`);
        this.targetGroup = null;
        await new Promise(res => setTimeout(res, 1000));
        try { await this.client.pupPage.evaluate(() => true); } catch {}
      }
    }
  }

  async sendToGroup(text) {
    if (!this._ready) { this.onReady(() => this.sendToGroup(text)); return; }
    return this._enqueueSend(async () => {
      const group = await this._findGroup();
      if (!group) { logger.error(`Group not found: "${config.whatsapp.groupName}"`); return; }
      const groupId = group.id?._serialized || group.id;
      await this.client.sendMessage(groupId, text);
      logger.success(`Group message sent → ${group.name}`);
    });
  }

  async sendCriticalDMs(text) {
    if (!this._ready) return;
    if (!this._history?.isPersonalDMsEnabled()) {
      logger.info('Personal DMs disabled — skipping');
      return;
    }
    for (const num of config.criticalContacts) {
      await this._enqueueSend(async () => {
        await this.client.sendMessage(`${num}@c.us`, text);
        logger.success(`Critical DM → +${num}`);
      });
    }
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  _attachEvents() {
    this.client.on('qr', (qr) => { logger.banner('SCAN QR → WhatsApp → Settings → Linked Devices'); qrcode.generate(qr, { small: true }); });
    this.client.on('loading_screen', (p, m) => logger.info(`WA loading: ${p}% — ${m}`));
    this.client.on('authenticated',  ()      => logger.success('WhatsApp authenticated'));
    this.client.on('auth_failure',   (m)     => logger.fatal(`WA auth failed: ${m}`));
    this.client.on('ready', async () => {
      try {
        logger.success('WhatsApp READY');
        this._ready = true;
        await this._findGroup();
        for (const cb of this._readyCbs) {
          try {
            await cb();
          } catch (err) {
            logger.error(`Ready callback error: ${err?.message || err}`);
          }
        }
        this._readyCbs = [];
      } catch (err) {
        logger.error(`Error in WhatsApp ready event handler: ${err?.message || err}`);
      }
    });
    this.client.on('disconnected', (r) => {
      logger.warn(`WA disconnected: ${r}`);
      this._ready = false; this.targetGroup = null;
      setTimeout(() => this.initialize(), 15_000);
    });
    this.client.on('message', async (msg) => {
      try { await this._handleMessage(msg); } catch (err) { logger.error(`Cmd error: ${err.message}`); }
    });
  }

  // ─── Message router ───────────────────────────────────────────────────────

  async _handleMessage(msg) {
    const text      = (msg.body || '').trim();
    if (!text.startsWith('!')) return;

    const parts     = text.split(/\s+/);
    const cmd       = parts[0].toLowerCase();
    const arg1      = parts[1]?.toLowerCase() || '';
    const rest      = parts.slice(1).join(' ').trim();
    const senderNum = msg.from.replace('@c.us', '').replace('+', '');
    const isAdmin   = senderNum === config.adminNumber.replace('+', '');
    const isPersonal = !msg.from.endsWith('@g.us');

    // Admin-only personal DM commands
    if (isAdmin && isPersonal) {
      if (cmd === '!turnoff' && arg1 === 'personal') return this._adminTurnOffDMs(msg);
      if (cmd === '!turnon'  && arg1 === 'personal') return this._adminTurnOnDMs(msg);
      if (cmd === '!turnoff' && arg1 === 'help')     return this._adminMuteMenu(msg, false);
      if (cmd === '!turnon'  && arg1 === 'help')     return this._adminMuteMenu(msg, true);
      if (cmd === '!turnoff' && /^\d+$/.test(arg1))  return this._adminMuteCategory(msg, parseInt(arg1), true);
      if (cmd === '!turnon'  && /^\d+$/.test(arg1))  return this._adminMuteCategory(msg, parseInt(arg1), false);
      if (cmd === '!tripreset')                       return this._adminTripReset(msg);
    }
    if (isAdmin && cmd === '!tripreset') return this._adminTripReset(msg);

    // General commands
    if (cmd === '!vehicle')     return this._cmdVehicle(msg, rest);
    if (cmd === '!idle')        return this._cmdIdle(msg, arg1);
    if (cmd === '!trip')        return this._cmdTrip(msg, arg1);
    if (cmd === '!score')       return this._cmdScore(msg, rest);
    if (cmd === '!leaderboard') return this._cmdLeaderboard(msg, arg1);
    if (cmd === '!help')        return this._cmdHelp(msg);
  }

  // ─── Admin commands ───────────────────────────────────────────────────────

  async _adminTurnOffDMs(msg) {
    this._history.setPersonalDMs(false);
    await msg.reply(`✅ Personal DMs *disabled*. Send *!turnon personal* to re-enable.`);
  }

  async _adminTurnOnDMs(msg) {
    this._history.setPersonalDMs(true);
    await msg.reply(`✅ Personal DMs *enabled*.`);
  }

  async _adminMuteMenu(msg, showUnmute) {
    const muted = this._history.getMutedCategories();
    const lines = [ showUnmute
      ? `*Re-enable Alert Categories — !turnon <number>*\n`
      : `*Mute Alert Categories — !turnoff <number>*\n_Alerts are stored, not forwarded to group._\n` ];

    for (const cat of MUTABLE_CATEGORIES) {
      const status = muted.includes(cat.type) ? '🔇 muted' : '🔊 active';
      lines.push(`${cat.n}. ${cat.emoji} ${cat.label}  —  ${status}`);
    }
    lines.push(`\nMuted: ${muted.length === 0 ? 'none' : muted.length}`);
    await msg.reply(lines.join('\n'));
  }

  async _adminMuteCategory(msg, n, mute) {
    const cat = MUTABLE_CATEGORIES.find(c => c.n === n);
    if (!cat) { await msg.reply(`⚠️ Invalid number: ${n}. Send *!turnoff help* to see list.`); return; }
    if (mute) {
      this._history.muteCategory(cat.type);
      await msg.reply(`🔇 *${cat.emoji} ${cat.label}* muted. Send *!turnon ${n}* to re-enable.`);
    } else {
      this._history.unmuteCategory(cat.type);
      await msg.reply(`🔊 *${cat.emoji} ${cat.label}* active again.`);
    }
  }

  async _adminTripReset(msg) {
    const count = this._history.resetAllActiveTrips();
    await msg.reply(`🔄 *Trip system reset* — cleared ${count} active ignition ON state(s).\nNew trips will start fresh from the next Ignition ON email.`);
  }

  // ─── General commands ─────────────────────────────────────────────────────

  async _cmdHelp(msg) {
    await msg.reply(
      `*Fleet Bot Commands*\n\n` +
      `*!vehicle <plate>*       — History + trip & idle totals\n` +
      `*!score <plate>*         — Driver behaviour score (all time)\n` +
      `*!leaderboard [1|3|7|14]*— Fleet score ranking (default: 7 days)\n` +
      `*!idle <period>*         — Fleet idle summary (${VALID_PERIODS.join(', ')})\n` +
      `*!trip <period>*         — Fleet trip summary\n` +
      `*!help*                  — This message\n\n` +
      `_Admin DM only: !turnoff personal | !turnon personal | !turnoff help | !tripreset_`
    );
  }

  async _cmdVehicle(msg, plate) {
    if (!plate) { await msg.reply('Usage: *!vehicle <plate>*'); return; }
    const s = this._history.getVehicleSummary(plate);
    if (!s) { await msg.reply(`🔍 No history for *${plate.toUpperCase()}*`); return; }

    // Score for all time
    const allRecords = this._history.getRecordsForDays(365);
    const norm = plate.toUpperCase().replace(/[\s\/]/g, '');
    const plateRecords = allRecords.filter(r => r.plate.replace(/[\s\/]/g, '') === norm);
    const scoreResult = scorer.scoreAll(plateRecords)[0];
    const scoreStr = scoreResult
      ? `${scoreResult.score}/100 ${MessageFormatter.scoreGrade(scoreResult.score)}`
      : 'N/A';

    const lines = [
      `📋 *VEHICLE REPORT — ${s.plate}*`,
      `🚙 ${s.model}`, '',
      `⭐ *Score:*        ${scoreStr}`,
      `📊 *Total alerts:* ${s.totalAlerts}`,
      `🛣️  *Total trips:*  ${s.totalTrips}`,
      `🕐 *Trip time:*    ${s.totalTripTime}`,
      `⏱️  *Idle time:*    ${s.totalIdleTime}`,
      '', `*Alert Breakdown:*`,
    ];
    for (const t of s.byType.sort((a,b) => (SEV_ORDER[b.severity]||0)-(SEV_ORDER[a.severity]||0))) {
      lines.push(`  ${_sevEmoji(t.severity)} ${t.label.padEnd(22)} ×${t.count}`);
    }
    lines.push('', '─────────────────');
    await msg.reply(lines.join('\n'));
  }

  async _cmdScore(msg, plate) {
    if (!plate) { await msg.reply('Usage: *!score <plate>*\nFor full fleet ranking use *!leaderboard*'); return; }

    const records    = this._history.getRecordsForDays(365);
    const norm       = plate.toUpperCase().replace(/[\s\/]/g, '');
    const platRecs   = records.filter(r => r.plate.replace(/[\s\/]/g, '') === norm);

    if (platRecs.length === 0) { await msg.reply(`🔍 No data for *${plate.toUpperCase()}*`); return; }

    const result = scorer.scoreAll(platRecs)[0];
    if (!result) { await msg.reply(`No score data for ${plate}.`); return; }

    const lines = [
      `⭐ *DRIVER SCORE — ${result.plate}*`,
      `🚙 ${result.model}`,
      '',
      `*Score: ${result.score}/100  ${MessageFormatter.scoreGrade(result.score)}*`,
      `Total violations: ${result.totalEvents}`,
      `Total deduction: -${result.totalDeduction} pts`,
      '',
      `*Breakdown:*`,
    ];
    for (const b of result.breakdown) {
      lines.push(`  ${b.emoji} ${b.label.padEnd(22)} ×${b.count}  (-${b.totalDeduction.toFixed(1)}pts)`);
    }
    lines.push('', '─────────────────');
    await msg.reply(lines.join('\n'));
  }

  async _cmdLeaderboard(msg, periodArg) {
    const days = SCORE_PERIODS.includes(parseInt(periodArg)) ? parseInt(periodArg) : 7;
    const records = this._history.getRecordsForDays(days);

    if (records.length === 0) {
      await msg.reply(`📊 No data for the last ${days} day(s).`);
      return;
    }

    const scores = scorer.scoreAll(records);
    if (scores.length === 0) { await msg.reply('No scoreable vehicles found.'); return; }

    const medal = ['🥇','🥈','🥉'];
    const lines = [
      `🏆 *FLEET LEADERBOARD — ${days === 1 ? 'Today' : `Last ${days} days`}*`,
      `_${records.length} events across ${scores.length} vehicles_`,
      '',
    ];

    scores.forEach((v, i) => {
      const rank  = medal[i] || `${i+1}.`;
      const grade = MessageFormatter.scoreGrade(v.score);
      lines.push(`${rank} *${v.plate}* — ${v.score}/100  ${grade}`);
      lines.push(`   ${v.totalEvents} event(s) | -${v.totalDeduction}pts`);
      // Show top 2 worst categories
      v.breakdown.slice(0, 2).forEach(b => {
        lines.push(`   ${b.emoji} ${b.label} ×${b.count}`);
      });
    });

    lines.push('', `_!leaderboard 1 | 3 | 7 | 14   |   !score <plate> for details_`);
    await msg.reply(lines.join('\n'));
    logger.success(`!leaderboard ${days}d sent — ${scores.length} vehicles`);
  }

  async _cmdIdle(msg, period) {
    if (!VALID_PERIODS.includes(period)) {
      await msg.reply(`Usage: *!idle <period>*\nPeriods: ${VALID_PERIODS.join(', ')}`); return;
    }
    const stats = this._history.getIdleStats(parseInt(period));
    if (stats.length === 0) { await msg.reply(`⏱️ No idle events in last ${period}.`); return; }
    const lines = [`⏱️ *IDLE SUMMARY — last ${period}*`, ''];
    for (const v of stats) lines.push(`🚗 *${v.plate}* — ${v.totalIdleMin} min (${v.events} event(s))`);
    lines.push('', '─────────────────');
    await msg.reply(lines.join('\n'));
  }

  async _cmdTrip(msg, period) {
    if (!VALID_PERIODS.includes(period)) {
      await msg.reply(`Usage: *!trip <period>*\nPeriods: ${VALID_PERIODS.join(', ')}`); return;
    }
    const stats = this._history.getTripStats(parseInt(period));
    if (stats.length === 0) { await msg.reply(`🛣️ No valid trips in last ${period}.`); return; }
    const lines = [`🛣️ *TRIP SUMMARY — last ${period}*`, ''];
    for (const v of stats) lines.push(`🚗 *${v.plate}* — ${v.trips} trip(s) | ${v.totalTripStr}`);
    lines.push('', '─────────────────');
    await msg.reply(lines.join('\n'));
  }

  // ─── Group lookup ─────────────────────────────────────────────────────────

  async _findGroup() {
    if (this.targetGroup) return this.targetGroup;

    // 1. Safe in-page search via Store.Chat
    try {
      if (this.client?.pupPage) {
        const groupInfo = await this.client.pupPage.evaluate((targetName) => {
          const chats = window.Store?.Chat?.getModelsArray() || [];
          const found = chats.find(c => 
            (c.name === targetName || c.formattedTitle === targetName) && 
            (c.isGroup || c.id?._serialized?.endsWith('@g.us'))
          );
          return found ? { id: found.id._serialized, name: found.name || found.formattedTitle } : null;
        }, config.whatsapp.groupName);

        if (groupInfo) {
          this.targetGroup = { id: groupInfo.id, name: groupInfo.name };
          logger.success(`Group found: "${this.targetGroup.name}" (${this.targetGroup.id})`);
          return this.targetGroup;
        }
      }
    } catch (err) {
      logger.warn(`Safe group search error: ${err?.message || err}`);
    }

    // 2. Fallback to standard getChats
    try {
      const chats = await this.client.getChats();
      const group = chats.find(c => c.isGroup && c.name === config.whatsapp.groupName);
      if (group) {
        this.targetGroup = { id: group.id._serialized || group.id, name: group.name };
        logger.success(`Group found via fallback: "${this.targetGroup.name}"`);
        return this.targetGroup;
      }
    } catch (err) {
      logger.warn(`Fallback getChats error: ${err?.message || err}`);
    }

    logger.error(`Group not found: "${config.whatsapp.groupName}"`);
    return null;
  }
}

function _sevEmoji(s) { return { CRITICAL:'🆘', HIGH:'🔴', MEDIUM:'🟡', LOW:'🟢' }[s] || '⚪'; }

module.exports = WhatsAppBot;

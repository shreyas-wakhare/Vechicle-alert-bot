/**
 * services/dailySummary.js  v4
 *
 * Sends a 24h fleet summary to the WhatsApp group at 17:00 Dubai time.
 * Covers only the last 24 hours. Includes trip and idle totals.
 */

const config = require('../config/settings');
const logger = require('../utils/logger');
const AIFleetSynthesis = require('./aiFleetSynthesis');
const MessageFormatter = require('./messageFormatter');

const SUMMARY_HOUR = 17;
const TIMEZONE     = 'Asia/Dubai';
const SEV_ORDER    = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

class DailySummary {
  constructor(history, whatsapp) {
    this.history  = history;
    this.whatsapp = whatsapp;
    this._timer   = null;
    this.fleetSynth = new AIFleetSynthesis();
    this.formatter  = new MessageFormatter();
  }

  start() {
    logger.info(`Daily summary scheduled at ${SUMMARY_HOUR}:00 Dubai time (24h window)`);
    this._timer = setInterval(() => this._check(), 60_000);
    setTimeout(() => this._check(), 3_000);
  }

  stop() { clearInterval(this._timer); }

  _check() {
    const now      = new Date();
    const dubaiStr = now.toLocaleString('en-GB', { timeZone: TIMEZONE, hour12: false });
    const [datePart, timePart] = dubaiStr.split(', ');
    const [d, m, y] = datePart.split('/');
    const [hh]      = timePart.split(':');
    const hour      = parseInt(hh, 10);
    const dateKey   = `${y}-${m}-${d}`;

    if (hour < SUMMARY_HOUR) return;
    if (this.history.getDailySummarySentDate() === dateKey) return;

    logger.info(`⏰ Daily summary trigger — ${dateKey}`);
    this.history.setDailySummarySentDate(dateKey);
    this._send(dateKey).catch(err => logger.error(`Daily summary error: ${err.message}`));
  }

  async _send(dateKey) {
    const HOURS        = 24;
    const recent       = this.history.getRecentRecords(HOURS);
    const recentTrips  = this.history.getRecentTrips(HOURS);
    const idleStats    = this.history.getIdleStats(HOURS);
    const tripStats    = this.history.getTripStats(HOURS);

    // Per-vehicle breakdown for the last 24h
    const plates = [...new Set([
      ...recent.map(r => r.plate),
      ...recentTrips.map(t => t.plate),
    ])];

    if (plates.length === 0) {
      await this.whatsapp.sendToGroup(
        `📊 *DAILY FLEET SUMMARY — ${_fmtDate(dateKey)}*\n\n_No activity in the last 24 hours._`
      );
      return;
    }

    // Aggregate per plate
    const byPlate = {};
    for (const r of recent) {
      if (!byPlate[r.plate]) byPlate[r.plate] = { plate: r.plate, model: r.vehicleModel, alerts: {}, idleMin: 0, trips: 0, tripMs: 0 };
      const entry = byPlate[r.plate];
      if (!entry.alerts[r.alertType]) entry.alerts[r.alertType] = { label: r.alertLabel, severity: r.severity, count: 0 };
      entry.alerts[r.alertType].count++;
      entry.idleMin += r.idleDurationMin || 0;
    }
    for (const t of recentTrips) {
      if (!byPlate[t.plate]) byPlate[t.plate] = { plate: t.plate, model: t.vehicleModel, alerts: {}, idleMin: 0, trips: 0, tripMs: 0 };
      byPlate[t.plate].trips++;
      byPlate[t.plate].tripMs += t.durationMs || 0;
    }

    // Fleet totals
    const totalAlerts = recent.length;
    const totalTrips  = recentTrips.length;
    const totalTripMs = recentTrips.reduce((s, t) => s + (t.durationMs || 0), 0);
    const totalIdleMin = idleStats.reduce((s, v) => s + v.totalIdleMin, 0);

    const vehicleLines = Object.values(byPlate)
      .sort((a, b) => Object.values(b.alerts).reduce((s,t)=>s+t.count,0) - Object.values(a.alerts).reduce((s,t)=>s+t.count,0))
      .map(v => {
        const alertTotal = Object.values(v.alerts).reduce((s, t) => s + t.count, 0);
        const topAlerts  = Object.values(v.alerts)
          .sort((a, b) => (SEV_ORDER[b.severity]||0) - (SEV_ORDER[a.severity]||0))
          .map(t => `    ${_sevEmoji(t.severity)} ${t.label} ×${t.count}`)
          .join('\n');
        const tripLine  = v.trips  > 0 ? `\n   🛣️  ${v.trips} trip(s) — ${_fmtDur(v.tripMs)}` : '';
        const idleLine  = v.idleMin > 0 ? `\n   ⏱️  Idle: ${v.idleMin} min` : '';
        return (
          `🚗 *${v.plate}* — ${v.model || '?'} — ${alertTotal} alert(s)` +
          tripLine + idleLine + (topAlerts ? `\n${topAlerts}` : '')
        );
      }).join('\n\n');

    let fleetAiBriefingText = null;
    try {
      const fleetResult = await this.fleetSynth.synthesizeFleet(recent, HOURS);
      fleetAiBriefingText = this.formatter.formatFleetExecutiveBriefing(fleetResult);
    } catch (aiErr) {
      logger.warn(`Daily summary AI fleet synthesis exception: ${aiErr?.message || aiErr}`);
    }

    const aiBlock = fleetAiBriefingText ? `\n\n*🤖 AI FLEET EXECUTIVE BRIEFING*\n${fleetAiBriefingText}\n\n${'─'.repeat(28)}` : '';

    const msg =
      `📊 *DAILY FLEET SUMMARY*\n` +
      `📅 ${_fmtDate(dateKey)} (last 24h)\n` +
      `${'─'.repeat(28)}\n\n` +
      `*Fleet Totals*\n` +
      `🚗 Active vehicles: ${plates.length}\n` +
      `📋 Total alerts:    ${totalAlerts}\n` +
      `🛣️  Completed trips:  ${totalTrips} (${_fmtDur(totalTripMs)})\n` +
      `⏱️  Total idle time:  ${totalIdleMin} min\n` +
      `${aiBlock}\n\n` +
      `*Per-Vehicle*\n\n` +
      `${vehicleLines}\n\n` +
      `${'─'.repeat(28)}\n` +
      `_!vehicle <plate>  |  !idle <period>  |  !trip <period>_`;

    await this.whatsapp.sendToGroup(msg);
    logger.success(`Daily summary sent — ${plates.length} vehicles, ${totalAlerts} alerts, ${totalTrips} trips`);
  }
}

function _fmtDate(dateKey) {
  const [y, m, d] = dateKey.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

function _fmtDur(ms) {
  if (!ms || ms <= 0) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function _sevEmoji(s) {
  return { CRITICAL:'🆘', HIGH:'🔴', MEDIUM:'🟡', LOW:'🟢' }[s] || '⚪';
}

module.exports = DailySummary;

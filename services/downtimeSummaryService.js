/**
 * services/downtimeSummaryService.js
 *
 * Generates and dispatches the single consolidated "📊 SERVER DOWNTIME SUMMARY"
 * when the bot/server was offline for more than 30 minutes.
 *
 * Key Invariants:
 * 1. Half-open window: [offlineStart, startupTime).
 * 2. Critical alerts are explicitly highlighted in their own section with vehicle/time details.
 * 3. Critical alerts are separated and NOT double-counted in non-critical totals.
 * 4. Completed valid trips in the window are queried via HistoryStore.
 * 5. Uses read-only FleetIntelligenceEngine and AIFleetSynthesis (with deterministic fallback).
 * 6. Historical events are never replayed through real-time intelligence engines.
 */

'use strict';

const logger = require('../utils/logger');
const FleetIntelligenceEngine = require('./fleetIntelligenceEngine');
const AIFleetSynthesis = require('./aiFleetSynthesis');
const MessageFormatter = require('./messageFormatter');
const alertTypesList = require('../data/alertTypes.json');

const ALERT_TYPE_MAP = new Map(alertTypesList.map(a => [a.type, a]));
const TIMEZONE = 'Asia/Dubai';
const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

class DowntimeSummaryService {
  /**
   * @param {Object} history - HistoryStore instance
   * @param {Object} whatsapp - WhatsAppBot instance
   * @param {Object} [options]
   * @param {Object} [options.fleetEngine]
   * @param {Object} [options.fleetSynth]
   * @param {Object} [options.formatter]
   */
  constructor(history, whatsapp, options = {}) {
    this.history = history;
    this.whatsapp = whatsapp;

    this.fleetEngine = options.fleetEngine || new FleetIntelligenceEngine({ historyStore: history });
    this.fleetSynth = options.fleetSynth || new AIFleetSynthesis();
    this.formatter = options.formatter || new MessageFormatter();
  }

  /**
   * Generates and sends the downtime summary report.
   *
   * @param {Object} interval
   * @param {Date} interval.offlineStart - Server offline timestamp
   * @param {Date} interval.startupTime - Server startup timestamp
   * @param {number} [interval.durationMs] - Downtime duration in ms
   * @returns {Promise<{ sent: boolean, alertCount: number, criticalCount: number, messageText?: string }>}
   */
  async sendSummary(interval) {
    const { offlineStart, startupTime } = interval;
    if (!offlineStart || !startupTime) {
      logger.warn('DowntimeSummaryService: missing offlineStart or startupTime — skipping summary');
      return { sent: false, alertCount: 0, criticalCount: 0 };
    }

    const durationMs = interval.durationMs || (startupTime.getTime() - offlineStart.getTime());
    logger.info(`DowntimeSummaryService: generating Downtime Summary for [${offlineStart.toISOString()} → ${startupTime.toISOString()}] (${this._fmtDur(durationMs)})`);

    const reportText = await this.buildReport({ offlineStart, startupTime, durationMs });

    if (this.whatsapp && typeof this.whatsapp.sendToGroup === 'function') {
      await this.whatsapp.sendToGroup(reportText);
      logger.success('DowntimeSummaryService: 📊 SERVER DOWNTIME SUMMARY successfully sent to WhatsApp group');
    }

    return {
      sent: true,
      durationMs,
      messageText: reportText,
    };
  }

  /**
   * Builds the formatted Downtime Summary markdown report.
   *
   * @param {Object} params
   * @param {Date} params.offlineStart
   * @param {Date} params.startupTime
   * @param {number} params.durationMs
   * @returns {Promise<string>}
   */
  async buildReport({ offlineStart, startupTime, durationMs }) {
    // 1. Retrieve historical alert records in [offlineStart, startupTime)
    let records = [];
    if (this.history && typeof this.history.getRecordsInRange === 'function') {
      records = this.history.getRecordsInRange(offlineStart, startupTime);
    } else if (this.history && typeof this.history.getRecentRecords === 'function') {
      const hours = Math.ceil(durationMs / 3_600_000) + 1;
      const startMs = offlineStart.getTime();
      const endMs = startupTime.getTime();
      records = (this.history.getRecentRecords(hours) || []).filter(r => {
        const t = new Date(r.receivedAt || r.loggedAt).getTime();
        return t >= startMs && t < endMs;
      });
    }

    // Exclude silent ignition_on/off from general alerts
    const alerts = records.filter(r => r.alertType !== 'ignition_on' && r.alertType !== 'ignition_off');

    // 2. Classify critical vs. non-critical alerts
    const criticalAlerts = [];
    const nonCriticalAlerts = [];

    for (const a of alerts) {
      if (this._isCriticalAlert(a)) {
        criticalAlerts.push(a);
      } else {
        nonCriticalAlerts.push(a);
      }
    }

    // 3. Retrieve valid completed trips in [offlineStart, startupTime)
    let completedTrips = 0;
    if (this.history && typeof this.history.getValidTripsInRange === 'function') {
      completedTrips = this.history.getValidTripsInRange(offlineStart, startupTime).length;
    } else if (this.history && typeof this.history.getRecentTrips === 'function') {
      const hours = Math.ceil(durationMs / 3_600_000) + 1;
      const startMs = offlineStart.getTime();
      const endMs = startupTime.getTime();
      const trips = this.history.getRecentTrips(hours) || [];
      completedTrips = trips.filter(t => {
        const tEnd = new Date(t.endTime).getTime();
        return tEnd >= startMs && tEnd < endMs;
      }).length;
    }

    // 4. Fleet Totals
    const activePlates = [...new Set(alerts.map(a => a.plate).filter(Boolean).map(p => p.toUpperCase()))];
    const totalIdleMin = alerts.reduce((sum, a) => {
      const idle = parseInt(a.idleTime, 10);
      return sum + (!isNaN(idle) && idle > 0 ? idle : (a.idleDurationMin || 0));
    }, 0);

    // 5. Read-only Fleet Intelligence evaluation
    const windowHours = Math.max(0.5, durationMs / 3_600_000);
    const recordsForFleet = alerts.map(a => ({
      plate: a.plate,
      vehicleModel: a.vehicleModel,
      alertType: a.alertType,
      alertLabel: a.alertLabel,
      severity: a.severity || 'MEDIUM',
      receivedAt: a.receivedAt || (a.loggedAt ? new Date(a.loggedAt).toISOString() : new Date().toISOString()),
      driver: a.driver,
    }));

    const fleetIntel = this.fleetEngine.evaluateFleet(windowHours, recordsForFleet);

    // 6. Risk Overview
    const riskCounts = { CRITICAL: 0, HIGH: 0, ELEVATED: 0, NORMAL: 0 };
    if (Array.isArray(fleetIntel?.vehicles)) {
      for (const v of fleetIntel.vehicles) {
        const lvl = v.risk?.level;
        if (lvl === 'CRITICAL') riskCounts.CRITICAL++;
        else if (lvl === 'HIGH') riskCounts.HIGH++;
        else if (lvl === 'ELEVATED' || lvl === 'MEDIUM') riskCounts.ELEVATED++;
        else riskCounts.NORMAL++;
      }
    }

    // 7. AI Fleet Executive Briefing (or Deterministic Fallback)
    let aiBriefingText = null;
    try {
      const synthResult = await this.fleetSynth.synthesizeFleet(recordsForFleet, windowHours);
      if (synthResult) {
        aiBriefingText = this.formatter.formatFleetExecutiveBriefing(synthResult);
      }
    } catch (aiErr) {
      logger.warn(`DowntimeSummaryService: AI fleet synthesis error: ${aiErr?.message || aiErr}`);
    }

    // 8. Format Date / Time strings
    const startStr = this._fmtDateTime(offlineStart);
    const endStr = this._fmtDateTime(startupTime);
    const durStr = this._fmtDur(durationMs);

    // 9. Format Per-Vehicle Breakdown
    const byPlate = {};
    for (const a of alerts) {
      const plate = (a.plate || 'UNKNOWN').toUpperCase();
      const model = a.vehicleModel || '?';
      if (!byPlate[plate]) byPlate[plate] = { plate, model, alerts: {} };

      const type = a.alertType || 'unknown';
      if (!byPlate[plate].alerts[type]) {
        const meta = ALERT_TYPE_MAP.get(type);
        byPlate[plate].alerts[type] = {
          label: a.alertLabel || meta?.label || type,
          emoji: meta?.emoji || '⚠️',
          severity: a.severity || meta?.severity || 'MEDIUM',
          count: 0,
        };
      }
      byPlate[plate].alerts[type].count++;
    }

    const vehicleLines = Object.values(byPlate)
      .sort((a, b) => {
        const countA = Object.values(a.alerts).reduce((s, x) => s + x.count, 0);
        const countB = Object.values(b.alerts).reduce((s, x) => s + x.count, 0);
        return countB - countA;
      })
      .map(v => {
        const total = Object.values(v.alerts).reduce((s, x) => s + x.count, 0);
        const alertList = Object.values(v.alerts)
          .sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0))
          .map(a => `    ${a.emoji} ${a.label} ×${a.count}`)
          .join('\n');
        return `🚗 *${v.plate}* — ${v.model} — ${total} alert(s)\n${alertList}`;
      })
      .join('\n\n');

    // 10. Assemble Full Report
    const lines = [];
    lines.push(`📊 *SERVER DOWNTIME SUMMARY*`);
    lines.push('');
    lines.push(`📅 *Server Offline:*`);
    lines.push(`${startStr}`);
    lines.push(`→ ${endStr}`);
    lines.push('');
    lines.push(`⏱️ *Downtime Duration:* ${durStr}`);
    lines.push('─'.repeat(28));
    lines.push('');
    lines.push(`*Fleet Totals*`);
    lines.push(`🚗 Active vehicles: ${activePlates.length}`);
    lines.push(`📋 Total alerts:    ${alerts.length}`);
    lines.push(`   ↳ Non-critical:  ${nonCriticalAlerts.length}`);
    lines.push(`   ↳ Critical:      ${criticalAlerts.length}`);
    lines.push(`🛣️ Completed trips: ${completedTrips}`);
    lines.push(`⏱️ Total idle time: ${totalIdleMin} min`);
    lines.push('');
    lines.push('─'.repeat(28));
    lines.push('');

    // Critical Alerts Section
    lines.push(`*🚨 Critical Alerts During Downtime*`);
    if (criticalAlerts.length === 0) {
      lines.push(`🟢 None detected during offline period`);
    } else {
      lines.push(`🔴 Critical alerts: ${criticalAlerts.length}`);
      for (const ca of criticalAlerts) {
        const meta = ALERT_TYPE_MAP.get(ca.alertType);
        const emoji = meta?.emoji || '🚨';
        const label = ca.alertLabel || meta?.label || ca.alertType;
        const timeStr = this._fmtTime(new Date(ca.receivedAt || ca.loggedAt));
        lines.push(`${emoji} ${label} — *${ca.plate || '?'}* (${timeStr})`);
      }
    }

    lines.push('');
    lines.push('─'.repeat(28));
    lines.push('');
    lines.push(`*🚨 Risk Overview*`);
    lines.push(`🔴 Critical: ${riskCounts.CRITICAL} vehicles`);
    lines.push(`🟠 High: ${riskCounts.HIGH} vehicles`);
    lines.push(`🟡 Elevated: ${riskCounts.ELEVATED} vehicles`);
    lines.push(`🟢 Normal: ${riskCounts.NORMAL} vehicles`);

    if (aiBriefingText) {
      lines.push('');
      lines.push('');
      lines.push(`*🤖 AI FLEET EXECUTIVE BRIEFING*`);
      lines.push(aiBriefingText);
    }

    if (vehicleLines) {
      lines.push('');
      lines.push('─'.repeat(28));
      lines.push('');
      lines.push(`*Per-Vehicle Activity*`);
      lines.push('');
      lines.push(vehicleLines);
    }

    lines.push('');
    lines.push('─'.repeat(28));
    lines.push(`_System resumed normal operation_`);

    return lines.join('\n');
  }

  _isCriticalAlert(r) {
    if (r.alertType === 'sos' || r.alertType === 'accident' || r.alertType === 'engine_failure' || r.severity === 'CRITICAL') {
      return true;
    }
    if (r.alertType === 'speeding' && r.speed && r.speedLimit) {
      const excess = (parseInt(r.speed, 10) || 0) - (parseInt(r.speedLimit, 10) || 0);
      if (excess >= 15) return true;
    }
    if (r.alertType === 'idle' && r.idleDurationMin >= 15) {
      return true;
    }
    return false;
  }

  _fmtDateTime(d) {
    if (!d) return 'Unknown';
    const datePart = d.toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' });
    const timePart = d.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
    return `${datePart} | ${timePart}`;
  }

  _fmtTime(d) {
    if (!d) return '??:??';
    return d.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  }

  _fmtDur(ms) {
    if (!ms || ms <= 0) return '0m';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }
}

module.exports = DowntimeSummaryService;

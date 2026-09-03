/**
 * services/fleetAlertBatcher.js
 *
 * 30-Minute Fleet Alert Batching & Reporting Engine.
 *
 * Requirements:
 * 1. Accumulates non-critical alerts into deterministic wall-clock half-hour windows (:00 and :30).
 * 2. At the end of each window, generates ONE consolidated Fleet Alert Summary.
 * 3. Bypasses critical alerts immediately (handled by index.js delivery router; never added to batcher).
 * 4. Empty window (0 non-critical alerts) sends nothing (no WhatsApp spam).
 * 5. Single-flight lock and window ID persistence prevent duplicate reports.
 * 6. Reconstructs unflushed non-critical alerts on crash/restart from HistoryStore without replaying intelligence.
 * 7. Preserves 100% of Features #1–#4 intelligence.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const FleetIntelligenceEngine = require('./fleetIntelligenceEngine');
const AIFleetSynthesis = require('./aiFleetSynthesis');
const MessageFormatter = require('./messageFormatter');
const alertTypesList = require('../data/alertTypes.json');

const ALERT_TYPE_MAP = new Map(alertTypesList.map(a => [a.type, a]));
const TIMEZONE = 'Asia/Dubai';
const HALF_HOUR_MS = 30 * 60 * 1000;
const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

class FleetAlertBatcher {
  /**
   * @param {Object} history - HistoryStore instance
   * @param {Object} whatsapp - WhatsAppBot instance
   * @param {Object} [options]
   * @param {number} [options.intervalMinutes=30]
   * @param {string} [options.stateFile]
   * @param {boolean} [options.persist=true]
   * @param {Object} [options.fleetEngine]
   * @param {Object} [options.fleetSynth]
   * @param {Object} [options.formatter]
   */
  constructor(history, whatsapp, options = {}) {
    this.history = history;
    this.whatsapp = whatsapp;
    this.intervalMinutes = options.intervalMinutes || 30;
    this._persist = options.persist !== false;
    this._stateFile = options.stateFile || path.join(process.cwd(), 'data', 'batch_state.json');

    this.fleetEngine = options.fleetEngine || new FleetIntelligenceEngine({ historyStore: history });
    this.fleetSynth = options.fleetSynth || new AIFleetSynthesis();
    this.formatter = options.formatter || new MessageFormatter();

    this._buffer = [];
    this._timer = null;
    this._isFlushing = false;
    this._running = false;
    this._lastFlushedWindowId = null;

    this._loadState();
  }

  // ─── State Persistence ───────────────────────────────────────────────────

  _loadState() {
    if (!this._persist) return;
    try {
      if (fs.existsSync(this._stateFile)) {
        const data = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        this._lastFlushedWindowId = data.lastFlushedWindowId || null;
      }
    } catch (err) {
      logger.warn(`FleetAlertBatcher: could not load state from ${this._stateFile}: ${err.message}`);
    }
  }

  _saveState() {
    if (!this._persist) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(
        this._stateFile,
        JSON.stringify({
          lastFlushedWindowId: this._lastFlushedWindowId,
          updatedAt: new Date().toISOString(),
        }, null, 2),
        'utf8'
      );
    } catch (err) {
      logger.warn(`FleetAlertBatcher: could not save state to ${this._stateFile}: ${err.message}`);
    }
  }

  // ─── Window Timing ────────────────────────────────────────────────────────

  /**
   * Returns deterministic half-hour window bounds for any given timestamp.
   * Half-open interval: [start, end)
   *
   * @param {Date|number} [targetDate]
   * @returns {{ start: Date, end: Date, windowId: string, label: string, dateLabel: string, startHHMM: string, endHHMM: string }}
   */
  getWindow(targetDate = new Date()) {
    const ms = targetDate instanceof Date ? targetDate.getTime() : new Date(targetDate).getTime();
    const startMs = Math.floor(ms / HALF_HOUR_MS) * HALF_HOUR_MS;
    const endMs = startMs + HALF_HOUR_MS;

    const start = new Date(startMs);
    const end = new Date(endMs);

    const startHHMM = start.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
    const endHHMM = end.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
    const dateLabel = start.toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' });

    const dubaiDate = start.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
    const windowId = `${dubaiDate}_${startHHMM}-${endHHMM}`;
    const label = `${dateLabel} | ${startHHMM}–${endHHMM}`;

    return { start, end, windowId, label, dateLabel, startHHMM, endHHMM };
  }

  // ─── Lifecycle & Timer ────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;

    logger.info(`FleetAlertBatcher started — 30-minute half-hour window schedule`);
    this.recoverFromHistory();
    this._scheduleNextBoundary();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logger.info(`FleetAlertBatcher stopped`);
  }

  _scheduleNextBoundary() {
    if (!this._running) return;

    const now = new Date();
    const currentWindow = this.getWindow(now);
    const msToNext = Math.max(1000, currentWindow.end.getTime() - now.getTime());

    logger.debug(`FleetAlertBatcher: current window [${currentWindow.label}] — next flush in ${Math.round(msToNext / 1000)}s`);

    this._timer = setTimeout(async () => {
      try {
        await this.flushWindow(currentWindow);
      } catch (err) {
        logger.error(`FleetAlertBatcher flush error: ${err?.message || err}`);
      } finally {
        this._scheduleNextBoundary();
      }
    }, msToNext);
  }

  // ─── Crash & Restart Recovery ─────────────────────────────────────────────

  /**
   * Reconstructs unflushed non-critical alert records from HistoryStore for the current window.
   * Runs upon process start/restart to ensure crash resilience without duplicate DB storage.
   *
   * Invariants:
   * 1. Reconstructs only records strictly within [currentWindow.start, currentWindow.end).
   * 2. Excludes critical alerts (sos, accident, engine_failure, severity CRITICAL, dynamic critical excess).
   * 3. Excludes ignition_on (silent) and ignition_off (represented via valid completed trips).
   * 4. Deduplicates against existing in-memory buffer items.
   * 5. Never replays records through the intelligence pipeline or mutates RiskEngine.
   * 6. Respects _lastFlushedWindowId: if current window was already flushed, skips recovery.
   *
   * @param {Date} [targetDate] - Optional reference date
   * @returns {number} Number of recovered records
   */
  recoverFromHistory(targetDate = new Date()) {
    if (!this.history || typeof this.history.getRecentRecords !== 'function') return 0;

    const currentWindow = this.getWindow(targetDate);

    // If current window was already flushed before restart, do not recover
    if (this._lastFlushedWindowId === currentWindow.windowId) {
      logger.debug(`FleetAlertBatcher: window [${currentWindow.windowId}] already flushed — recovery skipped`);
      return 0;
    }

    const startMs = currentWindow.start.getTime();
    const endMs = currentWindow.end.getTime();

    // Query in-memory records (1 hour covers the active 30m window)
    const recentRecords = this.history.getRecentRecords(1) || [];
    let recoveredCount = 0;

    for (const r of recentRecords) {
      const recTime = new Date(r.receivedAt || r.loggedAt || targetDate).getTime();
      // Strict half-open boundary: timestamp >= window.start && timestamp < window.end
      if (recTime < startMs || recTime >= endMs) continue;

      // Exclude ignition events
      if (r.alertType === 'ignition_on' || r.alertType === 'ignition_off') continue;

      // Exclude critical taxonomy alerts
      const isTaxonomyCritical = r.alertType === 'sos' ||
                                 r.alertType === 'accident' ||
                                 r.alertType === 'engine_failure' ||
                                 r.severity === 'CRITICAL';
      if (isTaxonomyCritical) continue;

      // Exclude dynamic critical speeding (excess >= 15 km/h)
      if (r.alertType === 'speeding' && r.speed && r.speedLimit) {
        const excess = (parseInt(r.speed, 10) || 0) - (parseInt(r.speedLimit, 10) || 0);
        if (excess >= 15) continue;
      }

      // Exclude dynamic critical idle (over >= 15 min)
      if (r.alertType === 'idle' && r.idleDurationMin >= 15) {
        continue;
      }

      // Deduplication: skip if already present in buffer
      const plate = (r.plate || '').toUpperCase();
      const exists = this._buffer.some(e =>
        (e.fields?.plate || '').toUpperCase() === plate &&
        e.alertDef?.type === r.alertType &&
        Math.abs(e.timestamp.getTime() - recTime) < 1000
      );
      if (exists) continue;

      const typeMeta = ALERT_TYPE_MAP.get(r.alertType);
      const alertDef = {
        type: r.alertType,
        label: r.alertLabel || typeMeta?.label || r.alertType,
        severity: r.severity || typeMeta?.severity || 'MEDIUM',
        emoji: typeMeta?.emoji || '⚠️',
      };

      const fields = {
        plate: r.plate,
        vehicleModel: r.vehicleModel,
        driver: r.driver,
        idleTime: r.idleTime,
        idleLimit: r.idleLimit,
        speed: r.speed,
        speedLimit: r.speedLimit,
        address: r.address,
        alertTime: r.receivedAt,
        source: r.source,
      };

      this._buffer.push({
        alertDef,
        fields,
        context: null,
        mail: null,
        timestamp: new Date(recTime),
        receivedAt: new Date(recTime),
        isCritical: false,
        recovered: true,
      });

      recoveredCount++;
    }

    if (recoveredCount > 0) {
      logger.info(`FleetAlertBatcher: recovered ${recoveredCount} unflushed non-critical alert(s) from HistoryStore for window [${currentWindow.label}]`);
    }

    return recoveredCount;
  }

  // ─── Event Buffering ─────────────────────────────────────────────────────

  /**
   * Buffers a non-critical alert event into the active window.
   * Critical alerts must not be passed to this method.
   *
   * @param {Object} item
   * @param {Object} item.alertDef - Alert definition
   * @param {Object} item.fields - Alert fields
   * @param {Object} [item.context] - EventContext object
   * @param {Object} [item.mail] - Mail object
   * @param {boolean} [item.isCritical=false] - Critical alert flag
   */
  addEvent({ alertDef, fields, context, mail, isCritical = false }) {
    // If somehow a critical alert is passed, strictly reject buffering it
    if (isCritical || alertDef?.severity === 'CRITICAL' || alertDef?.type === 'sos' || alertDef?.type === 'accident' || alertDef?.type === 'engine_failure') {
      logger.debug(`FleetAlertBatcher: ignoring critical alert ${alertDef?.label || alertDef?.type} from non-critical batch`);
      return;
    }

    const rawTime = fields?.alertTime || mail?.date || new Date();
    const timestamp = new Date(rawTime);

    const eventRecord = {
      alertDef,
      fields: fields || {},
      context: context || null,
      mail: mail || null,
      timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
      receivedAt: new Date(),
      isCritical: false,
    };

    this._buffer.push(eventRecord);

    logger.info(
      `   ↳ 📥 [FleetAlertBatcher] Buffered non-critical event: ${alertDef?.label || alertDef?.type} ` +
      `for ${fields?.plate || '?'} (Buffer size: ${this._buffer.length})`
    );
  }

  getBufferSize() {
    return this._buffer.length;
  }

  getBuffer() {
    return [...this._buffer];
  }

  clearBuffer() {
    this._buffer = [];
  }

  // ─── Window Flush & Report Dispatch ───────────────────────────────────────

  /**
   * Flushes the specified window and sends ONE consolidated summary report if non-critical events exist.
   *
   * @param {Object} [targetWindow] - Optional specific window to flush
   * @returns {Promise<{ sent: boolean, reason?: string, windowId: string, alertCount: number, messageText?: string }>}
   */
  async flushWindow(targetWindow = null) {
    if (this._isFlushing) {
      logger.warn(`FleetAlertBatcher: flush already in progress — skipping overlapping flush`);
      return { sent: false, reason: 'in_progress', windowId: targetWindow?.windowId, alertCount: 0 };
    }

    this._isFlushing = true;

    try {
      const window = targetWindow || this.getWindow(new Date(Date.now() - 1000));
      const { start, end, windowId, label, dateLabel, startHHMM, endHHMM } = window;

      // Duplicate prevention: do not re-send the same window
      if (this._lastFlushedWindowId === windowId) {
        logger.debug(`FleetAlertBatcher: window [${windowId}] already flushed — skipping`);
        return { sent: false, reason: 'already_flushed', windowId, alertCount: 0 };
      }

      // Partition buffer into events belonging to this window vs future events
      const windowEvents = [];
      const remainingEvents = [];

      for (const event of this._buffer) {
        // Half-open interval: timestamp < end
        if (event.timestamp.getTime() < end.getTime()) {
          windowEvents.push(event);
        } else {
          remainingEvents.push(event);
        }
      }

      // Filter strictly for non-critical alerts
      const nonCriticalAlerts = windowEvents.filter(e => !e.isCritical);

      // Empty Window Behavior: send nothing if 0 non-critical alerts
      if (nonCriticalAlerts.length === 0) {
        logger.info(`FleetAlertBatcher: 0 non-critical alerts in window [${label}] — skipping report (empty window)`);
        this._buffer = remainingEvents;
        this._lastFlushedWindowId = windowId;
        this._saveState();
        return { sent: false, reason: 'empty_window', windowId, alertCount: 0 };
      }

      logger.info(`FleetAlertBatcher: flushing window [${label}] with ${nonCriticalAlerts.length} non-critical alert(s)...`);

      // ─── Generate Consolidated Report ─────────────────────────────────────
      const reportText = await this._buildReport({
        nonCriticalAlerts,
        start,
        end,
        label,
        dateLabel,
        startHHMM,
        endHHMM,
      });

      // Dispatch exactly ONE message to WhatsApp group
      if (this.whatsapp && typeof this.whatsapp.sendToGroup === 'function') {
        await this.whatsapp.sendToGroup(reportText);
        logger.success(`FleetAlertBatcher: 📊 FLEET ALERT SUMMARY sent for window [${label}]`);
      }

      // Advance buffer and update state
      this._buffer = remainingEvents;
      this._lastFlushedWindowId = windowId;
      this._saveState();

      return {
        sent: true,
        windowId,
        alertCount: nonCriticalAlerts.length,
        messageText: reportText,
      };

    } finally {
      this._isFlushing = false;
    }
  }

  // ─── Report Builder ───────────────────────────────────────────────────────

  async _buildReport({ nonCriticalAlerts, start, end, label, dateLabel, startHHMM, endHHMM }) {
    // 1. Unique active vehicles strictly from non-critical alerts
    const plates = [...new Set(nonCriticalAlerts.map(e => e.fields?.plate).filter(Boolean).map(p => p.toUpperCase()))];

    // 2. Completed trips in window (valid trips ended strictly in [start, end))
    let completedTrips = 0;
    if (this.history && typeof this.history.getRecentTrips === 'function') {
      try {
        const recentTrips = this.history.getRecentTrips(1); // Check last 1h
        completedTrips = recentTrips.filter(t => {
          const tTime = new Date(t.endTime).getTime();
          return tTime >= start.getTime() && tTime < end.getTime();
        }).length;
      } catch (err) {
        logger.warn(`FleetAlertBatcher: trip calculation error: ${err.message}`);
      }
    }

    // 3. Idle duration in window (strictly from non-critical alerts)
    const totalIdleMin = nonCriticalAlerts.reduce((sum, e) => {
      const idle = parseInt(e.fields?.idleTime, 10);
      return sum + (!isNaN(idle) && idle > 0 ? idle : 0);
    }, 0);

    // 4. Deterministic Fleet Intelligence (Read-Only) strictly from non-critical alerts
    const recordsForFleet = nonCriticalAlerts.map(e => ({
      plate: e.fields?.plate,
      vehicleModel: e.fields?.vehicleModel,
      alertType: e.alertDef?.type,
      alertLabel: e.alertDef?.label,
      severity: e.alertDef?.severity || 'MEDIUM',
      receivedAt: e.timestamp.toISOString(),
      driver: e.fields?.driver,
    }));

    const fleetIntel = this.fleetEngine.evaluateFleet(0.5, recordsForFleet);

    // 5. Risk Overview Breakdown strictly from non-critical alerts
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

    // 6. AI Fleet Executive Briefing (or Deterministic Fallback)
    let aiBriefingText = null;
    try {
      const fleetResult = await this.fleetSynth.synthesizeFleet(recordsForFleet, 0.5);
      if (fleetResult) {
        aiBriefingText = this.formatter.formatFleetExecutiveBriefing(fleetResult);
      }
    } catch (aiErr) {
      logger.warn(`FleetAlertBatcher: AI fleet synthesis exception: ${aiErr?.message || aiErr}`);
    }

    // 7. Per-Vehicle Breakdown strictly from non-critical alerts
    const byPlate = {};
    for (const e of nonCriticalAlerts) {
      const plate = (e.fields?.plate || 'UNKNOWN').toUpperCase();
      const model = e.fields?.vehicleModel || '?';
      if (!byPlate[plate]) {
        byPlate[plate] = { plate, model, alerts: {} };
      }
      const type = e.alertDef?.type || 'unknown';
      if (!byPlate[plate].alerts[type]) {
        byPlate[plate].alerts[type] = {
          label: e.alertDef?.label || type,
          emoji: e.alertDef?.emoji || '⚠️',
          severity: e.alertDef?.severity || 'MEDIUM',
          count: 0,
        };
      }
      byPlate[plate].alerts[type].count++;
    }

    const vehicleLines = Object.values(byPlate)
      .sort((a, b) => {
        const totalA = Object.values(a.alerts).reduce((s, x) => s + x.count, 0);
        const totalB = Object.values(b.alerts).reduce((s, x) => s + x.count, 0);
        return totalB - totalA;
      })
      .map(v => {
        const alertTotal = Object.values(v.alerts).reduce((s, x) => s + x.count, 0);
        const alertList = Object.values(v.alerts)
          .sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0))
          .map(a => `    ${a.emoji} ${a.label} ×${a.count}`)
          .join('\n');
        return `🚗 *${v.plate}* — ${v.model} — ${alertTotal} alert(s)\n${alertList}`;
      })
      .join('\n\n');

    // 8. Assemble Consolidated Report
    const lines = [];
    lines.push(`📊 *FLEET ALERT SUMMARY*`);
    lines.push(`📅 ${dateLabel} | ${startHHMM}–${endHHMM}`);
    lines.push('─'.repeat(28));
    lines.push('');
    lines.push(`*Fleet Totals*`);
    lines.push(`🚗 Active vehicles: ${plates.length}`);
    lines.push(`📋 Total alerts:    ${nonCriticalAlerts.length}`);
    lines.push(`🛣️ Completed trips: ${completedTrips}`);
    lines.push(`⏱️ Total idle time: ${totalIdleMin} min`);
    lines.push('');
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

    lines.push('');
    lines.push('─'.repeat(28));
    lines.push('');
    lines.push(`*Per-Vehicle*`);
    lines.push('');
    lines.push(vehicleLines);
    lines.push('');
    lines.push('─'.repeat(28));
    lines.push(`_Next report in 30 minutes_`);

    return lines.join('\n');
  }
}

module.exports = FleetAlertBatcher;

/**
 * services/serverLifecycleManager.js
 *
 * Tracks server uptime, persistent heartbeats, graceful shutdowns,
 * and detects extended offline periods (>30 minutes) across restarts and power failures.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const LIFECYCLE_FILE = path.join(process.cwd(), 'data', 'server_lifecycle.json');
const DOWNTIME_THRESHOLD_MS = 30 * 60 * 1000; // Strictly > 30 minutes

class ServerLifecycleManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.stateFile]
   * @param {boolean} [options.persist=true]
   * @param {number} [options.heartbeatIntervalMs=30000]
   */
  constructor(options = {}) {
    this._persist = options.persist !== false;
    this._stateFile = options.stateFile || LIFECYCLE_FILE;
    this._heartbeatIntervalMs = options.heartbeatIntervalMs || 30_000;

    this.startupTime = null;
    this.offlineStart = null;
    this.downtimeDurationMs = 0;
    this._timer = null;

    this._state = {
      lastHeartbeatAt: null,
      lastShutdownAt: null,
      lastStartupAt: null,
      lastReportedDowntime: null,
    };

    this._loadState();
  }

  // ─── State Persistence ───────────────────────────────────────────────────

  _loadState() {
    if (!this._persist) return;
    try {
      if (fs.existsSync(this._stateFile)) {
        const raw = fs.readFileSync(this._stateFile, 'utf8');
        const data = JSON.parse(raw);
        this._state = {
          lastHeartbeatAt: data.lastHeartbeatAt || null,
          lastShutdownAt: data.lastShutdownAt || null,
          lastStartupAt: data.lastStartupAt || null,
          lastReportedDowntime: data.lastReportedDowntime || null,
        };
      }
    } catch (err) {
      logger.warn(`ServerLifecycleManager: could not read state from ${this._stateFile}: ${err.message}`);
    }
  }

  _saveState() {
    if (!this._persist) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`ServerLifecycleManager: could not save state to ${this._stateFile}: ${err.message}`);
    }
  }

  // ─── Lifecycle Initialization ─────────────────────────────────────────────

  /**
   * Initializes startup timestamp and computes downtime against previous session.
   * @param {Date|number} [now]
   * @returns {{ offlineStart: Date|null, startupTime: Date, durationMs: number, requiresDowntimeSummary: boolean }}
   */
  init(now = new Date()) {
    this.startupTime = now instanceof Date ? now : new Date(now);

    const prevMarker = this._state.lastShutdownAt || this._state.lastHeartbeatAt;
    if (prevMarker) {
      this.offlineStart = new Date(prevMarker);
      this.downtimeDurationMs = Math.max(0, this.startupTime.getTime() - this.offlineStart.getTime());
    } else {
      this.offlineStart = null;
      this.downtimeDurationMs = 0;
    }

    this._state.lastStartupAt = this.startupTime.toISOString();
    // Clear lastShutdownAt for the newly running session; update initial heartbeat
    this._state.lastShutdownAt = null;
    this._state.lastHeartbeatAt = this.startupTime.toISOString();
    this._saveState();

    const durationStr = this._fmtDur(this.downtimeDurationMs);
    const requiresSummary = this.isDowntimeSummaryRequired();

    if (this.offlineStart) {
      logger.info(
        `ServerLifecycleManager: previous session active until ${this.offlineStart.toISOString()} | ` +
        `startup: ${this.startupTime.toISOString()} | downtime: ${durationStr} | ` +
        `summary required: ${requiresSummary ? 'YES (>30m)' : 'NO (<=30m or already reported)'}`
      );
    } else {
      logger.info(`ServerLifecycleManager: first run / fresh lifecycle initialized at ${this.startupTime.toISOString()}`);
    }

    return {
      offlineStart: this.offlineStart,
      startupTime: this.startupTime,
      durationMs: this.downtimeDurationMs,
      requiresDowntimeSummary: requiresSummary,
    };
  }

  /**
   * Returns true if downtime was strictly > 30 minutes and has not already been reported.
   * @returns {boolean}
   */
  isDowntimeSummaryRequired() {
    if (!this.offlineStart || this.downtimeDurationMs <= DOWNTIME_THRESHOLD_MS) {
      return false;
    }

    // Check if this exact downtime interval was already reported
    const lastRep = this._state.lastReportedDowntime;
    if (lastRep && lastRep.offlineStart === this.offlineStart.toISOString()) {
      return false;
    }

    return true;
  }

  /**
   * Retrieves the current downtime interval descriptor.
   * @returns {{ offlineStart: Date|null, startupTime: Date, durationMs: number, durationStr: string }}
   */
  getDowntimeInterval() {
    return {
      offlineStart: this.offlineStart,
      startupTime: this.startupTime,
      durationMs: this.downtimeDurationMs,
      durationStr: this._fmtDur(this.downtimeDurationMs),
    };
  }

  /**
   * Marks the downtime interval as reported to prevent duplicate dispatches.
   * @param {Date} [offlineStart]
   * @param {Date} [startupTime]
   */
  markDowntimeReported(offlineStart = null, startupTime = null) {
    const start = offlineStart || this.offlineStart;
    const end = startupTime || this.startupTime;

    if (!start || !end) return;

    this._state.lastReportedDowntime = {
      offlineStart: start.toISOString(),
      startupTime: end.toISOString(),
      durationMs: end.getTime() - start.getTime(),
      reportedAt: new Date().toISOString(),
    };
    this._saveState();
    logger.success(`ServerLifecycleManager: marked downtime [${start.toISOString()} → ${end.toISOString()}] as reported`);
  }

  // ─── Heartbeat & Shutdown ─────────────────────────────────────────────────

  /**
   * Starts periodic heartbeat updating lastHeartbeatAt.
   * Ensures crash / power failure resilience without relying solely on graceful exit hooks.
   */
  startHeartbeat() {
    if (this._timer) return;

    this._timer = setInterval(() => {
      this._state.lastHeartbeatAt = new Date().toISOString();
      this._saveState();
    }, this._heartbeatIntervalMs);

    logger.debug(`ServerLifecycleManager: heartbeat started (every ${Math.round(this._heartbeatIntervalMs / 1000)}s)`);
  }

  /**
   * Records graceful shutdown timestamp.
   */
  recordShutdown() {
    this._state.lastShutdownAt = new Date().toISOString();
    this._state.lastHeartbeatAt = this._state.lastShutdownAt;
    this._saveState();
    logger.info(`ServerLifecycleManager: graceful shutdown recorded at ${this._state.lastShutdownAt}`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _fmtDur(ms) {
    if (!ms || ms <= 0) return '0m';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }
}

module.exports = ServerLifecycleManager;

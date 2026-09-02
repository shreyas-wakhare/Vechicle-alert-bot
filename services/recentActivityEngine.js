/**
 * services/recentActivityEngine.js
 *
 * Feature #1: Event Context Layer — Phase 2 (Recent Event Context / Activity Engine)
 *
 * Tracks vehicle-isolated recent activity across 5m, 15m, 30m, and 60m time windows.
 * Reuses HistoryStore for rehydration and single source of truth for ignition/trip state.
 * Performs lightweight O(recent) in-memory window queries without scanning historical datasets.
 */

class RecentActivityEngine {
  /**
   * @param {Object} [historyStore] - HistoryStore instance for rehydration & ignition state
   */
  constructor(historyStore = null) {
    this.historyStore = null;
    this.cache = new Map(); // vehicleKey -> Array<CompactEventSummary>
    this.MAX_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
    this.RETENTION_GRACE_MS = 15 * 60 * 1000; // 15 min grace window for out-of-order/late arrivals
    this.MAX_RETENTION_MS = this.MAX_WINDOW_MS + this.RETENTION_GRACE_MS; // 75 minutes

    if (historyStore) {
      this.setHistoryStore(historyStore);
    }
  }

  /**
   * Binds HistoryStore and rehydrates the in-memory recent event index.
   * @param {Object} historyStore
   */
  setHistoryStore(historyStore) {
    this.historyStore = historyStore;
    this.rehydrate();
  }

  /**
   * Rehydrates recent events from HistoryStore's persisted records.
   * Scans from the end of history backwards until reaching the 75-minute cutoff.
   * Runs ONCE at startup — O(recent) footprint.
   */
  rehydrate() {
    if (!this.historyStore || !Array.isArray(this.historyStore._records)) return;

    this.cache.clear();
    const records = this.historyStore._records;
    if (records.length === 0) return;

    // Determine recent cutoff based on the latest record in history or current time
    let latestMs = 0;
    const sampleLimit = Math.min(500, records.length);
    for (let i = records.length - 1; i >= records.length - sampleLimit; i--) {
      const ts = _parseTimestamp(records[i].receivedAt || records[i].loggedAt);
      if (ts > latestMs) latestMs = ts;
    }
    if (latestMs === 0) latestMs = Date.now();

    const cutoffMs = latestMs - this.MAX_RETENTION_MS;

    // Scan backwards from newest records until cutoff is reached
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      const eventMs = _parseTimestamp(rec.receivedAt || rec.loggedAt);
      if (eventMs < cutoffMs) break; // Records are chronological; early exit!

      const vehicleKey = this.deriveVehicleKey({
        imei: rec.imei,
        plate: rec.plate
      });

      if (!vehicleKey || vehicleKey === 'UNKNOWN') continue;

      const summary = {
        eventId: rec.id ? String(rec.id) : `EVT-${eventMs}`,
        alertType: rec.alertType || 'unknown',
        alertLabel: rec.alertLabel || 'Alert',
        severity: rec.severity || 'MEDIUM',
        timestamp: rec.receivedAt || rec.loggedAt || new Date(eventMs).toISOString(),
        source: rec.source || 'unknown',
        speed: rec.speed ? parseFloat(rec.speed) : null,
        address: rec.address || null
      };

      this._addSummaryToCache(vehicleKey, summary);
    }
  }

  /**
   * Derives a stable, normalized vehicle key: IMEI if available, otherwise normalized plate.
   * @param {Object} params
   * @param {string} [params.imei]
   * @param {string} [params.plate]
   * @returns {string} vehicleKey (e.g. 'IMEI:864201040123456' or 'PLATE:CC48315')
   */
  deriveVehicleKey({ imei, plate } = {}) {
    if (imei && String(imei).trim()) {
      return `IMEI:${String(imei).trim()}`;
    }
    if (plate && String(plate).trim()) {
      const norm = String(plate).toUpperCase().replace(/[\s\/\-]/g, '');
      if (norm) return `PLATE:${norm}`;
    }
    return 'UNKNOWN';
  }

  /**
   * Inserts an event summary into the vehicle's cache array, deduplicates, sorts descending, and evicts old events.
   * @private
   */
  _addSummaryToCache(vehicleKey, summary) {
    if (!vehicleKey || vehicleKey === 'UNKNOWN') return;

    if (!this.cache.has(vehicleKey)) {
      this.cache.set(vehicleKey, []);
    }
    const list = this.cache.get(vehicleKey);

    // Deduplicate by eventId
    const exists = list.some(item => item.eventId === summary.eventId);
    if (!exists) {
      list.push(summary);
      // Sort newest -> oldest by timestamp
      list.sort((a, b) => _parseTimestamp(b.timestamp) - _parseTimestamp(a.timestamp));
    }

    // Evict events older than MAX_RETENTION_MS relative to newest event in list
    if (list.length > 0) {
      const newestMs = _parseTimestamp(list[0].timestamp);
      const cutoff = newestMs - this.MAX_RETENTION_MS;
      const filtered = list.filter(item => _parseTimestamp(item.timestamp) >= cutoff);
      this.cache.set(vehicleKey, filtered);
    }
  }

  /**
   * Registers a newly processed EventContext into the recent activity cache.
   * @param {Object} context - Phase 1 EventContext
   */
  registerEvent(context) {
    if (!context || !context.vehicle) return;

    const vehicleKey = this.deriveVehicleKey({
      imei: context.vehicle.imei,
      plate: context.vehicle.plate
    });

    if (!vehicleKey || vehicleKey === 'UNKNOWN') return;

    const summary = {
      eventId: context.eventId,
      alertType: context.alertType,
      alertLabel: context.alertLabel,
      severity: context.severity,
      timestamp: context.timestamp,
      source: context.source,
      speed: context.telemetry?.speed || null,
      address: context.location?.address || null
    };

    this._addSummaryToCache(vehicleKey, summary);
  }

  /**
   * Builds the complete Phase 2 `recentActivity` object for an incoming EventContext.
   *
   * @param {Object} context - Phase 1 EventContext
   * @returns {Object} Structured recentActivity object
   */
  buildRecentActivity(context) {
    if (!context) return null;

    const vehicleKey = this.deriveVehicleKey({
      imei: context.vehicle?.imei,
      plate: context.vehicle?.plate
    });

    const currentEventSummary = {
      eventId: context.eventId,
      alertType: context.alertType,
      alertLabel: context.alertLabel,
      severity: context.severity,
      timestamp: context.timestamp,
      source: context.source,
      speed: context.telemetry?.speed || null,
      address: context.location?.address || null
    };

    // Ensure current event is in vehicle cache (deduplicated)
    if (vehicleKey !== 'UNKNOWN') {
      this._addSummaryToCache(vehicleKey, currentEventSummary);
    }

    const currentMs = _parseTimestamp(context.timestamp);
    const vehicleEvents = (vehicleKey !== 'UNKNOWN' && this.cache.has(vehicleKey))
      ? this.cache.get(vehicleKey)
      : [currentEventSummary];

    const windowMinutes = [5, 15, 30, 60];
    const windows = {};

    for (const mins of windowMinutes) {
      const cutoffMs = currentMs - mins * 60 * 1000;

      // Filter events occurring within [cutoffMs, currentMs] (with 5s clock tolerance)
      const inWindow = vehicleEvents.filter(e => {
        const t = _parseTimestamp(e.timestamp);
        return t >= cutoffMs && t <= currentMs + 5000;
      });

      const countsByAlertType = {};
      for (const e of inWindow) {
        countsByAlertType[e.alertType] = (countsByAlertType[e.alertType] || 0) + 1;
      }

      windows[`${mins}m`] = {
        totalEvents: inWindow.length,
        countsByAlertType,
        events: inWindow.map(e => ({ ...e }))
      };
    }

    const latestEvent = vehicleEvents.length > 0 ? { ...vehicleEvents[0] } : currentEventSummary;

    return {
      generatedAt: new Date().toISOString(),
      vehicleKey,
      windows,
      latestEvent,
      ignition: {
        state: context.trip?.ignitionState || 'UNKNOWN',
        active: context.trip?.active ?? false
      },
      trip: {
        active: context.trip?.active ?? false
      }
    };
  }
}

function _parseTimestamp(ts) {
  if (!ts) return Date.now();
  if (ts instanceof Date) return ts.getTime();
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

module.exports = RecentActivityEngine;

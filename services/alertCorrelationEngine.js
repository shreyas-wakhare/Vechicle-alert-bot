/**
 * services/alertCorrelationEngine.js
 *
 * Feature #2: Alert Correlation — Phase 1 (Correlation Foundation)
 *
 * Correlates multiple alerts belonging to the same vehicle into a structured,
 * JSON-safe correlation context object without modifying existing notification logic.
 *
 * Key Capabilities:
 * 1. Vehicle isolation (IMEI or normalized plate key)
 * 2. Time-window correlation (Default: 15 minutes, configurable)
 * 3. Chronological sorting by event timestamp (handles out-of-order arrival)
 * 4. Deduplication by eventId
 * 5. Stable correlation ID generation
 * 6. Non-blocking error isolation
 */

const logger = require('../utils/logger');
const IncidentGroupingEngine = require('./incidentGroupingEngine');

const DEFAULT_CORRELATION_WINDOW_MINUTES = 15;

class AlertCorrelationEngine {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowMinutes=15] - Correlation time window in minutes
   */
  constructor(options = {}) {
    this.windowMinutes = options.windowMinutes || DEFAULT_CORRELATION_WINDOW_MINUTES;
    this.windowMs = this.windowMinutes * 60 * 1000;
    this.incidentEngine = new IncidentGroupingEngine();

    // In-memory active correlations: vehicleKey -> CorrelationGroup
    this.correlations = new Map();
  }

  /**
   * Derives a stable, normalized vehicle key compatible with RecentActivityEngine.
   * @param {Object} params
   * @param {string} [params.imei]
   * @param {string} [params.plate]
   * @returns {string} vehicleKey
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
   * Correlates an incoming EventContext with recent events for the same vehicle.
   *
   * @param {Object} context - Phase 1 EventContext
   * @returns {Object} Structured alertCorrelation context object
   */
  correlate(context) {
    if (!context || typeof context !== 'object') {
      return this._buildEmptyCorrelation();
    }

    try {
      const vehicleKey = this.deriveVehicleKey({
        imei: context.vehicle?.imei,
        plate: context.vehicle?.plate,
      });

      const currentEventSummary = {
        eventId: context.eventId || `EVT-${Date.now()}`,
        alertType: context.alertType || 'unknown',
        alertLabel: context.alertLabel || 'Alert',
        severity: context.severity || 'MEDIUM',
        timestamp: context.timestamp || new Date().toISOString(),
        speed: context.telemetry?.speed ?? null,
        address: context.location?.address ?? null,
      };

      if (!vehicleKey || vehicleKey === 'UNKNOWN') {
        return this._buildSingleEventCorrelation('UNKNOWN', currentEventSummary, context.vehicle);
      }

      // Retrieve existing events from recentActivity window or internal cache
      let vehicleEvents = [];
      const windowKey = `${this.windowMinutes}m`;
      const wEvents = context.recentActivity?.windows?.[windowKey]?.events;

      if (Array.isArray(wEvents) && wEvents.length > 0) {
        vehicleEvents = wEvents.map(e => ({
          eventId: e.eventId,
          alertType: e.alertType,
          alertLabel: e.alertLabel || 'Alert',
          severity: e.severity || 'MEDIUM',
          timestamp: e.timestamp,
          speed: e.speed ?? null,
          address: e.address ?? null,
        }));
      }

      // Ensure current event is included exactly once (deduplicated by eventId)
      const exists = vehicleEvents.some(e => e.eventId === currentEventSummary.eventId);
      if (!exists) {
        vehicleEvents.push(currentEventSummary);
      }

      // Parse timestamps & derive time cutoff
      const currentMs = _parseTimestamp(currentEventSummary.timestamp);
      const cutoffMs = currentMs - this.windowMs;

      // Filter events strictly within [cutoffMs, currentMs + 5000ms grace]
      const eligibleEvents = vehicleEvents.filter(e => {
        const t = _parseTimestamp(e.timestamp);
        return t >= cutoffMs && t <= currentMs + 5000;
      });

      // Sort chronologically ascending (earliest to latest) for clean sequence representation
      eligibleEvents.sort((a, b) => _parseTimestamp(a.timestamp) - _parseTimestamp(b.timestamp));

      if (eligibleEvents.length <= 1) {
        const singleCorr = this._buildSingleEventCorrelation(vehicleKey, currentEventSummary, context.vehicle, context);
        this.correlations.set(vehicleKey, singleCorr);
        return singleCorr;
      }

      // Derive correlation metadata
      const earliestEvent = eligibleEvents[0];
      const latestEvent = eligibleEvents[eligibleEvents.length - 1];
      const startMs = _parseTimestamp(earliestEvent.timestamp);
      const latestMs = _parseTimestamp(latestEvent.timestamp);
      const durationMs = Math.max(0, latestMs - startMs);

      // Stable correlation ID: based on vehicleKey + earliest eventId
      const correlationId = `CORR-${vehicleKey}-${earliestEvent.eventId}`;

      const eventIds = eligibleEvents.map(e => e.eventId);
      const eventTypes = [...new Set(eligibleEvents.map(e => e.alertType))];

      const correlationResult = {
        correlationId,
        vehicleKey,
        vehicle: {
          plate: context.vehicle?.plate || null,
          model: context.vehicle?.model || null,
          imei: context.vehicle?.imei || null,
          driver: context.vehicle?.driver || null,
        },
        status: 'CORRELATED',
        isCorrelated: true,
        eventCount: eligibleEvents.length,
        eventIds,
        eventTypes,
        events: eligibleEvents.map(e => ({ ...e })),
        startTime: earliestEvent.timestamp,
        latestTime: latestEvent.timestamp,
        durationMs,
        windowMinutes: this.windowMinutes,
        generatedAt: new Date().toISOString(),
      };

      try {
        correlationResult.incident = this.incidentEngine.group(correlationResult, context);
      } catch (err) {
        logger.error(`IncidentGroupingEngine error: ${err?.message || err}`);
        correlationResult.incident = this._buildEmptyIncident();
      }

      this.correlations.set(vehicleKey, correlationResult);
      return correlationResult;

    } catch (err) {
      logger.error(`AlertCorrelationEngine error: ${err?.message || err}`);
      return this._buildEmptyCorrelation();
    }
  }

  _buildSingleEventCorrelation(vehicleKey, eventSummary, vehicle = null, context = null) {
    const ts = eventSummary?.timestamp || new Date().toISOString();
    const result = {
      correlationId: `CORR-SINGLE-${eventSummary?.eventId || 'EVT'}`,
      vehicleKey: vehicleKey || 'UNKNOWN',
      vehicle: vehicle ? {
        plate: vehicle.plate || null,
        model: vehicle.model || null,
        imei: vehicle.imei || null,
        driver: vehicle.driver || null,
      } : null,
      status: 'SINGLE_EVENT',
      isCorrelated: false,
      eventCount: 1,
      eventIds: eventSummary?.eventId ? [eventSummary.eventId] : [],
      eventTypes: eventSummary?.alertType ? [eventSummary.alertType] : [],
      events: eventSummary ? [{ ...eventSummary }] : [],
      startTime: ts,
      latestTime: ts,
      durationMs: 0,
      windowMinutes: this.windowMinutes,
      generatedAt: new Date().toISOString(),
    };

    try {
      result.incident = this.incidentEngine.group(result, context);
    } catch {
      result.incident = this._buildEmptyIncident();
    }
    return result;
  }

  _buildEmptyCorrelation() {
    return {
      correlationId: `CORR-EMPTY-${Date.now()}`,
      vehicleKey: 'UNKNOWN',
      vehicle: null,
      status: 'NONE',
      isCorrelated: false,
      eventCount: 0,
      eventIds: [],
      eventTypes: [],
      events: [],
      startTime: null,
      latestTime: null,
      durationMs: 0,
      windowMinutes: this.windowMinutes,
      generatedAt: new Date().toISOString(),
      incident: this._buildEmptyIncident(),
    };
  }

  _buildEmptyIncident() {
    return {
      type: 'NONE',
      label: 'None',
      isIncident: false,
      ruleId: 'NONE',
      matchedEvents: [],
      eventCount: 0,
      firstEventType: null,
      lastEventType: null,
      startTime: null,
      latestTime: null,
    };
  }
}

function _parseTimestamp(ts) {
  if (!ts) return Date.now();
  if (ts instanceof Date) return ts.getTime();
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

module.exports = AlertCorrelationEngine;

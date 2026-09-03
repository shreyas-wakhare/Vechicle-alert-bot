/**
 * services/incidentGroupingEngine.js
 *
 * Feature #2: Alert Correlation — Phase 2 (Correlation Rules & Incident Grouping)
 *
 * Consumes Feature #2 Phase 1 `alertCorrelation` outputs and evaluates them
 * against explicit, deterministic incident rules to produce a JSON-safe `incident` object.
 *
 * Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.
 */

const logger = require('../utils/logger');
const IncidentIntelligenceEngine = require('./incidentIntelligenceEngine');

const AGGRESSIVE_TYPES = new Set(['speeding', 'harsh_acceleration', 'harsh_braking', 'ubi_acceleration', 'ubi_deceleration']);
const DISTRACTION_TYPES = new Set(['distraction', 'vibration', 'lane_change', 'fatigue', 'drinking', 'seatbelt', 'smoking', 'voice_alarm']);

class IncidentGroupingEngine {
  constructor() {
    this.intelligenceEngine = new IncidentIntelligenceEngine();
  }

  /**
   * Classifies a correlation group into a meaningful incident pattern.
   *
   * @param {Object} correlationResult - Feature #2 Phase 1 correlation output
   * @returns {Object} JSON-safe incident classification object
   */
  group(correlationResult, context = null) {
    if (!correlationResult || typeof correlationResult !== 'object') {
      const emptyInc = this._buildEmptyIncident();
      emptyInc.intelligence = this.intelligenceEngine.analyze(emptyInc, correlationResult, context);
      return emptyInc;
    }

    try {
      const incident = this._classify(correlationResult);
      try {
        incident.intelligence = this.intelligenceEngine.analyze(incident, correlationResult, context);
      } catch (err) {
        logger.error(`IncidentIntelligenceEngine analyze error: ${err?.message || err}`);
        incident.intelligence = this.intelligenceEngine._buildEmptyIntelligence();
      }
      return incident;
    } catch (err) {
      logger.error(`IncidentGroupingEngine error: ${err?.message || err}`);
      const fallbackInc = this._buildEmptyIncident();
      fallbackInc.intelligence = this.intelligenceEngine.analyze(fallbackInc, correlationResult, context);
      return fallbackInc;
    }
  }

  _classify(correlationResult) {
      const events = Array.isArray(correlationResult.events) ? correlationResult.events : [];
      const eventTypes = Array.isArray(correlationResult.eventTypes) && correlationResult.eventTypes.length > 0
        ? correlationResult.eventTypes
        : [...new Set(events.map(e => e.alertType))];
      const typeSet = new Set(eventTypes);
      const isCorrelated = Boolean(correlationResult.isCorrelated || correlationResult.eventCount > 1 || events.length > 1);

      const startTime = correlationResult.startTime || new Date().toISOString();
      const latestTime = correlationResult.latestTime || new Date().toISOString();
      const firstEventType = events.length > 0 ? events[0].alertType : null;
      const lastEventType = events.length > 0 ? events[events.length - 1].alertType : null;

      // ── Standalone Inherent Incidents (single event or multi-event) ─────────
      if (typeSet.has('accident')) {
        return this._createIncident({
          type: 'ACCIDENT_EVENT',
          label: 'Collision / Accident Event',
          isIncident: true,
          ruleId: isCorrelated ? 'ACCIDENT_V1' : 'STANDALONE_ACCIDENT_V1',
          matchedEvents: ['accident'].concat(typeSet.has('sos') ? ['sos'] : []),
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      if (typeSet.has('engine_failure')) {
        return this._createIncident({
          type: 'ENGINE_FAILURE',
          label: 'Engine Failure / Overheat',
          isIncident: true,
          ruleId: isCorrelated ? 'ENGINE_FAILURE_V1' : 'STANDALONE_ENGINE_V1',
          matchedEvents: ['engine_failure'],
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      if (typeSet.has('sos')) {
        return this._createIncident({
          type: 'SOS_EMERGENCY',
          label: 'SOS Emergency Alert',
          isIncident: true,
          ruleId: isCorrelated ? 'SOS_CORRELATED_V1' : 'STANDALONE_SOS_V1',
          matchedEvents: ['sos'],
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      if (typeSet.has('tampering') && !typeSet.has('offline') && !typeSet.has('camera_blocked') && !typeSet.has('gps_lost')) {
        return this._createIncident({
          type: 'DEVICE_TAMPERING',
          label: 'Device Tampering',
          isIncident: true,
          ruleId: isCorrelated ? 'TAMPERING_CORRELATED_V1' : 'STANDALONE_TAMPERING_V1',
          matchedEvents: ['tampering'],
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // If single event and not a standalone incident, return SINGLE_EVENT representation
      if (!isCorrelated) {
        return {
          type: 'NONE',
          label: 'Single Event',
          isIncident: false,
          ruleId: 'SINGLE_EVENT_V1',
          matchedEvents: eventTypes,
          eventCount: 1,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        };
      }

      // ── Priority 3: Device Security Incident ─────────────────────────────
      if (typeSet.has('tampering') && (typeSet.has('offline') || typeSet.has('camera_blocked') || typeSet.has('gps_lost'))) {
        const matches = ['tampering'].concat(['offline', 'camera_blocked', 'gps_lost'].filter(t => typeSet.has(t)));
        return this._createIncident({
          type: 'DEVICE_SECURITY_INCIDENT',
          label: 'Device Security Incident',
          isIncident: true,
          ruleId: 'DEVICE_SECURITY_V1',
          matchedEvents: matches,
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      const allEventTypes = events.map(e => e.alertType);

      // ── Priority 4: Aggressive Driving ────────────────────────────────────
      const aggressiveMatches = allEventTypes.filter(t => AGGRESSIVE_TYPES.has(t));
      const uniqueAggressive = [...new Set(aggressiveMatches)];

      if (aggressiveMatches.length >= 2) {
        return this._createIncident({
          type: 'AGGRESSIVE_DRIVING',
          label: 'Aggressive Driving',
          isIncident: true,
          ruleId: 'AGGRESSIVE_DRIVING_V1',
          matchedEvents: uniqueAggressive,
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // ── Priority 5: Driver Distraction / Unsafe Driving ───────────────────
      const distractionMatches = allEventTypes.filter(t => DISTRACTION_TYPES.has(t));
      const uniqueDistraction = [...new Set(distractionMatches)];
      const hasPrimaryDistraction = uniqueDistraction.some(t => t !== 'vibration');

      if (distractionMatches.length >= 2 && hasPrimaryDistraction) {
        return this._createIncident({
          type: 'DRIVER_DISTRACTION_UNSAFE_DRIVING',
          label: 'Driver Distraction / Unsafe Driving',
          isIncident: true,
          ruleId: 'DRIVER_DISTRACTION_V1',
          matchedEvents: uniqueDistraction,
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // ── Priority 6: Connectivity Disruption ───────────────────────────────
      if ((typeSet.has('gps_lost') && typeSet.has('lte_jamming')) || (typeSet.has('lte_jamming') && typeSet.has('offline'))) {
        const matches = ['lte_jamming'].concat(['gps_lost', 'offline'].filter(t => typeSet.has(t)));
        return this._createIncident({
          type: 'CONNECTIVITY_DISRUPTION',
          label: 'Connectivity Disruption',
          isIncident: true,
          ruleId: 'CONNECTIVITY_DISRUPTION_V1',
          matchedEvents: matches,
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // ── Priority 7: GPS Interruption ──────────────────────────────────────
      if (typeSet.has('gps_lost') && typeSet.has('gps_restored')) {
        return this._createIncident({
          type: 'GPS_INTERRUPTION',
          label: 'GPS Interruption',
          isIncident: true,
          ruleId: 'GPS_INTERRUPTION_V1',
          matchedEvents: ['gps_lost', 'gps_restored'],
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // ── Priority 8: Pure Geofence Activity ──────────────────────────────────
      const nonGeofenceEvents = eventTypes.filter(t => t !== 'geofence_exit' && t !== 'geofence_enter' && t !== 'ignition_on' && t !== 'ignition_off');
      if ((typeSet.has('geofence_exit') || typeSet.has('geofence_enter')) && nonGeofenceEvents.length === 0) {
        const isExit = typeSet.has('geofence_exit');
        return this._createIncident({
          type: isExit ? 'GEOFENCE_EXIT_EVENT' : 'GEOFENCE_ENTRY_EVENT',
          label: isExit ? 'Geofence Exit' : 'Geofence Entry',
          isIncident: true,
          ruleId: 'GEOFENCE_EVENT_V1',
          matchedEvents: isExit ? ['geofence_exit'] : ['geofence_enter'],
          eventCount: correlationResult.eventCount,
          firstEventType,
          lastEventType,
          startTime,
          latestTime,
        });
      }

      // ── Priority 9: Generic Correlated Activity ────────────────────────────
      return {
        type: 'CORRELATED_ACTIVITY',
        label: 'Correlated Activity',
        isIncident: false,
        ruleId: 'CORRELATED_ACTIVITY_V1',
        matchedEvents: eventTypes,
        eventCount: correlationResult.eventCount,
        firstEventType,
        lastEventType,
        startTime,
        latestTime,
      };
  }

  _createIncident({ type, label, isIncident, ruleId, matchedEvents, eventCount, firstEventType, lastEventType, startTime, latestTime }) {
    return {
      type,
      label,
      isIncident: Boolean(isIncident),
      ruleId,
      matchedEvents: Array.isArray(matchedEvents) ? matchedEvents : [],
      eventCount: eventCount || 0,
      firstEventType: firstEventType || null,
      lastEventType: lastEventType || null,
      startTime: startTime || null,
      latestTime: latestTime || null,
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

module.exports = IncidentGroupingEngine;

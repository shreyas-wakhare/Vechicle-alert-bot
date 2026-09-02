/**
 * services/incidentLifecycleEngine.js
 *
 * Feature #2: Alert Correlation — Phase 3.2 (Continuation, Escalation & Incident Lifecycle)
 *
 * Evaluates incident streams for:
 * 1. Incident Continuation & Merging (active vehicle stream tracking)
 * 2. Escalation Detection (deterministic severity and pattern upgrades)
 * 3. Explicit Recovery Resolution (gps_restored, lte_restored, ignition_off)
 *
 * Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.
 */

const logger = require('../utils/logger');

const SEVERITY_WEIGHT = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const RECOVERY_MAP = {
  gps_restored: ['gps_lost', 'GPS_INTERRUPTION', 'CONNECTIVITY_DISRUPTION'],
  lte_restored: ['lte_jamming', 'CONNECTIVITY_DISRUPTION'],
  ignition_off: ['ignition_on', 'speeding', 'harsh_acceleration', 'harsh_braking', 'idle'],
};

class IncidentLifecycleEngine {
  /**
   * Evaluates continuation, escalation, and explicit resolution for an incident.
   *
   * @param {Object} incident - Feature #2 Phase 2 incident object
   * @param {Object} correlationResult - Feature #2 Phase 1 correlation object
   * @returns {Object} Deterministic lifecycle evaluation object
   */
  evaluate(incident, correlationResult) {
    if (!incident || typeof incident !== 'object') {
      return this._buildDefaultLifecycle();
    }

    try {
      const events = (correlationResult && Array.isArray(correlationResult.events))
        ? correlationResult.events
        : [];
      
      const eventTypes = (correlationResult && Array.isArray(correlationResult.eventTypes) && correlationResult.eventTypes.length > 0)
        ? correlationResult.eventTypes
        : (events.length > 0 ? events.map(e => e.alertType) : (incident.matchedEvents || []));

      const typeSet = new Set(eventTypes);
      const isCorrelated = Boolean(correlationResult && correlationResult.isCorrelated && ((correlationResult.eventCount && correlationResult.eventCount > 1) || events.length > 1));

      // ── 1. Continuation & Merging ─────────────────────────────────────────
      const continuation = {
        isContinuation: isCorrelated,
        previousIncidentId: isCorrelated ? (correlationResult.correlationId || null) : null,
        mergedEventCount: correlationResult?.eventCount || (events.length > 0 ? events.length : 1),
      };

      // ── 2. Escalation Detection ───────────────────────────────────────────
      const escalation = this._detectEscalation(incident, events, typeSet);

      // ── 3. Explicit Recovery Resolution ──────────────────────────────────
      const { status, resolutionReason } = this._evaluateResolution(incident, events, typeSet, isCorrelated);

      return {
        status,
        resolutionReason,
        continuation,
        escalation,
      };

    } catch (err) {
      logger.error(`IncidentLifecycleEngine error: ${err?.message || err}`);
      return this._buildDefaultLifecycle();
    }
  }

  /**
   * Detects deterministic severity or pattern escalations in the event stream.
   * @private
   */
  _detectEscalation(incident, events, typeSet) {
    let detected = false;
    let previousIncidentType = null;
    let reason = null;

    if (!events || events.length <= 1) {
      return { detected: false, previousIncidentType: null, reason: null };
    }

    // A. Pattern Escalation (e.g. speeding/driving -> accident)
    if (typeSet.has('accident') && (typeSet.has('speeding') || typeSet.has('harsh_acceleration') || typeSet.has('harsh_braking') || typeSet.has('distraction'))) {
      detected = true;
      previousIncidentType = typeSet.has('distraction') ? 'DRIVER_DISTRACTION_UNSAFE_DRIVING' : 'AGGRESSIVE_DRIVING';
      reason = `Escalated to ACCIDENT_EVENT from ${previousIncidentType} due to critical collision alert.`;
      return { detected, previousIncidentType, reason };
    }

    if (typeSet.has('tampering') && (typeSet.has('offline') || typeSet.has('camera_blocked') || typeSet.has('gps_lost'))) {
      if (events[0].alertType !== 'tampering') {
        detected = true;
        previousIncidentType = 'CONNECTIVITY_DISRUPTION';
        reason = `Escalated to DEVICE_SECURITY_INCIDENT from CONNECTIVITY_DISRUPTION due to tampering alert.`;
        return { detected, previousIncidentType, reason };
      }
    }

    // B. Severity Escalation (e.g. LOW -> HIGH -> CRITICAL)
    let maxPreviousWeight = 0;
    let firstLowerType = null;

    for (let i = 0; i < events.length - 1; i++) {
      const w = SEVERITY_WEIGHT[events[i].severity] || 2;
      if (w > maxPreviousWeight) {
        maxPreviousWeight = w;
        firstLowerType = events[i].alertType;
      }
    }

    const latestEvent = events[events.length - 1];
    const latestWeight = SEVERITY_WEIGHT[latestEvent.severity] || 2;

    if (latestWeight > maxPreviousWeight && maxPreviousWeight > 0 && events.length > 1) {
      // Ensure it's not a duplicate processing of the same event
      const prevEvents = events.slice(0, -1);
      const isDuplicate = prevEvents.some(e => e.eventId === latestEvent.eventId);
      
      if (!isDuplicate) {
        detected = true;
        previousIncidentType = firstLowerType;
        reason = `Severity escalated from ${events[0].severity || 'LOW'} (${firstLowerType}) to ${latestEvent.severity} (${latestEvent.alertType}).`;
      }
    }

    return { detected, previousIncidentType, reason };
  }

  /**
   * Evaluates explicit recovery alerts to determine if incident is RESOLVED.
   * @private
   */
  _evaluateResolution(incident, events, typeSet, isCorrelated) {
    // 1. Connectivity recovery alerts (gps_restored, lte_restored)
    if (typeSet.has('gps_restored')) {
      return {
        status: 'RESOLVED',
        resolutionReason: 'Explicit recovery alert received: GPS signal restored (gps_restored).',
      };
    }

    if (typeSet.has('lte_restored')) {
      return {
        status: 'RESOLVED',
        resolutionReason: 'Explicit recovery alert received: LTE signal restored (lte_restored).',
      };
    }

    // 2. Ignition OFF recovery alert (scopes ONLY to driving/trip pattern incidents)
    const NonResolvableEmergencyTypes = new Set(['ACCIDENT_EVENT', 'DEVICE_SECURITY_INCIDENT', 'DEVICE_TAMPERING', 'SOS_EMERGENCY']);
    
    if (typeSet.has('ignition_off') && events.length > 1 && !NonResolvableEmergencyTypes.has(incident.type)) {
      const lastEvent = events[events.length - 1];
      if (lastEvent.alertType === 'ignition_off') {
        return {
          status: 'RESOLVED',
          resolutionReason: 'Explicit recovery alert received: Driving session ended (ignition_off).',
        };
      }
    }

    // Default status: ACTIVE for multi-event correlations, DETECTED for single events
    const status = isCorrelated ? 'ACTIVE' : 'DETECTED';
    return { status, resolutionReason: null };
  }

  _buildDefaultLifecycle() {
    return {
      status: 'NONE',
      resolutionReason: null,
      continuation: {
        isContinuation: false,
        previousIncidentId: null,
        mergedEventCount: 0,
      },
      escalation: {
        detected: false,
        previousIncidentType: null,
        reason: null,
      },
    };
  }
}

module.exports = IncidentLifecycleEngine;

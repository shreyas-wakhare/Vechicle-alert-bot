/**
 * services/incidentInterpretationEngine.js
 *
 * Feature #2: Alert Correlation — Phase 3.3 (Operational Interpretation & Incident Narrative Intelligence)
 *
 * Generates deterministic, human-readable operational interpretations for fleet operators:
 * - whatHappened (factual description using vehicle context where available)
 * - progression (chronological sequence or escalation path)
 * - whyItMatters (operational significance based on incident type and status)
 * - recommendedAttention (IMMEDIATE_ATTENTION, HIGH_ATTENTION, ROUTINE_ATTENTION)
 * - operationalCategory (DRIVER_BEHAVIOR, SAFETY_INCIDENT, DEVICE_SECURITY, etc.)
 * - narrative (cohesive summary text)
 *
 * Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.
 */

const logger = require('../utils/logger');

const CATEGORY_MAP = {
  // Pattern Incident Types
  AGGRESSIVE_DRIVING: 'DRIVER_BEHAVIOR',
  DRIVER_DISTRACTION_UNSAFE_DRIVING: 'DRIVER_BEHAVIOR',
  ACCIDENT_EVENT: 'SAFETY_INCIDENT',
  SOS_EMERGENCY: 'SAFETY_INCIDENT',
  DEVICE_SECURITY_INCIDENT: 'DEVICE_SECURITY',
  DEVICE_TAMPERING: 'DEVICE_SECURITY',
  CONNECTIVITY_DISRUPTION: 'CONNECTIVITY',
  GPS_INTERRUPTION: 'CONNECTIVITY',
  ENGINE_FAILURE: 'VEHICLE_OPERATION',
  GEOFENCE_EXIT_EVENT: 'GEOLOCATION',
  GEOFENCE_ENTRY_EVENT: 'GEOLOCATION',
  CORRELATED_ACTIVITY: 'CORRELATED_ACTIVITY',

  // All 32 System Single Alert Types
  speeding: 'DRIVER_BEHAVIOR',
  harsh_acceleration: 'DRIVER_BEHAVIOR',
  harsh_braking: 'DRIVER_BEHAVIOR',
  distraction: 'DRIVER_BEHAVIOR',
  vibration: 'DRIVER_BEHAVIOR',
  fatigue: 'DRIVER_BEHAVIOR',
  smoking: 'DRIVER_BEHAVIOR',
  seatbelt: 'DRIVER_BEHAVIOR',
  drinking: 'DRIVER_BEHAVIOR',
  lane_change: 'DRIVER_BEHAVIOR',
  ubi_acceleration: 'DRIVER_BEHAVIOR',
  ubi_deceleration: 'DRIVER_BEHAVIOR',
  driver_change: 'DRIVER_BEHAVIOR',
  idle: 'DRIVER_BEHAVIOR',
  voice_alarm: 'DRIVER_BEHAVIOR',
  accident: 'SAFETY_INCIDENT',
  sos: 'SAFETY_INCIDENT',
  tampering: 'DEVICE_SECURITY',
  camera_blocked: 'DEVICE_SECURITY',
  low_battery: 'DEVICE_SECURITY',
  gps_lost: 'CONNECTIVITY',
  lte_jamming: 'CONNECTIVITY',
  offline: 'CONNECTIVITY',
  gps_restored: 'CONNECTIVITY',
  lte_restored: 'CONNECTIVITY',
  engine_failure: 'VEHICLE_OPERATION',
  fuel_drop: 'VEHICLE_OPERATION',
  ignition_on: 'VEHICLE_OPERATION',
  ignition_off: 'VEHICLE_OPERATION',
  geofence_exit: 'GEOLOCATION',
  geofence_enter: 'GEOLOCATION',
  unknown: 'UNKNOWN',
};

class IncidentInterpretationEngine {
  /**
   * Generates deterministic operational interpretation and narrative.
   *
   * @param {Object} incident - Feature #2 Phase 2 incident object
   * @param {Object} correlationResult - Feature #2 Phase 1 correlation object
   * @param {Object} intelligence - Feature #2 Phase 3.1 & 3.2 intelligence object
   * @param {Object} [context] - Optional EventContext for vehicle speed/location fields
   * @returns {Object} Deterministic operational interpretation object
   */
  interpret(incident, correlationResult, intelligence, context = null) {
    if (!incident || typeof incident !== 'object') {
      return this._buildDefaultInterpretation();
    }

    try {
      const type = incident.type || 'NONE';
      const intel = intelligence || {};
      const seq = Array.isArray(intel.sequence) ? intel.sequence : [];
      const initEvent = intel.initiatingEvent || seq[0] || 'alert';
      let label = incident.label || type;
      if ((type === 'NONE' || label === 'Single Event' || label === 'None') && context?.alertLabel) {
        label = context.alertLabel;
      }
      const status = intel.status || 'DETECTED';
      const isEscalated = Boolean(intel.escalation?.detected);
      const isResolved = status === 'RESOLVED';

      // 1. Operational Category (try incident.type first, then initEvent, then UNKNOWN)
      const operationalCategory = CATEGORY_MAP[type] || CATEGORY_MAP[initEvent] || 'UNKNOWN';

      // 2. Recommended Attention
      const recommendedAttention = this._deriveAttention(incident, isEscalated, isResolved, intel, context, correlationResult);

      // 3. What Happened
      const whatHappened = this._deriveWhatHappened(incident, correlationResult, intel, context, initEvent, seq);

      // 4. Progression
      const progression = this._deriveProgression(intel, seq, isEscalated);

      // 5. Why It Matters
      const whyItMatters = this._deriveWhyItMatters(incident, status, isResolved, intel);

      const isIncident = Boolean(incident.isIncident || seq.length > 1);
      const meaningSuffix = isIncident ? 'incident' : 'alert';

      // 6. Narrative
      const narrative = this._generateNarrative(label, whatHappened, progression, whyItMatters, status, intel, isIncident);

      return {
        operationalMeaning: `${label} ${meaningSuffix} (${status}).`,
        whatHappened,
        progression,
        whyItMatters,
        recommendedAttention,
        operationalCategory,
        narrative,
      };

    } catch (err) {
      logger.error(`IncidentInterpretationEngine error: ${err?.message || err}`);
      return this._buildDefaultInterpretation();
    }
  }

  _deriveAttention(incident, isEscalated, isResolved, intel, context, correlationResult) {
    if (isResolved) return 'ROUTINE_ATTENTION';

    const severity = context?.severity || correlationResult?.events?.[0]?.severity || 'MEDIUM';
    if (severity === 'CRITICAL') {
      return 'IMMEDIATE_ATTENTION';
    }

    const type = incident.type;
    if (type === 'ACCIDENT_EVENT' || type === 'SOS_EMERGENCY' || type === 'DEVICE_SECURITY_INCIDENT') {
      return 'IMMEDIATE_ATTENTION';
    }

    if (isEscalated || type === 'AGGRESSIVE_DRIVING' || type === 'DRIVER_DISTRACTION_UNSAFE_DRIVING' || type === 'DEVICE_TAMPERING' || type === 'ENGINE_FAILURE' || type === 'CONNECTIVITY_DISRUPTION') {
      return 'HIGH_ATTENTION';
    }

    return 'ROUTINE_ATTENTION';
  }

  _deriveWhatHappened(incident, correlationResult, intel, context, initEvent, seq) {
    const count = seq.length || correlationResult?.eventCount || 1;

    // Locate the chronological initiating event summary matching initEvent
    const initEvtObj = (correlationResult?.events && Array.isArray(correlationResult.events))
      ? correlationResult.events.find(e => e.alertType === initEvent) || correlationResult.events[0]
      : null;

    // Speed details if available from context telemetry or initiating event payload
    let speedInfo = '';
    const speedVal = context?.telemetry?.speed ?? initEvtObj?.speed ?? (typeof context?.speed === 'number' ? context.speed : null);
    const limitVal = context?.telemetry?.speedLimit ?? initEvtObj?.speedLimit ?? (typeof context?.speedLimit === 'number' ? context.speedLimit : null);

    if (speedVal != null) {
      if (limitVal != null) {
        speedInfo = ` at ${speedVal} km/h (limit: ${limitVal} km/h)`;
      } else {
        speedInfo = ` at ${speedVal} km/h`;
      }
    }

    if (count <= 1) {
      return `Single ${initEvent} alert detected${speedInfo}.`;
    }

    return `${count} correlated alerts initiated by ${initEvent}${speedInfo}.`;
  }

  _deriveProgression(intel, seq, isEscalated) {
    if (isEscalated && intel.escalation?.previousIncidentType) {
      const prev = intel.escalation.previousIncidentType;
      const reason = intel.escalation.reason ? ` (${intel.escalation.reason})` : '';
      return `Escalated from ${prev}. Sequence: ${seq.join(' → ')}${reason}.`;
    }

    if (seq.length > 1) {
      return `Sequence: ${seq.join(' → ')}.`;
    }

    return 'Single alert event.';
  }

  _deriveWhyItMatters(incident, status, isResolved, intel) {
    if (isResolved) {
      return intel.lifecycle?.resolutionReason || 'Incident has been resolved by an explicit recovery event.';
    }

    const type = incident.type;
    switch (type) {
      case 'ACCIDENT_EVENT':
        return 'Critical collision alert requires immediate driver/fleet safety response.';
      case 'SOS_EMERGENCY':
        return 'Driver emergency SOS triggered; immediate contact required.';
      case 'DEVICE_SECURITY_INCIDENT':
      case 'DEVICE_TAMPERING':
        return 'Hardware tampering or security disruption requires immediate technical inspection.';
      case 'AGGRESSIVE_DRIVING':
        return 'Sustained aggressive driving increases vehicle collision risk.';
      case 'DRIVER_DISTRACTION_UNSAFE_DRIVING':
        return 'Driver distraction alert pattern requires safety check.';
      case 'CONNECTIVITY_DISRUPTION':
      case 'GPS_INTERRUPTION':
        return 'Connectivity disruption affects real-time vehicle tracking.';
      case 'ENGINE_FAILURE':
        return 'Engine malfunction alert requires vehicle maintenance check.';
      case 'CORRELATED_ACTIVITY':
        return 'Multiple alerts recorded within correlation window; no single safety rule triggered.';
      default:
        return 'Alert pattern requires routine fleet monitoring.';
    }
  }

  _generateNarrative(label, whatHappened, progression, whyItMatters, status, intel, isIncident = true) {
    const dur = intel.lifecycle?.durationSeconds;
    const durText = dur > 0 ? ` Duration: ${dur}s.` : '';
    const statusText = ` Status: ${status}.`;
    const heading = isIncident ? `${label} pattern detected.` : `${label} alert detected.`;

    return `${heading} ${whatHappened} ${progression} ${whyItMatters}${durText}${statusText}`.replace(/\s+/g, ' ').trim();
  }

  _buildDefaultInterpretation() {
    return {
      operationalMeaning: 'No interpretation available.',
      whatHappened: 'No alerts observed.',
      progression: 'Single alert event.',
      whyItMatters: 'Alert pattern requires routine fleet monitoring.',
      recommendedAttention: 'ROUTINE_ATTENTION',
      operationalCategory: 'UNKNOWN',
      narrative: 'No incident activity detected.',
    };
  }
}

module.exports = IncidentInterpretationEngine;

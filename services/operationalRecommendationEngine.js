/**
 * services/operationalRecommendationEngine.js
 *
 * Feature #3: Dynamic Vehicle/Driver Risk — Phase 3 (Operational Recommendations & Manager Action Directives)
 *
 * Provides a deterministic, explainable operational recommendation layer on top of
 * Feature #3 Phase 1 (RiskEngine), Feature #3 Phase 2 (RiskTrendEngine), and Feature #2 (Alert Correlation).
 *
 * Key Capabilities:
 * 1. Operational Meaning Translation (translates technical risk signals into fleet management context).
 * 2. Actionable Manager Directives (provides specific, deterministic operational action steps).
 * 3. Deterministic Urgency Mapping (IMMEDIATE_ACTION, HIGH_PRIORITY, FOLLOW_UP, MONITOR, NO_ACTION).
 * 4. Action Category Classification (DRIVER_COACHING_REQUIRED, SAFETY_REVIEW_REQUIRED, VEHICLE_INSPECTION_REQUIRED, etc.).
 * 5. Strict Vehicle vs Driver Domain Separation (preserves Phase 1/2 entity scoping).
 * 6. Feature #2 & Feature #3 Phase 1/2 Intelligence Integration.
 * 7. Safe 32-Alert Taxonomy Handling with deterministic fallbacks.
 *
 * Strictly NO AI/LLM, NO Machine Learning, NO Risk Prediction in Phase 3.
 */

'use strict';

const logger     = require('../utils/logger');
const alertTypes = require('../data/alertTypes.json');

const SEVERITY_MAP = new Map(alertTypes.map(a => [a.type, a.severity || 'MEDIUM']));

// ── Action Category Mapping ──────────────────────────────────────────────────
const CATEGORY_MAP = {
  speeding:            'DRIVER_COACHING_REQUIRED',
  harsh_acceleration:  'DRIVER_COACHING_REQUIRED',
  harsh_braking:       'DRIVER_COACHING_REQUIRED',
  distraction:         'DRIVER_COACHING_REQUIRED',
  vibration:           'DRIVER_COACHING_REQUIRED',
  fatigue:             'IMMEDIATE_DRIVER_CONTACT',
  smoking:             'DRIVER_COACHING_REQUIRED',
  seatbelt:            'DRIVER_COACHING_REQUIRED',
  drinking:            'IMMEDIATE_DRIVER_CONTACT',
  lane_change:         'DRIVER_COACHING_REQUIRED',
  ubi_acceleration:    'DRIVER_COACHING_REQUIRED',
  ubi_deceleration:    'DRIVER_COACHING_REQUIRED',
  driver_change:       'DRIVER_COACHING_REQUIRED',
  idle:                'DRIVER_COACHING_REQUIRED',
  voice_alarm:         'DRIVER_COACHING_REQUIRED',

  accident:            'SAFETY_REVIEW_REQUIRED',
  sos:                 'IMMEDIATE_DRIVER_CONTACT',

  tampering:           'SECURITY_REVIEW_REQUIRED',
  camera_blocked:      'SECURITY_REVIEW_REQUIRED',
  low_battery:         'VEHICLE_INSPECTION_REQUIRED',

  gps_lost:            'CONNECTIVITY_CHECK_REQUIRED',
  lte_jamming:         'CONNECTIVITY_CHECK_REQUIRED',
  offline:             'CONNECTIVITY_CHECK_REQUIRED',
  gps_restored:        'MONITOR_ONLY',
  lte_restored:        'MONITOR_ONLY',

  engine_failure:      'VEHICLE_INSPECTION_REQUIRED',
  fuel_drop:           'FUEL_INVESTIGATION_REQUIRED',
  ignition_on:         'MONITOR_ONLY',
  ignition_off:        'MONITOR_ONLY',

  geofence_exit:       'ROUTE_REVIEW_REQUIRED',
  geofence_enter:      'MONITOR_ONLY',

  unknown:             'MONITOR_ONLY',
};

class OperationalRecommendationEngine {
  /**
   * Generates deterministic operational recommendations and manager action directives.
   *
   * @note Decision fields (urgency, category, operationalMeaning, directive) are 100% deterministic functions of context inputs; generatedAt is runtime metadata.
   * @param {Object} context - Feature #1 EventContext object containing risk, riskTrend, & alertCorrelation
   * @returns {Object} Structured riskRecommendation object
   */
  generate(context) {
    if (!context || typeof context !== 'object') {
      return this._buildDefaultRecommendationResult();
    }

    try {
      const risk = context.risk || {};
      const riskTrend = context.riskTrend || {};

      const vehicleRisk = risk.vehicleRisk || null;
      const vehicleTrend = riskTrend.vehicle || null;

      const driverRisk = risk.driverRisk || null;
      const driverTrend = riskTrend.driver || null;

      const vehicleRec = vehicleRisk
        ? this._generateEntityRecommendation('vehicle', vehicleRisk, vehicleTrend, context)
        : this._buildDefaultEntityRecommendation('vehicle', context);

      const driverRec = driverRisk
        ? this._generateEntityRecommendation('driver', driverRisk, driverTrend, context)
        : null;

      return {
        generatedAt: new Date().toISOString(),
        vehicle: vehicleRec,
        driver: driverRec,
      };

    } catch (err) {
      logger.error(`OperationalRecommendationEngine error: ${err?.message || err}`);
      return this._buildDefaultRecommendationResult();
    }
  }

  /**
   * Generates recommendation for a single entity (vehicle or driver).
   * @private
   */
  _generateEntityRecommendation(entityType, entityRisk, entityTrend, context) {
    const entityKey = entityRisk.entityKey || 'UNKNOWN';
    const riskLevel = entityRisk.level || 'LOW';
    const trend = entityTrend?.trend || 'STABLE';
    const alertType = context.alertType || 'unknown';
    const alertLabel = context.alertLabel || alertType || 'Alert';
    const severity = context.severity || SEVERITY_MAP.get(alertType) || 'MEDIUM';

    const corr = context.alertCorrelation || {};
    const inc = corr.incident || {};
    const intel = inc.intelligence || {};
    const isEscalated = Boolean(intel.escalation?.detected);

    // 1. Urgency Mapping
    const urgency = this._deriveUrgency(riskLevel, trend, alertType, severity, isEscalated, entityTrend);

    // 2. Action Category Mapping (Domain Aware)
    const category = this._deriveCategory(alertType, entityType, riskLevel);

    // 3. Operational Meaning Logic
    const operationalMeaning = this._deriveOperationalMeaning(alertType, alertLabel, entityType, riskLevel, trend, inc, entityTrend);

    // 4. Directive Logic (Alert-Specific)
    const directive = this._deriveDirective(alertType, alertLabel, urgency, category, entityType);

    return {
      entityKey,
      riskLevel,
      trend,
      operationalMeaning,
      recommendedAction: {
        urgency,
        directive,
        category,
      },
    };
  }

  /**
   * Derives urgency level based on risk, trend, alert type, and escalations.
   * @private
   */
  _deriveUrgency(riskLevel, trend, alertType, severity, isEscalated, entityTrend) {
    if (riskLevel === 'CRITICAL' || alertType === 'accident' || alertType === 'sos' || alertType === 'engine_failure' || isEscalated) {
      return 'IMMEDIATE_ACTION';
    }

    if ((riskLevel === 'HIGH' && trend === 'RISING') || alertType === 'drinking' || alertType === 'fatigue') {
      return 'IMMEDIATE_ACTION';
    }

    if (riskLevel === 'HIGH' || alertType === 'tampering' || alertType === 'camera_blocked' || alertType === 'fuel_drop') {
      return 'HIGH_PRIORITY';
    }

    const hasRepeatedUnsafe = Boolean(entityTrend?.repeatedBehaviors?.some(r => r.repeated));
    if (hasRepeatedUnsafe && (riskLevel === 'ELEVATED' || riskLevel === 'MEDIUM')) {
      return 'HIGH_PRIORITY';
    }

    if (riskLevel === 'ELEVATED' || riskLevel === 'MEDIUM' || alertType === 'gps_lost' || alertType === 'lte_jamming' || alertType === 'offline' || alertType === 'geofence_exit') {
      return 'FOLLOW_UP';
    }

    if (alertType === 'gps_restored' || alertType === 'lte_restored' || alertType === 'ignition_on' || alertType === 'ignition_off' || alertType === 'geofence_enter') {
      return 'MONITOR';
    }

    if (riskLevel === 'LOW' && trend === 'STABLE') {
      return 'NO_ACTION';
    }

    return 'MONITOR';
  }

  /**
   * Derives category mapping based on alert type, entity type, and risk level.
   * @private
   */
  _deriveCategory(alertType, entityType, riskLevel) {
    // Domain safety: Vehicle-only alerts do NOT assign driver coaching categories to driver entity
    const vehicleOnlyTypes = new Set([
      'tampering', 'camera_blocked', 'low_battery', 'engine_failure',
      'gps_lost', 'lte_jamming', 'offline', 'fuel_drop', 'geofence_exit',
      'geofence_enter', 'ignition_on', 'ignition_off', 'gps_restored', 'lte_restored', 'idle'
    ]);

    if (entityType === 'driver' && vehicleOnlyTypes.has(alertType)) {
      return 'MONITOR_ONLY';
    }

    if (riskLevel === 'LOW' && (alertType === 'ignition_on' || alertType === 'ignition_off' || alertType === 'geofence_enter')) {
      return 'NO_ACTION_REQUIRED';
    }

    return CATEGORY_MAP[alertType] || 'MONITOR_ONLY';
  }

  /**
   * Derives operational meaning for fleet managers.
   * @private
   */
  _deriveOperationalMeaning(alertType, alertLabel, entityType, riskLevel, trend, incident, entityTrend) {
    const repeated = entityTrend?.repeatedBehaviors?.find(r => r.alertType === alertType && r.repeated);
    const repText = repeated ? `Repeated ${alertLabel.toLowerCase()} alerts (${repeated.count}x)` : `${alertLabel}`;

    switch (alertType) {
      case 'speeding':
        return `${repText} exceed speed limit, increasing collision risk and vehicle wear.`;
      case 'harsh_braking':
      case 'harsh_acceleration':
      case 'ubi_acceleration':
      case 'ubi_deceleration':
        return `${repText} indicate aggressive driving behavior and elevated collision exposure.`;
      case 'distraction':
        return `${repText} indicate driver inattention, posing safety exposure.`;
      case 'fatigue':
        return `Fatigue detection indicates driver exhaustion; immediate rest required.`;
      case 'drinking':
        return `Drinking alert triggered; critical impairment risk to driver and vehicle.`;
      case 'accident':
        return `Collision alert detected; critical emergency response required.`;
      case 'sos':
        return `SOS panic alert triggered by driver; immediate emergency assistance required.`;
      case 'tampering':
      case 'camera_blocked':
        return `Hardware security disruption detected; monitoring integrity compromised.`;
      case 'engine_failure':
        return `Engine malfunction alert detected; vehicle mechanical failure risk.`;
      case 'fuel_drop':
        return `Rapid fuel drop detected; potential fuel leakage or theft anomaly.`;
      case 'gps_lost':
      case 'lte_jamming':
      case 'offline':
        return `Signal disruption detected; vehicle tracking visibility temporarily reduced.`;
      case 'gps_restored':
      case 'lte_restored':
        return `Signal restored; vehicle tracking visibility re-established.`;
      case 'geofence_exit':
        return `Geofence boundary departure; vehicle outside designated zone.`;
      default:
        return `${repText} observed during operation (Risk Level: ${riskLevel}, Trend: ${trend}).`;
    }
  }

  /**
   * Derives actionable, alert-specific manager directive string.
   * @private
   */
  _deriveDirective(alertType, alertLabel, urgency, category, entityType) {
    switch (category) {
      case 'DRIVER_COACHING_REQUIRED':
        if (alertType === 'speeding') {
          return `Contact driver to enforce speed limits and schedule speed coaching session.`;
        }
        if (alertType === 'harsh_braking' || alertType === 'harsh_acceleration' || alertType === 'ubi_acceleration' || alertType === 'ubi_deceleration' || alertType === 'lane_change') {
          return `Contact driver to review vehicle handling and enforce smooth driving standards.`;
        }
        if (alertType === 'distraction') {
          return `Contact driver to review cabin distraction policy and enforce focus on the road.`;
        }
        if (alertType === 'seatbelt') {
          return `Contact driver to enforce mandatory seatbelt usage policy for all occupants.`;
        }
        if (alertType === 'smoking') {
          return `Contact driver to enforce cabin anti-smoking policy.`;
        }
        if (alertType === 'vibration' || alertType === 'voice_alarm') {
          return `Contact driver to review cabin alarm triggers and rough vehicle handling.`;
        }
        if (alertType === 'idle') {
          return `Contact driver to review engine idling policy and reduce unnecessary idle time.`;
        }
        return `Contact driver to schedule safety coaching session for observed behavior.`;

      case 'IMMEDIATE_DRIVER_CONTACT':
        return `Contact driver immediately to halt trip and confirm driver safety status.`;
      case 'SAFETY_REVIEW_REQUIRED':
        return `Dispatch safety response team and initiate incident investigation.`;
      case 'VEHICLE_INSPECTION_REQUIRED':
        return `Dispatch field service technician or route vehicle to maintenance facility for inspection.`;
      case 'SECURITY_REVIEW_REQUIRED':
        return `Inspect vehicle hardware and verify telematics unit security seal.`;
      case 'CONNECTIVITY_CHECK_REQUIRED':
        return `Check device power supply and verify LTE/GPS signal coverage in area.`;
      case 'ROUTE_REVIEW_REQUIRED':
        return `Contact driver to verify route authorization for current location.`;
      case 'FUEL_INVESTIGATION_REQUIRED':
        return `Inspect fuel tank sensor and check recent fuel transaction logs.`;
      case 'MONITOR_ONLY':
        return `Continue standard automated monitoring of vehicle activity.`;
      case 'NO_ACTION_REQUIRED':
        return `No action required; vehicle operates within normal parameters.`;
      default:
        return `Review vehicle activity logs and continue monitoring.`;
    }
  }

  _buildDefaultEntityRecommendation(entityType, context) {
    return {
      entityKey: context?.vehicle?.plate ? `PLATE:${context.vehicle.plate}` : 'UNKNOWN',
      riskLevel: 'LOW',
      trend: 'STABLE',
      operationalMeaning: 'Insufficient context for specific operational evaluation.',
      recommendedAction: {
        urgency: 'MONITOR',
        directive: 'Continue standard vehicle fleet monitoring.',
        category: 'MONITOR_ONLY',
      },
    };
  }

  _buildDefaultRecommendationResult() {
    return {
      generatedAt: new Date().toISOString(),
      vehicle: null,
      driver: null,
    };
  }
}

module.exports = OperationalRecommendationEngine;

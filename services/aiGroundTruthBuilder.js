/**
 * services/aiGroundTruthBuilder.js
 *
 * Feature #4: AI Fleet Intelligence / Executive Alert Synthesis — Phase 1 (AI Foundation & Ground-Truth Contract)
 *
 * Extracts and structures authoritative deterministic intelligence from Feature #1 (Event Context),
 * Feature #2 (Alert Correlation & Incident Intelligence), and Feature #3 (Dynamic Vehicle/Driver Risk)
 * into a clean, normalized, facts-only AIGroundTruthContract.
 *
 * Ground-Truth Principles:
 * 1. Features #1–#3 are authoritative (risk scores, severity, telemetry, directives MUST NOT be recalculated by AI).
 * 2. Strict prompt-injection boundary (raw email body/headers stored in untrustedData channel).
 * 3. Immutable, schema-versioned contract for downstream AI synthesis.
 */

'use strict';

const logger = require('../utils/logger');

const CONTRACT_SCHEMA_VERSION = '1.0';

class AIGroundTruthBuilder {
  /**
   * Transforms an EventContext object into a clean, normalized AIGroundTruthContract.
   *
   * @param {Object} context - Feature #1 EventContext object (enriched by Features #2 & #3)
   * @param {Object} [rawMail] - Raw mail object (optional untrusted email context)
   * @returns {Object} Structured AIGroundTruthContract
   */
  build(context, rawMail = null) {
    if (!context || typeof context !== 'object') {
      return this._buildDefaultContract();
    }

    try {
      const alertType = context.alertType || 'unknown';
      const alertLabel = context.alertLabel || alertType || 'Alert';
      const severity = context.severity || 'MEDIUM';
      const timestamp = context.timestamp || new Date().toISOString();
      const safeTsKey = context.timestamp && !isNaN(new Date(context.timestamp).getTime())
        ? String(new Date(context.timestamp).getTime())
        : '0';
      const eventId = context.eventId || `EVT-${alertType}-${safeTsKey}`;

      // Telemetry
      const telemetry = context.telemetry || {};
      const speed = typeof telemetry.speed === 'number' ? telemetry.speed : null;
      const speedLimit = typeof telemetry.speedLimit === 'number' ? telemetry.speedLimit : null;
      const excessSpeed = typeof telemetry.excessSpeed === 'number' ? telemetry.excessSpeed : null;
      const latitude = typeof telemetry.latitude === 'number' ? telemetry.latitude : null;
      const longitude = typeof telemetry.longitude === 'number' ? telemetry.longitude : null;

      // Vehicle & Driver Identity
      const vehicle = context.vehicle || {};
      const plate = vehicle.plate || null;
      const model = vehicle.model || null;
      const imei = vehicle.imei || null;
      const entityKey = context.risk?.vehicleRisk?.entityKey || (plate ? `PLATE:${plate}` : 'UNKNOWN');

      const driver = vehicle.driver || null;
      const driverIdentity = context.risk?.driverRisk?.entityKey || (driver ? `DRIVER:${driver}` : null);

      // Feature #2 Correlation & Incident Intelligence
      const corr = context.alertCorrelation || {};
      const inc = corr.incident || {};
      const intel = inc.intelligence || {};

      const incidentData = {
        isCorrelated: Boolean(corr.isCorrelated || inc.isIncident),
        eventCount: typeof corr.eventCount === 'number' ? corr.eventCount : 1,
        classification: inc.label || (corr.isCorrelated ? 'Correlated Alert Pattern' : 'Single Event'),
        isEscalated: Boolean(intel.escalation?.detected),
        interpretation: inc.interpretation || null,
      };

      // Feature #3 Risk & Trend Ground Truth
      const riskObj = context.risk || {};
      const vehicleRisk = riskObj.vehicleRisk || {};
      const driverRisk = riskObj.driverRisk || null;

      const riskData = {
        vehicle: {
          score: typeof vehicleRisk.score === 'number' ? vehicleRisk.score : 0,
          level: vehicleRisk.level || 'LOW',
        },
        driver: driverRisk ? {
          score: typeof driverRisk.score === 'number' ? driverRisk.score : 0,
          level: driverRisk.level || 'LOW',
        } : null,
      };

      const trendObj = context.riskTrend || {};
      const vehicleTrend = trendObj.vehicle || {};
      const driverTrend = trendObj.driver || null;

      const trendData = {
        vehicle: {
          trend: vehicleTrend.trend || 'STABLE',
          scoreChange: typeof vehicleTrend.scoreChange === 'number' ? vehicleTrend.scoreChange : 0,
          primaryReason: vehicleTrend.explanation?.primaryReason || 'STABLE_ACTIVITY',
          topContributors: Array.isArray(vehicleTrend.topContributors)
            ? vehicleTrend.topContributors.map(c => c.alertType || c)
            : [],
          repeatedBehaviors: Array.isArray(vehicleTrend.repeatedBehaviors)
            ? vehicleTrend.repeatedBehaviors.filter(r => r.repeated).map(r => r.alertType)
            : [],
        },
        driver: driverTrend ? {
          trend: driverTrend.trend || 'STABLE',
          scoreChange: typeof driverTrend.scoreChange === 'number' ? driverTrend.scoreChange : 0,
          primaryReason: driverTrend.explanation?.primaryReason || 'STABLE_ACTIVITY',
        } : null,
      };

      // Feature #3 Phase 3 Recommendations Ground Truth
      const recObj = context.riskRecommendation || {};
      const vehicleRec = recObj.vehicleRecommendation || recObj.vehicle || {};
      const driverRec = recObj.driverRecommendation || recObj.driver || null;

      const recAction = vehicleRec.recommendedAction || vehicleRec;

      const recommendationData = {
        vehicle: {
          urgency: recAction.urgency || 'MONITOR',
          category: recAction.category || 'MONITOR_ONLY',
          directive: recAction.directive || 'Continue standard vehicle fleet monitoring.',
          operationalMeaning: vehicleRec.operationalMeaning || 'Standard vehicle operation.',
        },
        driver: driverRec ? {
          urgency: driverRec.recommendedAction?.urgency || 'MONITOR',
          category: driverRec.recommendedAction?.category || 'MONITOR_ONLY',
          directive: driverRec.recommendedAction?.directive || 'Continue standard monitoring.',
          operationalMeaning: driverRec.operationalMeaning || 'Standard driver operation.',
        } : null,
      };

      // Untrusted Channel (Security Boundary for Prompt Injection Defense)
      const rawBody = rawMail?.text || rawMail?.html || context.rawText || null;
      const untrustedData = {
        rawEmailText: typeof rawBody === 'string' ? rawBody.slice(0, 1000) : null,
      };

      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        source: 'vehicle-alert-bot',
        grounding: {
          mode: 'STRUCTURED_GROUND_TRUTH',
          authoritative: true,
        },
        event: {
          eventId,
          alertType,
          alertLabel,
          severity,
          timestamp,
        },
        vehicle: {
          entityKey,
          plate,
          model,
          imei,
        },
        driver: {
          identity: driverIdentity,
        },
        telemetry: {
          speed,
          speedLimit,
          excessSpeed,
          latitude,
          longitude,
        },
        incident: incidentData,
        risk: riskData,
        trend: trendData,
        recommendation: recommendationData,
        untrustedData,
      };

    } catch (err) {
      logger.error(`AIGroundTruthBuilder error: ${err?.message || err}`);
      return this._buildDefaultContract();
    }
  }

  _buildDefaultContract() {
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      source: 'vehicle-alert-bot',
      grounding: {
        mode: 'STRUCTURED_GROUND_TRUTH',
        authoritative: true,
      },
      event: {
        eventId: 'EVT-unknown-0',
        alertType: 'unknown',
        alertLabel: 'Unknown Alert',
        severity: 'MEDIUM',
        timestamp: new Date().toISOString(),
      },
      vehicle: {
        entityKey: 'UNKNOWN',
        plate: null,
        model: null,
        imei: null,
      },
      driver: {
        identity: null,
      },
      telemetry: {
        speed: null,
        speedLimit: null,
        excessSpeed: null,
        latitude: null,
        longitude: null,
      },
      incident: {
        isCorrelated: false,
        eventCount: 1,
        classification: 'Single Event',
        isEscalated: false,
        interpretation: null,
      },
      risk: {
        vehicle: { score: 0, level: 'LOW' },
        driver: null,
      },
      trend: {
        vehicle: { trend: 'STABLE', scoreChange: 0, primaryReason: 'STABLE_ACTIVITY', topContributors: [], repeatedBehaviors: [] },
        driver: null,
      },
      recommendation: {
        vehicle: { urgency: 'MONITOR', category: 'MONITOR_ONLY', directive: 'Continue standard vehicle fleet monitoring.', operationalMeaning: 'Standard operation.' },
        driver: null,
      },
      untrustedData: {
        rawEmailText: null,
      },
    };
  }
}

module.exports = AIGroundTruthBuilder;

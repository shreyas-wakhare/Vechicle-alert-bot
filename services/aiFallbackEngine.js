/**
 * services/aiFallbackEngine.js
 *
 * Feature #4: AI Fleet Intelligence / Executive Alert Synthesis — Phase 1 (AI Foundation & Ground-Truth Contract)
 *
 * Provides a deterministic, non-AI fallback synthesis engine when AI providers are disabled, offline,
 * time out, or return invalid responses.
 *
 * Zero AI dependency, zero hallucination risk, 100% deterministic grounding in Features #1–#3.
 */

'use strict';

const logger = require('../utils/logger');

class AIFallbackEngine {
  /**
   * Synthesizes a deterministic non-AI summary from an AIGroundTruthContract or EventContext object.
   *
   * @param {Object} groundTruthContract - AIGroundTruthContract or EventContext object
   * @param {string} [reason='AI_UNAVAILABLE'] - Reason for triggering fallback
   * @returns {Object} Structured fallback synthesis object matching the AI output schema
   */
  synthesizeFallback(groundTruthContract, reason = 'AI_UNAVAILABLE') {
    if (!groundTruthContract || typeof groundTruthContract !== 'object') {
      return this._buildDefaultFallback();
    }

    try {
      const gt = (groundTruthContract.grounding || groundTruthContract.recommendation || groundTruthContract.event)
        ? groundTruthContract
        : this._normalizeContextToGt(groundTruthContract);

      const event = gt.event || {};
      const vehicle = gt.vehicle || {};
      const driver = gt.driver || {};
      const risk = gt.risk?.vehicle || {};
      const trend = gt.trend?.vehicle || {};
      const rec = gt.recommendation?.vehicle || {};

      const alertLabel = event.alertLabel || event.alertType || 'Alert';
      const severity = event.severity || 'MEDIUM';
      const vehicleName = vehicle.plate || vehicle.entityKey || 'Vehicle';
      const driverText = driver.identity ? ` (Driver: ${driver.identity.replace('DRIVER:', '')})` : '';

      const score = typeof risk.score === 'number' ? risk.score : 0;
      const level = risk.level || 'LOW';
      const trendText = trend.trend || 'STABLE';

      const operationalMeaning = rec.operationalMeaning || 'Standard vehicle operation.';
      const directive = rec.directive || 'Continue standard vehicle fleet monitoring.';
      const urgency = rec.urgency || 'MONITOR';
      const category = rec.category || 'MONITOR_ONLY';

      const summary = `${severity} severity ${alertLabel.toLowerCase()} alert for ${vehicleName}${driverText}. Risk level: ${level} (Score: ${score}/100, Trend: ${trendText}).`;

      const keyFacts = [
        `Alert Event: ${alertLabel} [${severity}]`,
        `Vehicle Identity: ${vehicleName}`,
        `Risk Score: ${score}/100 (${level}), Trajectory: ${trendText}`,
        `Operational Meaning: ${operationalMeaning}`,
        `Recommended Action: ${directive}`,
      ];

      const riskExplanation = `Deterministically evaluated risk level is ${level} (Score: ${score}/100) with trajectory ${trendText} based on recent telemetry frequency. [Fallback Reason: ${reason}]`;

      return {
        schemaVersion: '1.0',
        summary,
        keyFacts,
        riskExplanation,
        operationalMeaning,
        recommendedAction: {
          urgency,
          category,
          directive,
        },
        groundingStatus: 'DETERMINISTIC_FALLBACK',
      };

    } catch (err) {
      logger.error(`AIFallbackEngine error: ${err?.message || err}`);
      return this._buildDefaultFallback();
    }
  }

  _normalizeContextToGt(context) {
    const builder = new (require('./aiGroundTruthBuilder'))();
    return builder.build(context);
  }

  _buildDefaultFallback() {
    return {
      schemaVersion: '1.0',
      summary: 'Vehicle alert detected. Operational monitoring active.',
      keyFacts: ['Alert Event: Fleet Telemetry Event', 'Risk Assessment: Standard Monitoring'],
      riskExplanation: 'Deterministic risk evaluation within standard operating boundaries.',
      operationalMeaning: 'Standard vehicle operation.',
      recommendedAction: {
        urgency: 'MONITOR',
        category: 'MONITOR_ONLY',
        directive: 'Continue standard vehicle fleet monitoring.',
      },
      groundingStatus: 'DETERMINISTIC_FALLBACK',
    };
  }
}

module.exports = AIFallbackEngine;

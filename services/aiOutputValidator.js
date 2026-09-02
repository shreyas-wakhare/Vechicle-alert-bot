/**
 * services/aiOutputValidator.js
 *
 * Feature #4: AI Fleet Intelligence / Executive Alert Synthesis — Phase 1 (AI Foundation & Ground-Truth Contract)
 *
 * Validates AI synthesis responses against required JSON schemas and enforces strict non-authoritative bounds.
 * AI is permitted to generate explanations and summaries, but MUST NOT alter or overwrite authoritative
 * decision fields (risk scores, severity, recommendation urgency, action category, or manager directive).
 */

'use strict';

const logger = require('../utils/logger');

const REQUIRED_FIELDS = ['schemaVersion', 'summary', 'keyFacts', 'riskExplanation', 'operationalMeaning', 'recommendedAction', 'groundingStatus'];

class AIOutputValidator {
  /**
   * Validates an AI output object against contract schemas and ground-truth bounds.
   *
   * @param {Object} response - Raw AI provider response object
   * @param {Object} [groundTruth] - Original AIGroundTruthContract for bounds verification
   * @returns {Object} Validation result { isValid: boolean, errors: Array<string>, sanitizedOutput: Object|null }
   */
  validate(response, groundTruth = null) {
    const errors = [];

    if (!response || typeof response !== 'object') {
      return {
        isValid: false,
        errors: ['AI response must be a non-null object.'],
        sanitizedOutput: null,
      };
    }

    // 1. Schema Field Checks
    for (const field of REQUIRED_FIELDS) {
      if (!(field in response) || response[field] === undefined || response[field] === null) {
        errors.push(`Missing required output schema field: '${field}'.`);
      }
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 2. Type Validations
    if (typeof response.summary !== 'string' || !response.summary.trim()) {
      errors.push("Field 'summary' must be a non-empty string.");
    }

    if (!Array.isArray(response.keyFacts)) {
      errors.push("Field 'keyFacts' must be an array of strings.");
    }

    if (typeof response.riskExplanation !== 'string') {
      errors.push("Field 'riskExplanation' must be a string.");
    }

    if (typeof response.operationalMeaning !== 'string') {
      errors.push("Field 'operationalMeaning' must be a string.");
    }

    if (!response.recommendedAction || typeof response.recommendedAction !== 'object') {
      errors.push("Field 'recommendedAction' must be an object.");
    } else {
      if (!response.recommendedAction.directive || typeof response.recommendedAction.directive !== 'string') {
        errors.push("Field 'recommendedAction.directive' must be a string.");
      }
    }

    // 3. Score & Level Override Rejection
    if ('scoreOverrideAttempt' in response || 'calculatedScore' in response) {
      errors.push('AI output attempted to override authoritative risk score calculation.');
    }

    if (groundTruth && groundTruth.risk?.vehicle) {
      const gtScore = groundTruth.risk.vehicle.score;
      if (typeof response.riskScore === 'number' && response.riskScore !== gtScore) {
        errors.push(`AI output riskScore (${response.riskScore}) conflicts with ground-truth score (${gtScore}).`);
      }

      const gtLevel = groundTruth.risk.vehicle.level;
      if (typeof response.riskLevel === 'string' && response.riskLevel !== gtLevel) {
        errors.push(`AI output riskLevel (${response.riskLevel}) conflicts with ground-truth level (${gtLevel}).`);
      }
    }

    // 4. Authoritative Recommendation Bounds Protection
    if (groundTruth && groundTruth.recommendation?.vehicle) {
      const gtRec = groundTruth.recommendation.vehicle;
      const aiRec = response.recommendedAction;

      if (aiRec) {
        if (aiRec.urgency && aiRec.urgency !== gtRec.urgency) {
          errors.push(`AI output recommendedAction.urgency (${aiRec.urgency}) conflicts with ground-truth urgency (${gtRec.urgency}).`);
        }
        if (aiRec.category && aiRec.category !== gtRec.category) {
          errors.push(`AI output recommendedAction.category (${aiRec.category}) conflicts with ground-truth category (${gtRec.category}).`);
        }
        // Directives: If AI attempts to output a directive that contradicts Ground Truth (e.g. "ignore alert"), reject!
        if (aiRec.directive && typeof aiRec.directive === 'string') {
          const lowerDirective = aiRec.directive.toLowerCase();
          if (lowerDirective.includes('ignore') || lowerDirective.includes('no action') || lowerDirective.includes('bypass')) {
            if (gtRec.urgency !== 'MONITOR' && gtRec.urgency !== 'NO_ACTION') {
              errors.push(`AI output directive ('${aiRec.directive}') attempts to bypass high-urgency ground-truth directive.`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      logger.warn(`AIOutputValidator rejected output: ${errors.join(' | ')}`);
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 5. Sanitized Output Construction (Decision fields strictly anchored to Ground Truth)
    const gtRec = groundTruth?.recommendation?.vehicle || {};

    return {
      isValid: true,
      errors: [],
      sanitizedOutput: {
        schemaVersion: String(response.schemaVersion || '1.0'),
        summary: String(response.summary).trim(),
        keyFacts: Array.isArray(response.keyFacts) ? response.keyFacts.map(f => String(f).trim()) : [],
        riskExplanation: String(response.riskExplanation).trim(),
        operationalMeaning: String(response.operationalMeaning).trim(),
        recommendedAction: {
          urgency: String(gtRec.urgency || response.recommendedAction.urgency || 'MONITOR'),
          category: String(gtRec.category || response.recommendedAction.category || 'MONITOR_ONLY'),
          directive: String(gtRec.directive || response.recommendedAction.directive || 'Continue standard monitoring.').trim(),
        },
        groundingStatus: String(response.groundingStatus || 'GROUNDED'),
      },
    };
  }
}

module.exports = AIOutputValidator;

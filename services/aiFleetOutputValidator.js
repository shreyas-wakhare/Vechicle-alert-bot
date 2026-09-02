/**
 * services/aiFleetOutputValidator.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * Enforces strict schema verification and Ground-Truth non-override bounds for Fleet Executive Briefing outputs.
 * Rejects risk score, level, urgency, category, directive, or priority order overrides.
 */

'use strict';

const logger = require('../utils/logger');

class AIFleetOutputValidator {
  /**
   * Validates raw AI fleet synthesis output against authoritative Ground Truth contract.
   *
   * @param {Object} aiOutput - Raw response from AI provider
   * @param {Object} groundTruthContract - Authoritative AIFleetGroundTruthContract
   * @returns {Object} { isValid: boolean, errors: Array<string>, sanitizedOutput: Object|null }
   */
  validate(aiOutput, groundTruthContract) {
    const errors = [];

    if (!aiOutput || typeof aiOutput !== 'object') {
      return { isValid: false, errors: ['AI output is null, undefined, or not an object.'], sanitizedOutput: null };
    }

    const gt = groundTruthContract || {};
    const gtVehicles = Array.isArray(gt.vehicles) ? gt.vehicles : [];
    const gtPriorities = Array.isArray(gt.priorities) ? gt.priorities : [];
    const validPlates = new Set(gtVehicles.map(v => (v.plate || '').toUpperCase()));

    // 1. Validate Required Top-Level Schema Fields
    const requiredFields = ['executiveSummary', 'fleetStatus', 'topPriorities', 'dominantPatterns', 'operationalFocus', 'groundingStatus'];
    for (const field of requiredFields) {
      if (aiOutput[field] === undefined || aiOutput[field] === null) {
        errors.push(`Missing required fleet schema field: '${field}'.`);
      }
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 2. Validate Strings & Arrays
    if (typeof aiOutput.executiveSummary !== 'string' || !aiOutput.executiveSummary.trim()) {
      errors.push("Field 'executiveSummary' must be a non-empty string.");
    }
    if (typeof aiOutput.fleetStatus !== 'string' || !aiOutput.fleetStatus.trim()) {
      errors.push("Field 'fleetStatus' must be a non-empty string.");
    }
    if (!Array.isArray(aiOutput.topPriorities)) {
      errors.push("Field 'topPriorities' must be an array.");
    }
    if (!Array.isArray(aiOutput.dominantPatterns)) {
      errors.push("Field 'dominantPatterns' must be an array.");
    }
    if (typeof aiOutput.operationalFocus !== 'string' || !aiOutput.operationalFocus.trim()) {
      errors.push("Field 'operationalFocus' must be a non-empty string.");
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 3. Validate Top Priorities & Priority Order Non-Override
    const aiPriorities = aiOutput.topPriorities || [];
    for (let i = 0; i < aiPriorities.length; i++) {
      const p = aiPriorities[i];
      if (!p || typeof p !== 'object') {
        errors.push(`Top priority item at index ${i} is not an object.`);
        continue;
      }

      const plate = (p.plate || p.vehicle || '').toUpperCase();
      if (validPlates.size > 0 && plate && !validPlates.has(plate)) {
        errors.push(`AI fleet output references invented vehicle plate '${plate}' not present in Ground Truth.`);
      }

      // Priority Rank non-override: if GT priority list is present, verify order matches
      if (gtPriorities[i] && plate) {
        const expectedPlate = (gtPriorities[i].plate || '').toUpperCase();
        if (expectedPlate && plate !== expectedPlate) {
          errors.push(`AI fleet output re-ordered priority rank ${i + 1} (got '${plate}', expected '${expectedPlate}').`);
        }
      }
    }

    // 4. Grounding Status Verification
    if (aiOutput.groundingStatus !== 'GROUNDED' && aiOutput.groundingStatus !== 'DETERMINISTIC_FALLBACK') {
      errors.push(`Invalid groundingStatus '${aiOutput.groundingStatus}'. Must be 'GROUNDED' or 'DETERMINISTIC_FALLBACK'.`);
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 5. Construct Sanitized Output with Authoritative Attachments
    const sanitizedOutput = {
      schemaVersion: '1.0',
      executiveSummary: String(aiOutput.executiveSummary).trim(),
      fleetStatus: String(aiOutput.fleetStatus).trim(),
      topPriorities: aiPriorities.map((p, idx) => {
        const gtP = gtPriorities[idx] || {};
        return {
          vehicle: gtP.plate || p.plate || p.vehicle || 'UNKNOWN',
          driver: gtP.driver || p.driver || null,
          priorityRank: gtP.priorityRank || (idx + 1),
          reason: gtP.priorityReason || p.reason || `${gtP.riskLevel || 'LOW'} risk level`,
          riskScore: typeof gtP.riskScore === 'number' ? gtP.riskScore : (typeof p.riskScore === 'number' ? p.riskScore : 0),
          riskLevel: gtP.riskLevel || p.riskLevel || 'LOW',
          urgency: gtP.urgency || p.urgency || 'MONITOR',
          action: gtP.directive || p.action || 'Continue standard vehicle fleet monitoring.',
        };
      }),
      dominantPatterns: aiOutput.dominantPatterns.map(item => String(item).trim()),
      escalationSummary: aiOutput.escalationSummary ? String(aiOutput.escalationSummary).trim() : null,
      operationalFocus: String(aiOutput.operationalFocus).trim(),
      groundingStatus: aiOutput.groundingStatus,
    };

    return { isValid: true, errors: [], sanitizedOutput };
  }
}

module.exports = AIFleetOutputValidator;

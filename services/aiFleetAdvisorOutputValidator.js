/**
 * services/aiFleetAdvisorOutputValidator.js
 *
 * Feature #4 Phase 4.1: AI Fleet Operations Advisor Hardened Output Validator
 *
 * Enforces strict schema verification and Ground-Truth non-override bounds for Fleet Advisor outputs.
 * Inspects and rejects risk score, level, urgency, category, directive, priority tier, or priority order overrides.
 */

'use strict';

const logger = require('../utils/logger');

class AIFleetAdvisorOutputValidator {
  /**
   * Validates raw AI fleet advisor output against authoritative Ground Truth contract.
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
    const requiredFields = ['advisorStatus', 'managerSummary', 'priorityActionPlan', 'fleetResourceAllocation', 'preventativeGuidance', 'groundingStatus'];
    for (const field of requiredFields) {
      if (aiOutput[field] === undefined || aiOutput[field] === null) {
        errors.push(`Missing required advisor schema field: '${field}'.`);
      }
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 2. Validate Strings & Arrays
    if (typeof aiOutput.advisorStatus !== 'string' || !aiOutput.advisorStatus.trim()) {
      errors.push("Field 'advisorStatus' must be a non-empty string.");
    }
    if (typeof aiOutput.managerSummary !== 'string' || !aiOutput.managerSummary.trim()) {
      errors.push("Field 'managerSummary' must be a non-empty string.");
    }
    if (!Array.isArray(aiOutput.priorityActionPlan)) {
      errors.push("Field 'priorityActionPlan' must be an array.");
    }
    if (typeof aiOutput.fleetResourceAllocation !== 'string' || !aiOutput.fleetResourceAllocation.trim()) {
      errors.push("Field 'fleetResourceAllocation' must be a non-empty string.");
    }
    if (typeof aiOutput.preventativeGuidance !== 'string' || !aiOutput.preventativeGuidance.trim()) {
      errors.push("Field 'preventativeGuidance' must be a non-empty string.");
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 3. Priority Action Plan Length Alignment Verification
    const actionPlan = aiOutput.priorityActionPlan || [];
    if (gtPriorities.length > 0 && actionPlan.length !== gtPriorities.length) {
      errors.push(`AI advisor output priorityActionPlan length (${actionPlan.length}) does not match Ground Truth priorities length (${gtPriorities.length}).`);
    }

    // 4. Validate Priority Action Plan & Non-Override Bounds
    for (let i = 0; i < actionPlan.length; i++) {
      const item = actionPlan[i];
      if (!item || typeof item !== 'object') {
        errors.push(`Priority action plan item at index ${i} is not an object.`);
        continue;
      }

      const plate = (item.plate || item.vehicle || '').toUpperCase();
      if (validPlates.size > 0 && plate && !validPlates.has(plate)) {
        errors.push(`AI advisor output references invented vehicle plate '${plate}' not present in Ground Truth.`);
      }

      // Explicit Override Inspection against Ground Truth
      const gtP = gtPriorities[i];
      if (gtP) {
        const expectedPlate = (gtP.plate || '').toUpperCase();
        if (expectedPlate && plate !== expectedPlate) {
          errors.push(`AI advisor output re-ordered priority rank ${i + 1} (got '${plate}', expected '${expectedPlate}').`);
        }

        if (item.riskScore !== undefined && typeof item.riskScore === 'number' && item.riskScore !== gtP.riskScore) {
          errors.push(`AI advisor output riskScore (${item.riskScore}) conflicts with Ground Truth (${gtP.riskScore}).`);
        }

        if (item.riskLevel && item.riskLevel !== gtP.riskLevel) {
          errors.push(`AI advisor output riskLevel (${item.riskLevel}) conflicts with Ground Truth (${gtP.riskLevel}).`);
        }

        if (item.urgency && item.urgency !== gtP.urgency) {
          errors.push(`AI advisor output urgency (${item.urgency}) conflicts with Ground Truth (${gtP.urgency}).`);
        }

        if (item.category && item.category !== gtP.category) {
          errors.push(`AI advisor output category (${item.category}) conflicts with Ground Truth (${gtP.category}).`);
        }

        if (item.directive && typeof item.directive === 'string' && item.directive !== gtP.directive) {
          errors.push(`AI advisor output directive conflicts with Ground Truth directive.`);
        }

        if (item.priorityTier !== undefined && item.priorityTier !== gtP.priorityTier) {
          errors.push(`AI advisor output priorityTier (${item.priorityTier}) conflicts with Ground Truth (${gtP.priorityTier}).`);
        }
      }
    }

    // 5. Grounding Status Verification
    if (aiOutput.groundingStatus !== 'GROUNDED' && aiOutput.groundingStatus !== 'DETERMINISTIC_FALLBACK') {
      errors.push(`Invalid groundingStatus '${aiOutput.groundingStatus}'. Must be 'GROUNDED' or 'DETERMINISTIC_FALLBACK'.`);
    }

    if (errors.length > 0) {
      return { isValid: false, errors, sanitizedOutput: null };
    }

    // 6. Construct Sanitized Output with Authoritative Attachments from Ground Truth
    const sanitizedOutput = {
      schemaVersion: '1.0',
      advisorStatus: String(aiOutput.advisorStatus).trim(),
      managerSummary: String(aiOutput.managerSummary).trim(),
      priorityActionPlan: actionPlan.map((item, idx) => {
        const gtP = gtPriorities[idx] || {};
        return {
          vehicle: gtP.plate || item.plate || item.vehicle || 'UNKNOWN',
          driver: gtP.driver || item.driver || null,
          priorityRank: gtP.priorityRank || (idx + 1),
          priorityTier: typeof gtP.priorityTier === 'number' ? gtP.priorityTier : 9,
          urgency: gtP.urgency || item.urgency || 'MONITOR',
          category: gtP.category || item.category || 'MONITOR_ONLY',
          directive: gtP.directive || item.directive || 'Continue standard vehicle fleet monitoring.',
          operationalRationale: item.operationalRationale ? String(item.operationalRationale).trim() : (gtP.priorityReason || `${gtP.riskLevel || 'LOW'} risk level`),
        };
      }),
      fleetResourceAllocation: String(aiOutput.fleetResourceAllocation).trim(),
      preventativeGuidance: String(aiOutput.preventativeGuidance).trim(),
      groundingStatus: aiOutput.groundingStatus,
    };

    return { isValid: true, errors: [], sanitizedOutput };
  }
}

module.exports = AIFleetAdvisorOutputValidator;

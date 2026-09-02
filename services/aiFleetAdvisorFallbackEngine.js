/**
 * services/aiFleetAdvisorFallbackEngine.js
 *
 * Feature #4 Phase 4: AI Fleet Operations Advisor
 *
 * Generates a structured, zero-hallucination deterministic operational decision-support briefing
 * if AI advisor execution fails, times out, is disabled, or yields output rejected by validator.
 */

'use strict';

class AIFleetAdvisorFallbackEngine {
  /**
   * Generates a deterministic fallback advisor briefing from an AIFleetGroundTruthContract.
   *
   * @param {Object} groundTruthContract - Authoritative AIFleetGroundTruthContract
   * @param {string} [reason='UNKNOWN_FALLBACK'] - Fallback trigger reason
   * @returns {Object} Structured deterministic fallback fleet advisor output
   */
  synthesizeFallback(groundTruthContract, reason = 'UNKNOWN_FALLBACK') {
    const gt = groundTruthContract || {};
    const fleet = gt.fleet || {
      totalFleetVehicles: 0, vehicleCount: 0, activeVehicleCount: 0, alertCount: 0, tripCount: 0, incidentCount: 0, criticalCount: 0, highRiskVehicleCount: 0
    };
    const priorities = Array.isArray(gt.priorities) ? gt.priorities : [];
    const incidents = Array.isArray(gt.incidents) ? gt.incidents : [];
    const patterns = Array.isArray(gt.patterns) ? gt.patterns : [];

    if (fleet.activeVehicleCount === 0 && fleet.alertCount === 0) {
      return {
        schemaVersion: '1.0',
        advisorStatus: 'FLEET_STABLE',
        managerSummary: 'All monitored fleet vehicles operating within safe normal parameters with zero active alert events.',
        priorityActionPlan: [],
        fleetResourceAllocation: 'No special resource allocation required. Maintain routine fleet monitoring.',
        preventativeGuidance: 'Continue standard routine pre-trip vehicle and telemetry checks.',
        groundingStatus: 'DETERMINISTIC_FALLBACK',
      };
    }

    // Priority Action Plan
    const priorityActionPlan = priorities.slice(0, 5).map((p, idx) => ({
      vehicle: p.plate || 'UNKNOWN',
      driver: p.driver || null,
      priorityRank: p.priorityRank || (idx + 1),
      priorityTier: typeof p.priorityTier === 'number' ? p.priorityTier : 9,
      urgency: p.urgency || 'MONITOR',
      category: p.category || 'MONITOR_ONLY',
      directive: p.directive || 'Continue standard vehicle fleet monitoring.',
      operationalRationale: p.priorityReason || `${p.riskLevel || 'LOW'} risk level (${p.riskScore || 0}/100)`,
    }));

    // Advisor Status & Manager Summary
    const hasImmediateAction = priorityActionPlan.some(p => p.urgency === 'IMMEDIATE_ACTION' || p.priorityTier <= 2);
    const advisorStatus = (fleet.highRiskVehicleCount > 0 || hasImmediateAction) ? 'ACTION_REQUIRED' : 'MONITORING_ACTIVE';

    const criticalText = fleet.criticalCount > 0 ? ` with ${fleet.criticalCount} critical severity event(s)` : '';
    const highRiskText = fleet.highRiskVehicleCount > 0 ? ` ${fleet.highRiskVehicleCount} vehicle(s) require immediate/high-priority manager intervention.` : ' All vehicles remain below High risk thresholds.';
    const managerSummary = `Recorded ${fleet.alertCount} alert(s) across ${fleet.activeVehicleCount} active vehicle(s)${criticalText}.${highRiskText}`;

    // Fleet Resource Allocation
    const topPriority = priorityActionPlan[0];
    let fleetResourceAllocation = 'Maintain standard fleet monitoring and routine maintenance scheduling.';
    if (topPriority) {
      if (topPriority.urgency === 'IMMEDIATE_ACTION' || topPriority.priorityTier <= 2) {
        fleetResourceAllocation = `Prioritize immediate manager action for vehicle ${topPriority.vehicle}: ${topPriority.directive}`;
      } else {
        fleetResourceAllocation = `Schedule fleet manager operational review for vehicle ${topPriority.vehicle}: ${topPriority.directive}`;
      }
    }

    // Preventative Guidance
    const topPattern = patterns[0];
    const preventativeGuidance = topPattern
      ? `Conduct fleet-wide focus on ${topPattern.label || topPattern.type} (${topPattern.count} event(s) across ${topPattern.affectedVehicles} vehicle(s)) to prevent recurring operational risks.`
      : 'Maintain standard routine pre-trip driver safety and vehicle hardware checks.';

    return {
      schemaVersion: '1.0',
      advisorStatus,
      managerSummary,
      priorityActionPlan,
      fleetResourceAllocation,
      preventativeGuidance,
      groundingStatus: 'DETERMINISTIC_FALLBACK',
    };
  }
}

module.exports = AIFleetAdvisorFallbackEngine;

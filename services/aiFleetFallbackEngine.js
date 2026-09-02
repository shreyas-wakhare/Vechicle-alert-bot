/**
 * services/aiFleetFallbackEngine.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * Generates a structured, zero-hallucination deterministic fleet briefing if AI execution fails,
 * times out, is disabled, or yields output rejected by AIFleetOutputValidator.
 */

'use strict';

class AIFleetFallbackEngine {
  /**
   * Generates a deterministic fallback fleet briefing from an AIFleetGroundTruthContract.
   *
   * @param {Object} groundTruthContract - Authoritative AIFleetGroundTruthContract
   * @param {string} [reason='UNKNOWN_FALLBACK'] - Fallback trigger reason
   * @returns {Object} Structured deterministic fallback fleet synthesis
   */
  synthesizeFallback(groundTruthContract, reason = 'UNKNOWN_FALLBACK') {
    const gt = groundTruthContract || {};
    const fleet = gt.fleet || {
      vehicleCount: 0, activeVehicleCount: 0, alertCount: 0, tripCount: 0, incidentCount: 0, criticalCount: 0, highRiskVehicleCount: 0
    };
    const vehicles = Array.isArray(gt.vehicles) ? gt.vehicles : [];
    const priorities = Array.isArray(gt.priorities) ? gt.priorities : [];
    const patterns = Array.isArray(gt.patterns) ? gt.patterns : [];
    const incidents = Array.isArray(gt.incidents) ? gt.incidents : [];

    if (fleet.activeVehicleCount === 0 && fleet.alertCount === 0) {
      return {
        schemaVersion: '1.0',
        executiveSummary: 'No vehicle alert activity recorded across the fleet during the operational window.',
        fleetStatus: 'FLEET_NORMAL — All monitored vehicles operating cleanly with zero active risk events.',
        topPriorities: [],
        dominantPatterns: [],
        escalationSummary: 'No active incident escalations.',
        operationalFocus: 'Maintain standard routine fleet monitoring.',
        groundingStatus: 'DETERMINISTIC_FALLBACK',
      };
    }

    // Top Priorities
    const topPriorities = priorities.slice(0, 5).map((p, idx) => ({
      vehicle: p.plate || 'UNKNOWN',
      driver: p.driver || null,
      priorityRank: p.priorityRank || (idx + 1),
      reason: p.priorityReason || `${p.riskLevel || 'LOW'} risk level (${p.riskScore || 0}/100)`,
      riskScore: typeof p.riskScore === 'number' ? p.riskScore : 0,
      riskLevel: p.riskLevel || 'LOW',
      urgency: p.urgency || 'MONITOR',
      action: p.directive || 'Continue standard vehicle fleet monitoring.',
    }));

    // Executive Summary
    const criticalText = fleet.criticalCount > 0 ? ` including ${fleet.criticalCount} critical severity event(s)` : '';
    const highRiskText = fleet.highRiskVehicleCount > 0 ? ` ${fleet.highRiskVehicleCount} vehicle(s) currently at High/Critical risk.` : ' All vehicles remain below High risk thresholds.';
    const executiveSummary = `${fleet.alertCount} alert(s) recorded across ${fleet.activeVehicleCount} active vehicle(s)${criticalText}.${highRiskText}`;

    // Fleet Status
    const fleetStatus = fleet.highRiskVehicleCount > 0
      ? `ATTENTION_REQUIRED — ${fleet.highRiskVehicleCount} vehicle(s) elevated to High/Critical risk level.`
      : `OPERATIONAL — ${fleet.activeVehicleCount} vehicle(s) active with ${fleet.alertCount} total event(s).`;

    // Dominant Patterns
    const dominantPatterns = patterns.slice(0, 3).map(p =>
      `${p.label || p.type}: ${p.count} event(s) across ${p.affectedVehicles} vehicle(s)`
    );

    // Escalation Summary
    const escalatedIncidents = incidents.filter(i => i.isEscalated);
    const escalationSummary = escalatedIncidents.length > 0
      ? `${escalatedIncidents.length} incident(s) escalated: ${escalatedIncidents.map(i => `${i.plate} (${i.type})`).join(', ')}.`
      : 'No active incident escalations detected across the fleet.';

    // Operational Focus
    const primaryVehicle = topPriorities[0];
    const operationalFocus = primaryVehicle
      ? `Focus immediate manager attention on vehicle ${primaryVehicle.vehicle} (${primaryVehicle.reason}). Action: ${primaryVehicle.action}`
      : 'Maintain standard routine fleet monitoring.';

    return {
      schemaVersion: '1.0',
      executiveSummary,
      fleetStatus,
      topPriorities,
      dominantPatterns,
      escalationSummary,
      operationalFocus,
      groundingStatus: 'DETERMINISTIC_FALLBACK',
    };
  }
}

module.exports = AIFleetFallbackEngine;

/**
 * services/aiFleetGroundTruthBuilder.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * Constructs a structured, provider-independent AIFleetGroundTruthContract (schemaVersion '1.0')
 * containing facts-only deterministic metrics, active vehicle risk states, incidents, repeated patterns,
 * and deterministic priority rankings.
 *
 * Golden Rule: Ground Truth is authoritative. AI cannot recalculate risk scores, risk levels, or change priorities.
 */

'use strict';

const FleetIntelligenceEngine = require('./fleetIntelligenceEngine');

class AIFleetGroundTruthBuilder {
  /**
   * @param {Object} [options]
   * @param {Object} [options.fleetEngine] - FleetIntelligenceEngine instance
   */
  constructor(options = {}) {
    this.fleetEngine = options.fleetEngine || new FleetIntelligenceEngine();
  }

  /**
   * Builds an authoritative AIFleetGroundTruthContract from fleet intelligence or records.
   *
   * @param {Object|Array<Object>} [fleetDataOrRecords] - Pre-evaluated fleet intelligence object or record array
   * @param {number} [hours=24] - Operational window in hours
   * @returns {Object} Structured AIFleetGroundTruthContract
   */
  build(fleetDataOrRecords = null, hours = 24) {
    let fleetIntel;

    if (fleetDataOrRecords && typeof fleetDataOrRecords === 'object' && fleetDataOrRecords.fleetMetrics) {
      fleetIntel = fleetDataOrRecords;
    } else if (Array.isArray(fleetDataOrRecords)) {
      fleetIntel = this.fleetEngine.evaluateFleet(hours, fleetDataOrRecords);
    } else {
      fleetIntel = this.fleetEngine.evaluateFleet(hours);
    }

    const metrics = fleetIntel.fleetMetrics || {
      vehicleCount: 0,
      activeVehicleCount: 0,
      alertCount: 0,
      tripCount: 0,
      incidentCount: 0,
      criticalCount: 0,
      highRiskVehicleCount: 0,
    };

    const vehicles = (fleetIntel.vehicles || []).map(v => ({
      entityKey: v.entityKey || `PLATE:${v.plate}`,
      plate: v.plate || 'UNKNOWN',
      driver: v.driver || null,
      risk: {
        score: typeof v.risk?.score === 'number' ? v.risk.score : 0,
        level: v.risk?.level || 'LOW',
        trend: v.risk?.trend || 'STABLE',
      },
      alertCount: v.alertCount || 0,
      incidentCount: v.incidentCount || 0,
      latestAlertType: v.latestAlertType || 'unknown',
      latestSeverity: v.latestSeverity || 'MEDIUM',
      recommendation: {
        urgency: v.recommendation?.urgency || 'MONITOR',
        category: v.recommendation?.category || 'MONITOR_ONLY',
        directive: v.recommendation?.directive || 'Continue standard vehicle fleet monitoring.',
      },
    }));

    const incidents = (fleetIntel.incidents || []).map(i => ({
      incidentId: i.incidentId || `INC-${i.plate}`,
      vehicleKey: i.vehicleKey || `PLATE:${i.plate}`,
      plate: i.plate || 'UNKNOWN',
      type: i.type || 'UNKNOWN',
      severity: i.severity || 'MEDIUM',
      status: i.status || 'ACTIVE',
      isEscalated: Boolean(i.isEscalated),
      eventCount: i.eventCount || 1,
    }));

    const patterns = (fleetIntel.patterns || []).map(p => ({
      type: p.type || 'unknown',
      label: p.label || p.type || 'Unknown Pattern',
      count: p.count || 0,
      affectedVehicles: p.affectedVehicles || 0,
    }));

    const priorities = (fleetIntel.priorities || []).map((p, idx) => ({
      vehicleKey: p.vehicleKey || `PLATE:${p.plate}`,
      plate: p.plate || 'UNKNOWN',
      driver: p.driver || null,
      priorityRank: p.priorityRank || (idx + 1),
      priorityTier: typeof p.priorityTier === 'number' ? p.priorityTier : 9,
      priorityReason: p.priorityReason || `${p.riskLevel || 'LOW'} risk level (${p.riskScore || 0}/100)`,
      riskScore: typeof p.riskScore === 'number' ? p.riskScore : 0,
      riskLevel: p.riskLevel || 'LOW',
      trend: p.trend || 'STABLE',
      urgency: p.urgency || 'MONITOR',
      directive: p.directive || 'Continue standard vehicle fleet monitoring.',
    }));

    return {
      schemaVersion: '1.0',
      source: 'vehicle-alert-bot',
      grounding: {
        mode: 'FLEET_STRUCTURED_GROUND_TRUTH',
        authoritative: true,
      },
      generatedAt: new Date().toISOString(),
      fleet: metrics,
      vehicles,
      incidents,
      patterns,
      priorities,
    };
  }
}

module.exports = AIFleetGroundTruthBuilder;

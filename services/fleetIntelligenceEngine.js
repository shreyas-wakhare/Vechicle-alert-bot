/**
 * services/fleetIntelligenceEngine.js
 *
 * Feature #4 Phase 3.1.1: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization Corrective Hardening
 *
 * Collects deterministic alert intelligence across active vehicles, groups records by entity/incident,
 * detects repeated behavior patterns, and ranks vehicles in strict categorical priority order BEFORE AI.
 *
 * Golden Rules:
 * 1. AI does NOT calculate risk, calculate priorities, or invent incidents.
 * 2. Fleet intelligence evaluation is 100% READ-ONLY with respect to production RiskEngine state.
 * 3. All window records per vehicle are evaluated chronologically to derive true cumulative risk state.
 */

'use strict';

const logger = require('../utils/logger');
const EventContextBuilder = require('./eventContext');
const RiskEngine = require('./riskEngine');

const SEVERITY_WEIGHTS = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

class FleetIntelligenceEngine {
  /**
   * @param {Object} [options]
   * @param {Object} [options.historyStore] - HistoryStore instance
   * @param {Object} [options.eventContextBuilder] - Read-only EventContextBuilder instance
   */
  constructor(options = {}) {
    this.historyStore = options.historyStore || null;
    this.eventContextBuilder = options.eventContextBuilder || new EventContextBuilder({
      riskEngine: new RiskEngine({ persist: false })
    });
  }

  /**
   * Evaluates deterministic fleet intelligence over a bounded time window (hours).
   * Guarantee: READ-ONLY operation. Does NOT mutate persistent risk state.
   *
   * @param {number} [hours=24] - Operational window in hours
   * @param {Array<Object>} [explicitRecords] - Optional explicit record array for testing
   * @returns {Object} Deterministic Fleet Intelligence object
   */
  evaluateFleet(hours = 24, explicitRecords = null) {
    const windowHours = typeof hours === 'number' && hours > 0 ? hours : 24;
    const records = Array.isArray(explicitRecords)
      ? explicitRecords
      : (this.historyStore ? this.historyStore.getRecentRecords(windowHours) : []);

    const recentTrips = (this.historyStore && !explicitRecords)
      ? this.historyStore.getRecentTrips(windowHours)
      : [];

    const totalFleetVehicles = this.historyStore
      ? (this.historyStore.getAllVehicleSummaries()?.length || 0)
      : 0;

    // Group records by vehicle identity
    const vehicleMap = new Map();
    const incidentMap = new Map();
    const alertTypeCounts = {};
    let criticalCount = 0;

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const plate = (record.plate || record.vehicle?.plate || 'UNKNOWN').toUpperCase();
      const alertType = record.alertType || record.type || 'unknown';
      const severity = record.severity || 'MEDIUM';

      if (severity === 'CRITICAL') criticalCount++;

      // Count alert types across fleet
      if (!alertTypeCounts[alertType]) {
        alertTypeCounts[alertType] = { label: record.alertLabel || alertType, count: 0, affectedPlates: new Set() };
      }
      alertTypeCounts[alertType].count++;
      alertTypeCounts[alertType].affectedPlates.add(plate);

      // Group per vehicle
      if (!vehicleMap.has(plate)) {
        vehicleMap.set(plate, {
          plate,
          model: record.vehicleModel || record.vehicle?.model || 'Unknown',
          driver: record.driver || record.vehicle?.driver || null,
          records: [],
          alertTypes: new Map(),
          latestRecord: null,
        });
      }

      const vEntry = vehicleMap.get(plate);
      vEntry.records.push(record);
      if (!vEntry.alertTypes.has(alertType)) {
        vEntry.alertTypes.set(alertType, 0);
      }
      vEntry.alertTypes.set(alertType, vEntry.alertTypes.get(alertType) + 1);
      vEntry.latestRecord = record;

      // Group & aggregate incidents across the window
      const ctx = record.context;
      if (ctx?.alertCorrelation?.incident) {
        const inc = ctx.alertCorrelation.incident;
        if (inc.type !== 'NONE') {
          const incKey = `${plate}:${inc.type}:${inc.ruleId || 'inc'}`;
          if (!incidentMap.has(incKey)) {
            incidentMap.set(incKey, {
              incidentId: incKey,
              vehicleKey: `PLATE:${plate}`,
              plate,
              type: inc.type,
              label: inc.label || inc.type,
              severity: inc.highestSeverity || severity,
              status: inc.intelligence?.status || 'ACTIVE',
              isEscalated: Boolean(inc.intelligence?.escalation?.detected),
              eventCount: inc.matchedEvents?.length || 1,
            });
          } else {
            const existingInc = incidentMap.get(incKey);
            existingInc.eventCount = Math.max(existingInc.eventCount, inc.matchedEvents?.length || (existingInc.eventCount + 1));
            if (inc.intelligence?.escalation?.detected) existingInc.isEscalated = true;
            if ((SEVERITY_WEIGHTS[inc.highestSeverity] || 0) > (SEVERITY_WEIGHTS[existingInc.severity] || 0)) {
              existingInc.severity = inc.highestSeverity;
            }
            if (inc.intelligence?.status) existingInc.status = inc.intelligence.status;
          }
        }
      }
    }

    // Universal Chronological Sequential Evaluation per Vehicle (Read-Only)
    const vehicleSummaries = [];
    let highRiskVehicleCount = 0;

    for (const [plate, data] of vehicleMap.entries()) {
      // Sort vehicle records chronologically
      const vehicleRecords = [...data.records].sort((a, b) => new Date(a.receivedAt || 0) - new Date(b.receivedAt || 0));

      // Isolated, non-persistent RiskEngine per vehicle to prevent risk_state.json mutation
      const isolatedRiskEngine = new RiskEngine({ persist: false });
      const isolatedCtxBuilder = new EventContextBuilder({ riskEngine: isolatedRiskEngine });
      let finalContext = null;

      for (const rec of vehicleRecords) {
        finalContext = isolatedCtxBuilder.build({
          alertDef: { type: rec.alertType || rec.type, label: rec.alertLabel || rec.type, severity: rec.severity || 'MEDIUM' },
          fields: { plate: data.plate, vehicleModel: data.model, driver: data.driver, alertTime: rec.receivedAt }
        });

        // Also check if individual record context has an incident
        if (finalContext?.alertCorrelation?.incident) {
          const inc = finalContext.alertCorrelation.incident;
          if (inc.type !== 'NONE') {
            const incKey = `${plate}:${inc.type}:${inc.ruleId || 'inc'}`;
            if (!incidentMap.has(incKey)) {
              incidentMap.set(incKey, {
                incidentId: incKey,
                vehicleKey: `PLATE:${plate}`,
                plate,
                type: inc.type,
                label: inc.label || inc.type,
                severity: inc.highestSeverity || rec.severity || 'MEDIUM',
                status: inc.intelligence?.status || 'ACTIVE',
                isEscalated: Boolean(inc.intelligence?.escalation?.detected),
                eventCount: inc.matchedEvents?.length || 1,
              });
            } else {
              const existingInc = incidentMap.get(incKey);
              existingInc.eventCount = Math.max(existingInc.eventCount, inc.matchedEvents?.length || (existingInc.eventCount + 1));
              if (inc.intelligence?.escalation?.detected) existingInc.isEscalated = true;
              if ((SEVERITY_WEIGHTS[inc.highestSeverity] || 0) > (SEVERITY_WEIGHTS[existingInc.severity] || 0)) {
                existingInc.severity = inc.highestSeverity;
              }
            }
          }
        }
      }

      const riskScore = finalContext?.risk?.vehicleRisk?.score ?? 0;
      const riskLevel = finalContext?.risk?.vehicleRisk?.level || 'LOW';
      const riskTrend = finalContext?.riskTrend?.vehicle?.trend || 'STABLE';
      const vehicleRec = finalContext?.riskRecommendation?.vehicle;
      const urgency = vehicleRec?.recommendedAction?.urgency || 'MONITOR';
      const category = vehicleRec?.recommendedAction?.category || 'MONITOR_ONLY';
      const directive = vehicleRec?.recommendedAction?.directive || 'Continue standard vehicle fleet monitoring.';

      if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
        highRiskVehicleCount++;
      }

      const vehicleIncidents = Array.from(incidentMap.values()).filter(i => i.plate === plate);
      const hasEscalatedIncident = vehicleIncidents.some(i => i.isEscalated);
      const repeatedTypes = Array.from(data.alertTypes.entries()).filter(([_, count]) => count >= 2);

      // Strict Categorical Priority Tier (1 = Highest Priority, 9 = Lowest Priority)
      let priorityTier = 9;
      if (riskLevel === 'CRITICAL') priorityTier = 1;
      else if (urgency === 'IMMEDIATE_ACTION') priorityTier = 2;
      else if (hasEscalatedIncident) priorityTier = 3;
      else if (riskLevel === 'HIGH' && riskTrend === 'RISING') priorityTier = 4;
      else if (riskLevel === 'HIGH') priorityTier = 5;
      else if (repeatedTypes.length > 0) priorityTier = 6;
      else if (riskLevel === 'ELEVATED') priorityTier = 7;
      else if (riskLevel === 'MEDIUM') priorityTier = 8;
      else priorityTier = 9;

      vehicleSummaries.push({
        entityKey: `PLATE:${plate}`,
        plate,
        model: data.model,
        driver: data.driver,
        risk: {
          score: riskScore,
          level: riskLevel,
          trend: riskTrend,
        },
        alertCount: data.records.length,
        incidentCount: vehicleIncidents.length,
        hasEscalatedIncident,
        latestAlertType: data.latestRecord?.alertType || 'unknown',
        latestSeverity: data.latestRecord?.severity || 'MEDIUM',
        recommendation: {
          urgency,
          category,
          directive,
        },
        priorityTier,
        repeatedBehaviors: repeatedTypes.map(([type, count]) => ({ alertType: type, count })),
      });
    }

    // Sort vehicle summaries deterministically:
    // 1. priorityTier ASC
    // 2. riskScore DESC
    // 3. riskTrend DESC (RISING > STABLE > IMPROVING)
    // 4. alertCount DESC
    // 5. plate ASC
    vehicleSummaries.sort((a, b) => {
      if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier;
      if (a.risk.score !== b.risk.score) return b.risk.score - a.risk.score;

      const trendOrder = { RISING: 3, STABLE: 2, IMPROVING: 1 };
      const tA = trendOrder[a.risk.trend] || 2;
      const tB = trendOrder[b.risk.trend] || 2;
      if (tA !== tB) return tB - tA;

      if (a.alertCount !== b.alertCount) return b.alertCount - a.alertCount;
      return a.plate.localeCompare(b.plate);
    });

    // Build priorities list (top prioritized vehicles)
    const priorities = vehicleSummaries.map((v, idx) => {
      let priorityReason = `${v.risk.level} risk level (${v.risk.score}/100)`;
      if (v.priorityTier === 1) priorityReason = `CRITICAL risk level (${v.risk.score}/100) — immediate manager intervention required`;
      else if (v.priorityTier === 2) priorityReason = `Immediate manager action required (${v.recommendation.category})`;
      else if (v.priorityTier === 3) priorityReason = `Active escalated incident detected on vehicle`;
      else if (v.priorityTier === 4) priorityReason = `HIGH risk with RISING trajectory (+${v.risk.score} pts)`;
      else if (v.priorityTier === 6) priorityReason = `Repeated ${v.repeatedBehaviors.map(r => r.alertType).join(', ')} unsafe behavior`;

      return {
        vehicleKey: v.entityKey,
        plate: v.plate,
        driver: v.driver,
        priorityRank: idx + 1,
        priorityTier: v.priorityTier,
        priorityReason,
        riskScore: v.risk.score,
        riskLevel: v.risk.level,
        trend: v.risk.trend,
        urgency: v.recommendation.urgency,
        directive: v.recommendation.directive,
      };
    });

    // Extract dominant fleet patterns
    const patterns = Object.entries(alertTypeCounts)
      .map(([type, meta]) => ({
        type,
        label: meta.label,
        count: meta.count,
        affectedVehicles: meta.affectedPlates.size,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      windowHours,
      fleetMetrics: {
        totalFleetVehicles: Math.max(totalFleetVehicles, vehicleSummaries.length),
        vehicleCount: vehicleSummaries.length,
        activeVehicleCount: vehicleSummaries.filter(v => v.alertCount > 0).length,
        alertCount: records.length,
        tripCount: recentTrips.length,
        incidentCount: incidentMap.size,
        criticalCount,
        highRiskVehicleCount,
      },
      vehicles: vehicleSummaries.slice(0, 20), // Bounded at 20 vehicles
      incidents: Array.from(incidentMap.values()).slice(0, 10), // Bounded at 10 incidents
      patterns: patterns.slice(0, 5), // Bounded at 5 dominant patterns
      priorities: priorities.slice(0, 5), // Bounded at 5 top priority vehicles
    };
  }
}

module.exports = FleetIntelligenceEngine;

/**
 * services/riskTrendEngine.js
 *
 * Feature #3: Dynamic Vehicle/Driver Risk — Phase 2 (Behavioral History, Trends & Risk Contributors)
 *
 * Provides a deterministic, explainable intelligence layer on top of Feature #3 Phase 1 (RiskEngine)
 * and Feature #2 (Alert Correlation & Incident Intelligence).
 *
 * Key Capabilities:
 * 1. Deterministic Trend Analysis (RISING, STABLE, IMPROVING based on score trajectory).
 * 2. Top Risk Contributors (aggregates net impact points by alert type within bounded snapshot window).
 * 3. Repeated Behavior Detection (identifies repeated unsafe driving alert types).
 * 4. Recent vs Previous Snapshot Window Comparison (evaluates trajectory of recent activity vs previous snapshot window).
 * 5. Structured Risk Change Explanation (templates primary reason and explanation message).
 * 6. Strict Vehicle vs Driver Isolation (preserves Phase 1 entity scoping).
 * 7. Feature #2 Intelligence Awareness (consumes correlated incidents & escalations).
 *
 * Strictly NO AI/LLM, NO Machine Learning, NO Risk Prediction in Phase 2.
 */

'use strict';

const logger     = require('../utils/logger');
const alertTypes = require('../data/alertTypes.json');

const SEVERITY_MAP = new Map(alertTypes.map(a => [a.type, a.severity || 'MEDIUM']));

class RiskTrendEngine {
  /**
   * Generates deterministic trend, history, contributor, and explanation intelligence.
   *
   * @param {Object} context - Feature #1 EventContext object containing context.risk & context.alertCorrelation
   * @returns {Object} Structured riskTrend object
   */
  analyze(context) {
    if (!context || typeof context !== 'object' || !context.risk) {
      return this._buildDefaultTrendResult();
    }

    try {
      const risk = context.risk || {};
      const vehicleRisk = risk.vehicleRisk || null;
      const driverRisk = risk.driverRisk || null;
      const corr = context.alertCorrelation || {};

      const vehicleTrend = vehicleRisk ? this._analyzeEntityTrend('vehicle', vehicleRisk, corr, context) : null;
      const driverTrend = driverRisk ? this._analyzeEntityTrend('driver', driverRisk, corr, context) : null;

      return {
        generatedAt: new Date().toISOString(),
        vehicle: vehicleTrend,
        driver: driverTrend,
      };

    } catch (err) {
      logger.error(`RiskTrendEngine analyze error: ${err?.message || err}`);
      return this._buildDefaultTrendResult();
    }
  }

  /**
   * Internal deterministic analysis for a single entity's risk state.
   * @private
   */
  _analyzeEntityTrend(entityType, entityRisk, corr, context) {
    const currentScore = (typeof entityRisk.score === 'number' && Number.isFinite(entityRisk.score)) ? entityRisk.score : 0;
    const snapshots = Array.isArray(entityRisk.snapshots) ? entityRisk.snapshots : [];
    const contributors = Array.isArray(entityRisk.contributors) ? entityRisk.contributors : [];

    // 1. Previous Score derivation
    const prevSnapshot = snapshots.length > 1 ? snapshots[1] : null;
    const previousScore = prevSnapshot
      ? ((typeof prevSnapshot.score === 'number' && Number.isFinite(prevSnapshot.score)) ? prevSnapshot.score : currentScore)
      : (snapshots[0] && typeof snapshots[0].previousScore === 'number' && Number.isFinite(snapshots[0].previousScore) ? snapshots[0].previousScore : currentScore);

    const scoreChange = Number.isFinite(currentScore - previousScore) ? (currentScore - previousScore) : 0;

    // 2. Trend Classification (RISING, STABLE, IMPROVING)
    let trend = 'STABLE';
    if (scoreChange > 5) {
      trend = 'RISING';
    } else if (scoreChange < -5) {
      trend = 'IMPROVING';
    }

    // 3. Top Contributors Aggregation (Historical impact within bounded snapshot window)
    const topContributors = this._aggregateTopContributors(snapshots, contributors);

    // 4. Repeated Behavior Detection
    const repeatedBehaviors = this._detectRepeatedBehaviors(snapshots, entityType);

    // 5. Recent vs Previous Snapshot Window Comparison
    const comparison = this._comparePeriods(snapshots);

    // 6. Primary Reason & Structured Explanation Logic
    const explanation = this._generateExplanation(
      trend,
      scoreChange,
      topContributors,
      repeatedBehaviors,
      corr,
      context
    );

    return {
      entityKey: entityRisk.entityKey || 'UNKNOWN',
      trend,
      scoreChange,
      currentScore,
      previousScore,
      topContributors,
      repeatedBehaviors,
      comparison,
      explanation,
    };
  }

  /**
   * Aggregates cumulative net impact points by alert type from recent snapshots within the bounded window.
   * @private
   */
  _aggregateTopContributors(snapshots, defaultContributors) {
    const map = new Map(); // alertType -> { points, eventCount, alertLabel }

    const itemsToProcess = snapshots.length > 0 ? snapshots : defaultContributors;

    for (const item of itemsToProcess) {
      const type = item.alertType || 'unknown';
      const label = item.alertLabel || type;
      const pts = typeof item.netImpact === 'number' ? item.netImpact : 0;

      if (!map.has(type)) {
        map.set(type, { alertType: type, alertLabel: label, points: 0, eventCount: 0 });
      }
      const rec = map.get(type);
      rec.points += pts;
      rec.eventCount += 1;
    }

    const list = Array.from(map.values())
      .filter(c => c.points > 0)
      .sort((a, b) => b.points - a.points);

    return list.slice(0, 5);
  }

  /**
   * Detects repeated alert types in snapshots (deduplicated by eventId or deterministic event key).
   * @private
   */
  _detectRepeatedBehaviors(snapshots, entityType) {
    const eventCounts = new Map(); // alertType -> Set<eventId>
    const labels = new Map();

    for (const s of snapshots) {
      const type = s.alertType || 'unknown';
      const eventId = s.eventId || `EVT-${type}-${s.timestamp || '0'}`;
      labels.set(type, s.alertLabel || type);

      if (!eventCounts.has(type)) {
        eventCounts.set(type, new Set());
      }
      eventCounts.get(type).add(eventId);
    }

    const repeatedList = [];
    for (const [type, eventSet] of eventCounts.entries()) {
      const count = eventSet.size;
      const label = labels.get(type) || type;
      const severity = _resolveSeverity(type);

      repeatedList.push({
        alertType: type,
        alertLabel: label,
        count,
        severity,
        repeated: count >= 2,
      });
    }

    repeatedList.sort((a, b) => b.count - a.count);
    return repeatedList;
  }

  /**
   * Splits bounded history into Recent vs Previous snapshot window halves and evaluates activity trajectory.
   * @private
   */
  _comparePeriods(snapshots) {
    if (!snapshots || snapshots.length < 2) {
      return {
        recentEventCount: snapshots ? snapshots.length : 0,
        previousEventCount: 0,
        trajectory: 'STABLE',
      };
    }

    const mid = Math.ceil(snapshots.length / 2);
    const recentEvents = snapshots.slice(0, mid);
    const previousEvents = snapshots.slice(mid);

    const recentCount = recentEvents.length;
    const prevCount = previousEvents.length;

    let trajectory = 'STABLE';
    if (recentCount > prevCount + 1) {
      trajectory = 'DETERIORATING';
    } else if (recentCount < prevCount - 1) {
      trajectory = 'IMPROVING';
    }

    return {
      recentEventCount: recentCount,
      previousEventCount: prevCount,
      trajectory,
    };
  }

  /**
   * Deterministically generates primary reason and explanation message.
   * @private
   */
  _generateExplanation(trend, scoreChange, topContributors, repeatedBehaviors, corr, context) {
    const inc = corr.incident || {};
    const intel = inc.intelligence || {};
    const isEscalated = Boolean(intel.escalation?.detected);
    const isIncident = Boolean(inc.isIncident);

    const alertType = context?.alertType || '';
    const alertLabel = context?.alertLabel || alertType || 'Alert';
    const severity = context?.severity || _resolveSeverity(alertType);

    let primaryReason = 'STABLE_ACTIVITY';
    let message = 'Risk remains stable.';

    const topRepeated = repeatedBehaviors.find(r => r.repeated);
    const topContrib = topContributors[0];

    if (isEscalated) {
      primaryReason = 'ESCALATION';
      message = `Risk is ${trend.toLowerCase()} (${_formatChange(scoreChange)}) due to severe pattern escalation.`;
    } else if (isIncident) {
      primaryReason = 'CORRELATED_PATTERN';
      message = `Risk is ${trend.toLowerCase()} (${_formatChange(scoreChange)}) due to correlated ${inc.label || 'incident'} pattern.`;
    } else if (topRepeated) {
      primaryReason = 'REPEATED_BEHAVIOR';
      message = `Risk is ${trend.toLowerCase()} (${_formatChange(scoreChange)}) due to repeated ${topRepeated.alertLabel.toLowerCase()} alerts (${topRepeated.count}x).`;
    } else if (severity === 'HIGH' || severity === 'CRITICAL') {
      primaryReason = 'NEW_HIGH_SEVERITY_EVENT';
      message = `Risk is ${trend.toLowerCase()} (${_formatChange(scoreChange)}) due to high-severity ${alertLabel.toLowerCase()} alert.`;
    } else if (alertType === 'gps_restored' || alertType === 'lte_restored') {
      primaryReason = 'RECOVERY';
      message = `Risk is improving (${_formatChange(scoreChange)}) due to explicit signal recovery.`;
    } else if (scoreChange < -5) {
      primaryReason = 'CLEAN_TIME_DECAY';
      message = `Risk is improving (${_formatChange(scoreChange)}) due to clean alert-free elapsed time.`;
    } else if (scoreChange > 0) {
      primaryReason = 'NEW_EVENT_OBSERVED';
      message = `Risk increased slightly (${_formatChange(scoreChange)}) following ${alertLabel.toLowerCase()} alert.`;
    } else {
      primaryReason = 'STABLE_ACTIVITY';
      message = 'Risk level remains stable.';
    }

    const contributorTypes = topContributors.map(c => c.alertType);

    return {
      primaryReason,
      message,
      contributors: contributorTypes,
    };
  }

  _buildDefaultTrendResult() {
    return {
      generatedAt: new Date().toISOString(),
      vehicle: null,
      driver: null,
    };
  }
}

function _formatChange(change) {
  if (change > 0) return `+${change} pts`;
  return `${change} pts`;
}

function _resolveSeverity(alertType) {
  return SEVERITY_MAP.get(alertType) || 'MEDIUM';
}

module.exports = RiskTrendEngine;

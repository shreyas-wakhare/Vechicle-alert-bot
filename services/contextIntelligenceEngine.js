/**
 * services/contextIntelligenceEngine.js
 *
 * Feature #1: Event Context Layer — Phase 3 (Context Intelligence / Pattern & Risk Signal Engine)
 *
 * Consumes Phase 1 EventContext & Phase 2 recentActivity to produce deterministic,
 * explainable, rule-based intelligence signals.
 *
 * Strictly NO AI/LLM. Factual, evidence-based, configuration-driven pattern detection.
 */

const logger = require('../utils/logger');

// ─── Default Configuration-Driven Rules ──────────────────────────────────────

const DEFAULT_RULES = {
  repetition: [
    { minCount: 2, window: '15m', level: 'MEDIUM' },
    { minCount: 3, window: '15m', level: 'HIGH' },
    { minCount: 4, window: '30m', level: 'CRITICAL' },
  ],

  sequence: [
    {
      code: 'SPEEDING_TO_HARSH_BRAKING',
      sequence: ['speeding', 'harsh_braking'],
      maxGapMinutes: 10,
      level: 'HIGH',
      message: 'Vehicle overspeed followed by harsh braking detected.',
    },
    {
      code: 'AGGRESSIVE_DRIVING_SEQUENCE',
      sequence: ['harsh_acceleration', 'speeding', 'harsh_braking'],
      maxGapMinutes: 15,
      level: 'HIGH',
      message: 'Aggressive driving pattern detected: rapid acceleration → overspeed → harsh braking.',
    },
    {
      code: 'DISTRACTION_TO_SPEEDING',
      sequence: ['distraction', 'speeding'],
      maxGapMinutes: 10,
      level: 'HIGH',
      message: 'Driver distraction followed by overspeeding detected.',
    },
    {
      code: 'DISTRACTION_TO_HARSH_BRAKING',
      sequence: ['distraction', 'harsh_braking'],
      maxGapMinutes: 10,
      level: 'HIGH',
      message: 'Driver distraction followed by emergency harsh braking detected.',
    },
    {
      code: 'FATIGUE_TO_SPEEDING',
      sequence: ['fatigue', 'speeding'],
      maxGapMinutes: 15,
      level: 'CRITICAL',
      message: 'Driver fatigue alert followed by overspeeding detected.',
    },
    {
      code: 'DRINKING_TO_SPEEDING',
      sequence: ['drinking', 'speeding'],
      maxGapMinutes: 15,
      level: 'CRITICAL',
      message: 'Driver impairment alert followed by overspeeding detected.',
    },
  ],

  combination: [
    {
      code: 'SPEEDING_WITH_DISTRACTION',
      alertTypes: ['speeding', 'distraction'],
      window: '15m',
      level: 'HIGH',
      message: 'Overspeeding and driver distraction detected together in 15-minute window.',
    },
    {
      code: 'SPEEDING_WITH_HARSH_BRAKING',
      alertTypes: ['speeding', 'harsh_braking'],
      window: '15m',
      level: 'MEDIUM',
      message: 'Overspeeding and harsh braking detected together in 15-minute window.',
    },
    {
      code: 'FATIGUE_WITH_SPEEDING',
      alertTypes: ['fatigue', 'speeding'],
      window: '15m',
      level: 'CRITICAL',
      message: 'Driver fatigue and overspeeding detected together in 15-minute window.',
    },
    {
      code: 'DRINKING_WITH_SPEEDING',
      alertTypes: ['drinking', 'speeding'],
      window: '15m',
      level: 'CRITICAL',
      message: 'Driver impairment and overspeeding detected together in 15-minute window.',
    },
    {
      code: 'VIBRATION_WITH_DISTRACTION',
      alertTypes: ['vibration', 'distraction'],
      window: '15m',
      level: 'MEDIUM',
      message: 'Vehicle vibration and driver distraction detected together in 15-minute window.',
    },
  ],

  cluster: [
    {
      code: 'HIGH_EVENT_DENSITY_CLUSTER',
      minEvents: 4,
      minDistinctTypes: 3,
      window: '15m',
      level: 'HIGH',
      message: 'High event density: 4+ violations across 3+ distinct categories within 15 minutes.',
    },
  ],

  escalation: [
    {
      code: 'VIOLATION_ESCALATION',
      window: '15m',
      level: 'HIGH',
      message: 'Violations escalating in severity or frequency within 15 minutes.',
    },
  ],

  contextualRisk: [
    {
      code: 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION',
      level: 'HIGH',
      message: 'High-severity safety violation detected during an active vehicle trip.',
    },
    {
      code: 'REPEATED_ACTIVE_TRIP_RISK',
      level: 'CRITICAL',
      message: 'Multiple safety violations (3+) detected during an active vehicle trip.',
    },
  ],
};

const LEVEL_WEIGHTS = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };
const CATEGORY_WEIGHTS = {
  CONTEXTUAL_RISK: 6,
  ESCALATION: 5,
  SEQUENCE: 4,
  COMBINATION: 3,
  CLUSTER: 2,
  REPEATED_EVENT: 1,
};

class ContextIntelligenceEngine {
  constructor(customRules = null) {
    this.rules = customRules || DEFAULT_RULES;
  }

  /**
   * Main analysis function: consumes EventContext (with recentActivity) and returns contextIntelligence.
   *
   * @param {Object} context - Phase 1 EventContext (with recentActivity)
   * @returns {Object} contextIntelligence structure
   */
  analyze(context) {
    if (!context) {
      return this._emptyIntelligence();
    }

    const recent = context.recentActivity;
    if (!recent || !recent.windows) {
      return this._emptyIntelligence();
    }

    const signals = [];

    // 1. Detect Repetition
    const repetitionSignals = this._detectRepetition(context);
    signals.push(...repetitionSignals);

    // 2. Detect Sequences
    const sequenceSignals = this._detectSequences(context);
    signals.push(...sequenceSignals);

    // 3. Detect Combinations
    const combinationSignals = this._detectCombinations(context);
    signals.push(...combinationSignals);

    // 4. Detect Clusters
    const clusterSignals = this._detectClusters(context);
    signals.push(...clusterSignals);

    // 5. Detect Escalation
    const escalationSignals = this._detectEscalation(context);
    signals.push(...escalationSignals);

    // 6. Detect Contextual Risk
    const contextualSignals = this._detectContextualRisk(context);
    signals.push(...contextualSignals);

    // Deduplicate signals by code
    const uniqueSignals = this._deduplicateSignals(signals);

    // Deterministically sort signals (Level > Category > Code)
    uniqueSignals.sort((a, b) => {
      const levelDiff = (LEVEL_WEIGHTS[b.level] || 0) - (LEVEL_WEIGHTS[a.level] || 0);
      if (levelDiff !== 0) return levelDiff;
      const catDiff = (CATEGORY_WEIGHTS[b.category] || 0) - (CATEGORY_WEIGHTS[a.category] || 0);
      if (catDiff !== 0) return catDiff;
      return a.code.localeCompare(b.code);
    });

    const summary = {
      signalCount: uniqueSignals.length,
      highestLevel: uniqueSignals.length > 0 ? uniqueSignals[0].level : 'NONE',
      hasEscalation: uniqueSignals.some(s => s.category === 'ESCALATION'),
      hasRepeatedViolation: uniqueSignals.some(s => s.category === 'REPEATED_EVENT'),
      hasSequence: uniqueSignals.some(s => s.category === 'SEQUENCE'),
      hasCombination: uniqueSignals.some(s => s.category === 'COMBINATION'),
      hasCluster: uniqueSignals.some(s => s.category === 'CLUSTER'),
      hasContextualRisk: uniqueSignals.some(s => s.category === 'CONTEXTUAL_RISK'),
    };

    return {
      generatedAt: new Date().toISOString(),
      signals: uniqueSignals,
      summary,
    };
  }

  // ─── Signal Detectors ──────────────────────────────────────────────────────

  _detectRepetition(context) {
    const signals = [];
    const window15m = context.recentActivity?.windows?.['15m'];
    const currentType = context.alertType;
    if (!window15m || !currentType || currentType === 'unknown' || currentType.startsWith('ignition_')) {
      return signals;
    }

    const count = window15m.countsByAlertType[currentType] || 0;
    if (count >= 2) {
      // Find matching rule threshold
      let level = 'MEDIUM';
      if (count >= 4) level = 'CRITICAL';
      else if (count >= 3) level = 'HIGH';

      const matchingEvents = window15m.events.filter(e => e.alertType === currentType);
      const eventIds = matchingEvents.map(e => e.eventId);

      signals.push({
        type: 'REPEATED_EVENT',
        code: `REPEATED_${currentType.toUpperCase()}`,
        category: 'REPEATED_EVENT',
        level,
        alertType: currentType,
        message: `Repeated ${context.alertLabel} violations (${count}x) detected within 15 minutes.`,
        reason: `Vehicle ${context.vehicle.plate || '?'} recorded ${count} occurrences of ${context.alertLabel} within 15 minutes.`,
        evidence: {
          count,
          window: '15m',
          alertTypes: [currentType],
          eventIds,
        },
        vehicleState: {
          ignition: context.trip?.ignitionState || 'UNKNOWN',
          tripActive: context.trip?.active ?? false,
        },
      });
    }

    return signals;
  }

  _detectSequences(context) {
    const signals = [];
    const window15m = context.recentActivity?.windows?.['15m'];
    if (!window15m || !window15m.events || window15m.events.length < 2) {
      return signals;
    }

    // Events are newest -> oldest
    const eventsOldestFirst = [...window15m.events].reverse();

    for (const rule of this.rules.sequence) {
      const matchedEventIds = this._matchOrderedSequence(eventsOldestFirst, rule.sequence, rule.maxGapMinutes);
      if (matchedEventIds) {
        signals.push({
          type: 'EVENT_SEQUENCE',
          code: rule.code,
          category: 'SEQUENCE',
          level: rule.level,
          alertType: context.alertType,
          message: rule.message,
          reason: `Ordered event sequence [${rule.sequence.join(' → ')}] detected within ${rule.maxGapMinutes} minutes.`,
          evidence: {
            window: `${rule.maxGapMinutes}m`,
            alertTypes: rule.sequence,
            eventIds: matchedEventIds,
            count: matchedEventIds.length,
          },
          vehicleState: {
            ignition: context.trip?.ignitionState || 'UNKNOWN',
            tripActive: context.trip?.active ?? false,
          },
        });
      }
    }

    return signals;
  }

  _detectCombinations(context) {
    const signals = [];
    const window15m = context.recentActivity?.windows?.['15m'];
    if (!window15m || !window15m.countsByAlertType) {
      return signals;
    }

    for (const rule of this.rules.combination) {
      const allPresent = rule.alertTypes.every(type => (window15m.countsByAlertType[type] || 0) > 0);
      if (allPresent) {
        const matchingEvents = window15m.events.filter(e => rule.alertTypes.includes(e.alertType));
        const eventIds = [...new Set(matchingEvents.map(e => e.eventId))];

        signals.push({
          type: 'EVENT_COMBINATION',
          code: rule.code,
          category: 'COMBINATION',
          level: rule.level,
          alertType: context.alertType,
          message: rule.message,
          reason: `Alert combination [${rule.alertTypes.join(' + ')}] detected within 15 minutes.`,
          evidence: {
            window: '15m',
            alertTypes: rule.alertTypes,
            eventIds,
            count: eventIds.length,
          },
          vehicleState: {
            ignition: context.trip?.ignitionState || 'UNKNOWN',
            tripActive: context.trip?.active ?? false,
          },
        });
      }
    }

    return signals;
  }

  _detectClusters(context) {
    const signals = [];
    const window15m = context.recentActivity?.windows?.['15m'];
    if (!window15m) return signals;

    for (const rule of this.rules.cluster) {
      const distinctTypes = Object.keys(window15m.countsByAlertType).filter(t => !t.startsWith('ignition_'));
      if (window15m.totalEvents >= rule.minEvents && distinctTypes.length >= rule.minDistinctTypes) {
        const eventIds = window15m.events.map(e => e.eventId);

        signals.push({
          type: 'EVENT_CLUSTER',
          code: rule.code,
          category: 'CLUSTER',
          level: rule.level,
          alertType: context.alertType,
          message: rule.message,
          reason: `High alert density: ${window15m.totalEvents} events across ${distinctTypes.length} alert types detected within 15 minutes.`,
          evidence: {
            window: '15m',
            alertTypes: distinctTypes,
            eventIds,
            count: window15m.totalEvents,
          },
          vehicleState: {
            ignition: context.trip?.ignitionState || 'UNKNOWN',
            tripActive: context.trip?.active ?? false,
          },
        });
      }
    }

    return signals;
  }

  _detectEscalation(context) {
    const signals = [];
    const window15m = context.recentActivity?.windows?.['15m'];
    if (!window15m || !window15m.events || window15m.events.length < 2) return signals;

    // Events are newest -> oldest
    const events = window15m.events;
    const eventIds = events.map(e => e.eventId);

    // Meaningful escalation requires a severity jump of >= 2 weight levels
    // (e.g. LOW→HIGH=+2, MEDIUM→CRITICAL=+2, LOW→CRITICAL=+3).
    // A single-tier jump (LOW→MEDIUM or MEDIUM→HIGH) is normal operational variation
    // and is NOT treated as an escalation signal to avoid false positives.
    const MIN_ESCALATION_JUMP = 2;

    let escalated = false;
    let minLevelSeen = Infinity;
    const oldestFirst = [...events].reverse();
    for (const e of oldestFirst) {
      const w = LEVEL_WEIGHTS[e.severity] || 1;
      if (w < minLevelSeen) minLevelSeen = w;
    }
    const newestLevel = LEVEL_WEIGHTS[events[0].severity] || 1;
    if (newestLevel - minLevelSeen >= MIN_ESCALATION_JUMP) {
      escalated = true;
    }

    // Secondary check for 3+ events: newest > average-of-older by >= 2 tiers
    if (!escalated && events.length >= 3) {
      const newestSev = LEVEL_WEIGHTS[events[0].severity] || 1;
      const olderSevs = events.slice(1).map(e => LEVEL_WEIGHTS[e.severity] || 1);
      const avgOlder = olderSevs.reduce((a, b) => a + b, 0) / olderSevs.length;
      if (newestSev - avgOlder >= MIN_ESCALATION_JUMP) escalated = true;
    }

    if (escalated) {
      const level = context.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
      signals.push({
        type: 'ESCALATION',
        code: 'VIOLATION_ESCALATION',
        category: 'ESCALATION',
        level,
        alertType: context.alertType,
        message: 'Violation severity escalation detected within 15 minutes.',
        reason: `Recent alert progression shows escalating severity levels up to ${context.severity}.`,
        evidence: {
          window: '15m',
          alertTypes: [...new Set(events.map(e => e.alertType))],
          eventIds,
          count: events.length,
        },
        vehicleState: {
          ignition: context.trip?.ignitionState || 'UNKNOWN',
          tripActive: context.trip?.active ?? false,
        },
      });
    }

    return signals;
  }

  _detectContextualRisk(context) {
    const signals = [];
    const isTripActive = context.trip?.active === true;
    const window15m = context.recentActivity?.windows?.['15m'];

    // Driver-safety and driver-behavior alert types that are meaningful
    // to flag during an active driving trip.
    // Excluded: geofence events, fuel/equipment alerts, GPS/LTE jamming, offline,
    // low_battery, tampering — these are operational/equipment events, not driver
    // behavior, and should not produce in-trip safety signals.
    const DRIVER_SAFETY_TYPES = new Set([
      'speeding', 'harsh_braking', 'harsh_acceleration',
      'distraction', 'fatigue', 'drinking', 'seatbelt',
      'smoking', 'lane_change', 'ubi_acceleration', 'ubi_deceleration',
      'driver_change', 'camera_blocked', 'sos', 'accident',
      'engine_failure', 'vibration', 'voice_alarm',
    ]);

    if (isTripActive) {
      const isDriverSafetyAlert = DRIVER_SAFETY_TYPES.has(context.alertType);

      // Only fire ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION for driver-safety alert types
      if (isDriverSafetyAlert && (context.severity === 'HIGH' || context.severity === 'CRITICAL')) {
        signals.push({
          type: 'CONTEXTUAL_RISK',
          code: 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION',
          category: 'CONTEXTUAL_RISK',
          level: context.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
          alertType: context.alertType,
          message: `High-severity violation (${context.alertLabel}) detected during an active vehicle trip.`,
          reason: `${context.alertLabel} (${context.severity}) occurred while vehicle ${context.vehicle.plate || '?'} was actively driving.`,
          evidence: {
            window: 'current',
            alertTypes: [context.alertType],
            eventIds: [context.eventId],
            count: 1,
          },
          vehicleState: {
            ignition: context.trip?.ignitionState || 'ON',
            tripActive: true,
          },
        });
      }

      // REPEATED_ACTIVE_TRIP_RISK: fires when 3+ driver-safety events accumulate
      // in the 15m window during an active trip. Ignores operational/equipment events.
      if (window15m) {
        const safetyEventCount = window15m.events.filter(e => DRIVER_SAFETY_TYPES.has(e.alertType)).length;
        if (safetyEventCount >= 3) {
          const safetyEvents = window15m.events.filter(e => DRIVER_SAFETY_TYPES.has(e.alertType));
          const safetyEventIds = safetyEvents.map(e => e.eventId);
          const safetyTypes = [...new Set(safetyEvents.map(e => e.alertType))];
          signals.push({
            type: 'CONTEXTUAL_RISK',
            code: 'REPEATED_ACTIVE_TRIP_RISK',
            category: 'CONTEXTUAL_RISK',
            level: 'CRITICAL',
            alertType: context.alertType,
            message: `Multiple safety violations (${safetyEventCount}x) detected during active trip.`,
            reason: `Vehicle ${context.vehicle.plate || '?'} recorded ${safetyEventCount} safety events during an active trip within 15 minutes.`,
            evidence: {
              window: '15m',
              alertTypes: safetyTypes,
              eventIds: safetyEventIds,
              count: safetyEventCount,
            },
            vehicleState: {
              ignition: context.trip?.ignitionState || 'ON',
              tripActive: true,
            },
          });
        }
      }
    }

    return signals;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _matchOrderedSequence(eventsOldestFirst, sequenceTypes, maxGapMinutes) {
    if (eventsOldestFirst.length < sequenceTypes.length) return null;

    const maxGapMs = maxGapMinutes * 60 * 1000;
    let seqIdx = 0;
    const matchedIds = [];
    let prevTs = 0;

    for (const e of eventsOldestFirst) {
      const targetType = sequenceTypes[seqIdx];
      const eTs = new Date(e.timestamp).getTime();

      if (e.alertType === targetType) {
        if (seqIdx === 0 || (eTs >= prevTs && eTs - prevTs <= maxGapMs)) {
          matchedIds.push(e.eventId);
          prevTs = eTs;
          seqIdx++;
          if (seqIdx === sequenceTypes.length) {
            return matchedIds; // Complete sequence matched!
          }
        }
      }
    }

    return null;
  }

  _deduplicateSignals(signals) {
    const seen = new Set();
    const result = [];
    for (const s of signals) {
      if (!seen.has(s.code)) {
        seen.add(s.code);
        result.push(s);
      }
    }
    return result;
  }

  _emptyIntelligence() {
    return {
      generatedAt: new Date().toISOString(),
      signals: [],
      summary: {
        signalCount: 0,
        highestLevel: 'NONE',
        hasEscalation: false,
        hasRepeatedViolation: false,
        hasSequence: false,
        hasCombination: false,
        hasCluster: false,
        hasContextualRisk: false,
      },
    };
  }
}

module.exports = ContextIntelligenceEngine;

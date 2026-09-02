/**
 * services/incidentIntelligenceEngine.js
 *
 * Feature #2: Alert Correlation — Phase 3.1 (Correlation Intelligence — Intelligence Foundation)
 *
 * Enriches Phase 2 incident objects with deterministic operational intelligence:
 * - Lifecycle status (DETECTED vs ACTIVE) and duration calculation
 * - Chronological event sequence (consumes Phase 1 ascending ordering with defensive fallback sorting)
 * - Initiating event (chronological sequence[0]) & primary trigger (rule-matched initiating alert type)
 * - Supporting events array (subsequent chronological evidence events)
 * - Continuation and escalation stubs for Phase 3.2 extension
 * - Human-readable explanation summary
 *
 * Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.
 */

const logger = require('../utils/logger');
const IncidentLifecycleEngine = require('./incidentLifecycleEngine');
const IncidentInterpretationEngine = require('./incidentInterpretationEngine');

class IncidentIntelligenceEngine {
  constructor() {
    this.lifecycleEngine = new IncidentLifecycleEngine();
    this.interpretationEngine = new IncidentInterpretationEngine();
  }

  /**
   * Generates deterministic operational intelligence for a classified incident.
   *
   * @param {Object} incident - Feature #2 Phase 2 incident object
   * @param {Object} correlationResult - Feature #2 Phase 1 correlation object
   * @param {Object} [context] - Optional EventContext for vehicle speed/location fields
   * @returns {Object} JSON-safe intelligence object
   */
  analyze(incident, correlationResult, context = null) {
    if (!incident || typeof incident !== 'object') {
      return this._buildEmptyIntelligence();
    }

    try {
      // 1. Extract raw events array & apply defensive chronological ascending sorting
      let rawEvents = (correlationResult && Array.isArray(correlationResult.events))
        ? [...correlationResult.events]
        : [];

      if (rawEvents.length > 1) {
        rawEvents.sort((a, b) => {
          const ta = _parseTimestamp(a.timestamp);
          const tb = _parseTimestamp(b.timestamp);
          if (ta === null || tb === null) return 0;
          return ta - tb;
        });
      }

      const eventTypes = (correlationResult && Array.isArray(correlationResult.eventTypes))
        ? correlationResult.eventTypes
        : (incident.matchedEvents || []);

      // 2. Timestamps & Duration
      const startedAt = incident.startTime || correlationResult?.startTime || (rawEvents[0]?.timestamp) || new Date().toISOString();
      const latestAt = incident.latestTime || correlationResult?.latestTime || (rawEvents[rawEvents.length - 1]?.timestamp) || startedAt;

      const startMs = _parseTimestamp(startedAt);
      const latestMs = _parseTimestamp(latestAt);
      const durationSeconds = Math.max(0, Math.round((latestMs - startMs) / 1000));

      // 3. Delegate Lifecycle, Continuation, Escalation, and Resolution to IncidentLifecycleEngine
      const lifecycleEval = this.lifecycleEngine.evaluate(incident, correlationResult);
      const lifecycleStatus = lifecycleEval.status || 'DETECTED';

      // 4. Chronological Sequence Extraction
      const sequence = rawEvents.length > 0
        ? rawEvents.map(e => e.alertType)
        : (Array.isArray(incident.matchedEvents) && incident.matchedEvents.length > 0 ? incident.matchedEvents : eventTypes);

      // 5. Initiating Event vs Primary Trigger vs Supporting Events Derivation
      const { initiatingEvent, primaryTrigger, supportingEvents } = this._deriveTriggersAndSupporting(incident, sequence);

      // 6. Operational Explanation Summary
      const explanation = this._generateExplanation(incident, initiatingEvent, primaryTrigger, sequence, durationSeconds);

      // 7. Base Intelligence Object
      const intelObj = {
        status: lifecycleStatus,
        lifecycle: {
          status: lifecycleStatus,
          startedAt,
          latestAt,
          durationSeconds,
          resolutionReason: lifecycleEval.resolutionReason || null,
        },
        sequence,
        initiatingEvent,
        primaryTrigger,
        supportingEvents,
        escalation: lifecycleEval.escalation || {
          detected: false,
          previousIncidentType: null,
          reason: null,
        },
        continuation: lifecycleEval.continuation || {
          isContinuation: false,
          previousIncidentId: null,
          mergedEventCount: sequence.length,
        },
        summary: {
          explanation,
        },
        generatedAt: new Date().toISOString(),
      };

      // 8. Phase 3.3 Operational Interpretation & Narrative
      intelObj.interpretation = this.interpretationEngine.interpret(incident, correlationResult, intelObj, context);

      return intelObj;

    } catch (err) {
      logger.error(`IncidentIntelligenceEngine error: ${err?.message || err}`);
      return this._buildEmptyIntelligence();
    }
  }

  /**
   * Derives initiating event (sequence[0]), rule primary trigger, and supporting events.
   * @private
   */
  _deriveTriggersAndSupporting(incident, sequence) {
    if (!sequence || sequence.length === 0) {
      return { initiatingEvent: null, primaryTrigger: null, supportingEvents: [] };
    }

    // initiatingEvent: Always the chronological first event in sequence
    const initiatingEvent = sequence[0];

    // primaryTrigger: Rule-matched primary trigger type if incident matched, otherwise sequence[0]
    let primaryTrigger = null;
    if (Array.isArray(incident.matchedEvents) && incident.matchedEvents.length > 0) {
      const matchedSet = new Set(incident.matchedEvents);
      primaryTrigger = sequence.find(type => matchedSet.has(type)) || initiatingEvent;
    } else {
      primaryTrigger = initiatingEvent;
    }

    // supportingEvents: All subsequent events following the initiatingEvent instance
    const supportingEvents = [];
    let initiatingFound = false;

    for (const type of sequence) {
      if (type === initiatingEvent && !initiatingFound) {
        initiatingFound = true;
      } else {
        supportingEvents.push(type);
      }
    }

    return { initiatingEvent, primaryTrigger, supportingEvents };
  }

  _generateExplanation(incident, initiatingEvent, primaryTrigger, sequence, durationSeconds) {
    const label = incident.label || incident.type || 'Activity';
    if (!incident.isIncident && incident.type === 'NONE') {
      return `Single event observed: ${initiatingEvent || 'alert'}.`;
    }
    if (!incident.isIncident && incident.type === 'CORRELATED_ACTIVITY') {
      return `Correlated activity of ${sequence.length} alerts (${sequence.join(', ')}) over ${durationSeconds}s initiated by ${initiatingEvent}. No pattern incident matched.`;
    }

    const seqText = sequence.length > 1 ? `Sequence: ${sequence.join(' → ')}.` : '';
    const durText = durationSeconds > 0 ? `Duration: ${durationSeconds}s.` : '';
    const initText = initiatingEvent ? `Initiated by: ${initiatingEvent}.` : '';

    return `${label} pattern detected. ${initText} ${seqText} ${durText}`.replace(/\s+/g, ' ').trim();
  }

  _buildEmptyIntelligence() {
    return {
      status: 'NONE',
      lifecycle: {
        status: 'NONE',
        startedAt: null,
        latestAt: null,
        durationSeconds: 0,
      },
      sequence: [],
      initiatingEvent: null,
      primaryTrigger: null,
      supportingEvents: [],
      escalation: {
        detected: false,
        previousIncidentType: null,
      },
      continuation: {
        isContinuation: false,
        previousIncidentId: null,
      },
      summary: {
        explanation: 'No intelligence available.',
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

function _parseTimestamp(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts.getTime();
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? null : parsed;
}

module.exports = IncidentIntelligenceEngine;

/**
 * services/eventContext.js
 *
 * Feature #1: Event Context Layer — Phase 1 (Context Foundation)
 *
 * Standardizes incoming raw alert parameters and telemetry into a clean,
 * consistent runtime EventContext object.
 *
 * Serves as the foundational context object for the alert pipeline while
 * maintaining 100% backward compatibility with existing business rules,
 * message formatters, and WhatsApp routing.
 */

const logger                     = require('../utils/logger');
const RecentActivityEngine       = require('./recentActivityEngine');
const ContextIntelligenceEngine  = require('./contextIntelligenceEngine');
const AlertCorrelationEngine     = require('./alertCorrelationEngine');
const RiskEngine                 = require('./riskEngine');
const RiskTrendEngine            = require('./riskTrendEngine');
const OperationalRecommendationEngine = require('./operationalRecommendationEngine');
const AIGroundTruthBuilder       = require('./aiGroundTruthBuilder');
const AIFallbackEngine            = require('./aiFallbackEngine');

class EventContextBuilder {
  constructor(historyStore = null, options = {}) {
    const opts = (historyStore && typeof historyStore === 'object' && !historyStore.getRecentRecords) ? historyStore : options;
    const store = (historyStore && typeof historyStore === 'object' && historyStore.getRecentRecords) ? historyStore : null;
    this.historyStore = store;
    this.recentEngine = new RecentActivityEngine(store);
    this.intelligenceEngine = new ContextIntelligenceEngine();
    this.correlationEngine = new AlertCorrelationEngine();
    this.riskEngine = opts.riskEngine || (
      opts.persistRisk === true || opts.persist === true
        ? new RiskEngine({ persist: true })
        : new RiskEngine({ persist: false })
    );
    this.trendEngine = new RiskTrendEngine();
    this.recommendationEngine = new OperationalRecommendationEngine();
    this.aiGroundTruthBuilder = new AIGroundTruthBuilder();
    this.aiFallbackEngine = new AIFallbackEngine();
  }

  setHistoryStore(store, options = {}) {
    this.historyStore = store;
    this.recentEngine.setHistoryStore(store);
    if (options.riskEngine) {
      this.riskEngine = options.riskEngine;
    } else if (typeof options.persistRisk === 'boolean' || typeof options.persist === 'boolean') {
      const shouldPersist = options.persistRisk === true || options.persist === true;
      this.riskEngine = new RiskEngine({ persist: shouldPersist });
    }
  }

  /**
   * Build a standardized EventContext object from parsed alert data.
   *
   * @param {Object} parsedResult - Object containing { alertDef, fields }
   * @param {Object} [mail] - Optional parsed mail object from mailparser
   * @returns {Object} Standardized EventContext object
   */
  build(parsedResult, mail = null) {
    if (!parsedResult || !parsedResult.alertDef || !parsedResult.fields) {
      return null;
    }

    const { alertDef, fields } = parsedResult;
    const plate = fields.plate ? fields.plate.toUpperCase() : null;
    const emailUid = mail?.uid || fields.emailUid || null;

    // Correlation / Reference ID
    const eventId = emailUid
      ? `UID-${emailUid}`
      : (fields.alertTime
          ? `EVT-${new Date(fields.alertTime).getTime() || Date.now()}`
          : `EVT-${Date.now()}`);

    // Telemetry normalization (safe parsing, fallback to null)
    const speed = _parseNumber(fields.speed);
    const speedLimit = _parseNumber(fields.speedLimit);
    const excessSpeed = (speed !== null && speedLimit !== null)
      ? Math.max(0, speed - speedLimit)
      : null;

    const idleTime = _parseIntNumber(fields.idleTime);
    const idleLimit = _parseIntNumber(fields.idleLimit);
    const overIdleTime = (idleTime !== null && idleLimit !== null)
      ? Math.max(0, idleTime - idleLimit)
      : null;

    const latitude = _parseNumber(fields.latitude);
    const longitude = _parseNumber(fields.longitude);

    // Trip & Ignition Context derivation from single source of truth (HistoryStore)
    const tripContext = this._deriveTripContext(plate);

    const context = {
      eventId,
      alertType: alertDef.type || 'unknown',
      alertLabel: alertDef.label || 'Alert',
      severity: alertDef.severity || 'MEDIUM',
      timestamp: fields.alertTime || mail?.date?.toISOString() || new Date().toISOString(),
      source: fields.source || 'unknown',

      vehicle: {
        plate,
        model: fields.vehicleModel || null,
        imei: fields.imei || null,
        driver: fields.driver || null,
      },

      telemetry: {
        speed,
        speedLimit,
        excessSpeed,
        idleTime,
        idleLimit,
        overIdleTime,
      },

      location: {
        address: fields.address || null,
        latitude,
        longitude,
        mapsUrl: fields.mapsUrl || null,
        trackUrl: fields.trackUrl || null,
      },

      trip: tripContext,

      metadata: {
        emailUid,
        receivedAt: mail?.date ? mail.date.toISOString() : new Date().toISOString(),
        emailSubject: mail?.subject || fields.emailSubject || null,
        rawSource: fields.source || 'unknown',
      },
    };

    context.recentActivity = this.recentEngine.buildRecentActivity(context);

    try {
      context.contextIntelligence = this.intelligenceEngine.analyze(context);
    } catch (err) {
      logger.error(`ContextIntelligenceEngine error: ${err?.message || err}`);
      context.contextIntelligence = {
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

    try {
      context.alertCorrelation = this.correlationEngine.correlate(context);
    } catch (err) {
      logger.error(`AlertCorrelationEngine error: ${err?.message || err}`);
      context.alertCorrelation = {
        correlationId: `CORR-EMPTY-${Date.now()}`,
        vehicleKey: 'UNKNOWN',
        vehicle: null,
        status: 'NONE',
        isCorrelated: false,
        eventCount: 0,
        eventIds: [],
        eventTypes: [],
        events: [],
        startTime: null,
        latestTime: null,
        durationMs: 0,
        windowMinutes: 15,
        generatedAt: new Date().toISOString(),
      };
    }

    try {
      context.risk = this.riskEngine.evaluate(context);
    } catch (err) {
      logger.error(`RiskEngine error: ${err?.message || err}`);
      context.risk = {
        generatedAt: new Date().toISOString(),
        vehicleRisk: null,
        driverRisk: null,
      };
    }

    try {
      context.riskTrend = this.trendEngine.analyze(context);
    } catch (err) {
      logger.error(`RiskTrendEngine error: ${err?.message || err}`);
      context.riskTrend = {
        generatedAt: new Date().toISOString(),
        vehicle: null,
        driver: null,
      };
    }

    try {
      context.riskRecommendation = this.recommendationEngine.generate(context);
    } catch (err) {
      logger.error(`OperationalRecommendationEngine error: ${err?.message || err}`);
      context.riskRecommendation = {
        generatedAt: new Date().toISOString(),
        vehicle: null,
        driver: null,
      };
    }

    try {
      context.aiGroundTruth = this.aiGroundTruthBuilder.build(context, mail);
      context.aiSynthesis = this.aiFallbackEngine.synthesizeFallback(context.aiGroundTruth);
    } catch (err) {
      logger.error(`AIGroundTruthBuilder / AIFallbackEngine error: ${err?.message || err}`);
      context.aiGroundTruth = null;
      context.aiSynthesis = null;
    }

    logger.debug(
      `EventContext created → id: ${context.eventId} | type: ${context.alertType} ` +
      `| plate: ${context.vehicle.plate || '?'} | signals: ${context.contextIntelligence?.summary?.signalCount || 0}`
    );

    return context;
  }

  /**
   * Derives basic ignition state and trip status using existing HistoryStore methods.
   * @private
   */
  _deriveTripContext(plate) {
    if (!plate || !this.historyStore) {
      return {
        active: null,
        ignitionState: 'UNKNOWN',
        lastIgnitionOnTime: null,
        lastIgnitionOffTime: null,
      };
    }

    try {
      const lastOn = this.historyStore.getLastIgnitionOn(plate);
      const lastOff = this.historyStore.getLastIgnitionOff(plate);

      const onTimeMs = lastOn?.time ? new Date(lastOn.time).getTime() : 0;
      const offTimeMs = lastOff ? new Date(lastOff).getTime() : 0;

      let ignitionState = 'UNKNOWN';
      let active = null; // null = no history / unknown state

      if (onTimeMs > 0 && (offTimeMs === 0 || onTimeMs > offTimeMs)) {
        ignitionState = 'ON';
        active = true;
      } else if (offTimeMs > 0 && (onTimeMs === 0 || offTimeMs >= onTimeMs)) {
        ignitionState = 'OFF';
        active = false;
      }

      return {
        active,
        ignitionState,
        lastIgnitionOnTime: lastOn?.time || null,
        lastIgnitionOffTime: lastOff || null,
      };
    } catch {
      return {
        active: null,
        ignitionState: 'UNKNOWN',
        lastIgnitionOnTime: null,
        lastIgnitionOffTime: null,
      };
    }
  }
}

function _parseNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function _parseIntNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

module.exports = EventContextBuilder;

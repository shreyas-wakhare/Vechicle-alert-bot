/**
 * services/aiFleetAdvisor.js
 *
 * Feature #4 Phase 4: AI Fleet Operations Advisor
 *
 * Executive Fleet Operations Advisor Orchestrator.
 * Combines Read-Only Fleet Ground Truth, Advisor Request construction, timeout-isolated provider execution,
 * strict output validation, and deterministic fallback generation.
 */

'use strict';

const logger = require('../utils/logger');
const FleetIntelligenceEngine = require('./fleetIntelligenceEngine');
const AIFleetGroundTruthBuilder = require('./aiFleetGroundTruthBuilder');
const AIFleetAdvisorRequestBuilder = require('./aiFleetAdvisorRequestBuilder');
const { createAIProvider } = require('./aiProvider');
const AIFleetAdvisorOutputValidator = require('./aiFleetAdvisorOutputValidator');
const AIFleetAdvisorFallbackEngine = require('./aiFleetAdvisorFallbackEngine');

class AIFleetAdvisor {
  /**
   * @param {Object} [options]
   * @param {Object} [options.historyStore] - HistoryStore instance
   * @param {Object} [options.provider] - Custom AIProvider instance
   * @param {boolean} [options.enabled=true] - Master toggle for AI generation
   * @param {number} [options.timeoutMs=8000] - Hard execution timeout in ms
   */
  constructor(options = {}) {
    this.historyStore = options.historyStore || null;
    this.fleetEngine = new FleetIntelligenceEngine({ historyStore: this.historyStore });
    this.gtBuilder = new AIFleetGroundTruthBuilder({ fleetEngine: this.fleetEngine });
    this.requestBuilder = new AIFleetAdvisorRequestBuilder();
    this.provider = options.provider || createAIProvider(process.env.AI_PROVIDER, options);
    this.validator = new AIFleetAdvisorOutputValidator();
    this.fallbackEngine = new AIFleetAdvisorFallbackEngine();

    const envEnabled = process.env.AI_ENABLED !== 'false';
    this.enabled = options.enabled !== undefined ? options.enabled : envEnabled;

    const envTimeout = parseInt(process.env.AI_TIMEOUT_MS, 10);
    this.timeoutMs = typeof options.timeoutMs === 'number'
      ? options.timeoutMs
      : (!isNaN(envTimeout) ? envTimeout : 8000);
  }

  /**
   * Synthesizes an Operational Decision-Support Briefing for fleet managers.
   * Guarantee: READ-ONLY operation. Does NOT mutate persistent risk state.
   *
   * @param {Object|Array} [fleetDataOrRecords] - Fleet intelligence object, record array, or null
   * @param {number} [hours=24] - Operational window in hours
   * @returns {Promise<Object>} Validated Advisor Briefing object or deterministic fallback
   */
  async generateAdvice(fleetDataOrRecords = null, hours = 24) {
    let groundTruth;

    try {
      groundTruth = (fleetDataOrRecords && fleetDataOrRecords.schemaVersion === '1.0' && fleetDataOrRecords.grounding?.mode === 'FLEET_STRUCTURED_GROUND_TRUTH')
        ? fleetDataOrRecords
        : this.gtBuilder.build(fleetDataOrRecords, hours);

      if (!this.enabled) {
        logger.info('AIFleetAdvisor: AI disabled by configuration; using deterministic fallback.');
        return this.fallbackEngine.synthesizeFallback(groundTruth, 'AI_DISABLED');
      }

      const aiRequest = this.requestBuilder.build(groundTruth);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

      const rawAiResponse = await this._executeWithTimeout(
        this.provider.generate(aiRequest, { signal: controller?.signal }),
        this.timeoutMs,
        controller
      );

      const validation = this.validator.validate(rawAiResponse, groundTruth);
      if (!validation.isValid) {
        logger.warn(`AIFleetAdvisor validator rejected output: ${validation.errors.join(' | ')}. Triggering fallback.`);
        return this.fallbackEngine.synthesizeFallback(groundTruth, 'VALIDATOR_REJECTED');
      }

      return validation.sanitizedOutput;

    } catch (err) {
      logger.warn(`AIFleetAdvisor provider execution error: ${err?.message || err}. Triggering fallback.`);
      return this.fallbackEngine.synthesizeFallback(groundTruth, 'PROVIDER_ERROR');
    }
  }

  /**
   * Enforces a hard execution timeout wrapper on asynchronous provider calls.
   * @private
   */
  async _executeWithTimeout(promise, ms, controller = null) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller && typeof controller.abort === 'function') {
          try { controller.abort(); } catch {}
        }
        reject(new Error(`AIFleetAdvisor execution timed out after ${ms}ms`));
      }, ms);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

module.exports = AIFleetAdvisor;

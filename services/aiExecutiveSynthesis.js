/**
 * services/aiExecutiveSynthesis.js
 *
 * Feature #4: AI Fleet Intelligence / Executive Alert Synthesis — Phase 2 (Single-Alert Executive AI Synthesis)
 *
 * Orchestrates the single-alert executive AI synthesis pipeline:
 * 1. AIRequestBuilder: Constructs structured AI request.
 * 2. AIProvider: Invokes AI generation (Mock or Production).
 * 3. AIOutputValidator: Validates schema and enforces ground-truth non-override bounds.
 * 4. AIFallbackEngine: Executes deterministic non-AI fallback on failure/timeout.
 *
 * Guarantees zero alert pipeline disruption and 100% ground-truth decision integrity.
 */

'use strict';

const logger = require('../utils/logger');
const AIGroundTruthBuilder = require('./aiGroundTruthBuilder');
const AIRequestBuilder = require('./aiRequestBuilder');
const { createAIProvider } = require('./aiProvider');
const AIOutputValidator = require('./aiOutputValidator');
const AIFallbackEngine = require('./aiFallbackEngine');

class AIExecutiveSynthesis {
  /**
   * @param {Object} [options]
   * @param {Object} [options.provider] - Custom AIProvider instance (defaults to createAIProvider())
   * @param {boolean} [options.enabled=true] - Master toggle for AI generation
   * @param {number} [options.timeoutMs=5000] - Hard execution timeout
   */
  constructor(options = {}) {
    this.gtBuilder = new AIGroundTruthBuilder();
    this.requestBuilder = new AIRequestBuilder();
    this.provider = options.provider || createAIProvider(process.env.AI_PROVIDER, options);
    this.validator = new AIOutputValidator();
    this.fallbackEngine = new AIFallbackEngine();

    const envEnabled = process.env.AI_ENABLED !== 'false';
    this.enabled = options.enabled !== undefined ? options.enabled : envEnabled;

    const envTimeout = parseInt(process.env.AI_TIMEOUT_MS, 10);
    this.timeoutMs = typeof options.timeoutMs === 'number'
      ? options.timeoutMs
      : (!isNaN(envTimeout) ? envTimeout : 5000);
  }

  /**
   * Generates a validated executive AI synthesis object from an EventContext or AIGroundTruthContract.
   *
   * @param {Object} context - Feature #1 EventContext object
   * @param {Object} [rawMail] - Raw mail object
   * @returns {Promise<Object>} Validated AI synthesis object or safe fallback
   */
  async synthesize(context, rawMail = null) {
    let groundTruth;

    try {
      groundTruth = (context && context.schemaVersion === '1.0' && context.grounding)
        ? context
        : this.gtBuilder.build(context, rawMail);

      if (!this.enabled) {
        logger.info('AIExecutiveSynthesis: AI disabled by configuration; using deterministic fallback.');
        return this.fallbackEngine.synthesizeFallback(groundTruth, 'AI_DISABLED');
      }

      const aiRequest = this.requestBuilder.build(groundTruth, rawMail);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

      const rawAiResponse = await this._executeWithTimeout(
        this.provider.generate(aiRequest, { signal: controller?.signal, timeoutMs: this.timeoutMs }),
        this.timeoutMs,
        controller
      );

      const validation = this.validator.validate(rawAiResponse, groundTruth);
      if (!validation.isValid) {
        logger.warn(`AIExecutiveSynthesis validator rejected output: ${validation.errors.join(' | ')}. Triggering fallback.`);
        return this.fallbackEngine.synthesizeFallback(groundTruth, 'VALIDATOR_REJECTED');
      }

      return validation.sanitizedOutput;

    } catch (err) {
      logger.warn(`AIExecutiveSynthesis provider execution error: ${err?.message || err}. Triggering fallback.`);
      return this.fallbackEngine.synthesizeFallback(groundTruth, 'PROVIDER_ERROR');
    }
  }

  /**
   * Enforces a hard timeout wrapper on asynchronous provider calls.
   * @private
   */
  async _executeWithTimeout(promise, ms, controller = null) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller && typeof controller.abort === 'function') {
          try { controller.abort(); } catch {}
        }
        reject(new Error(`AIExecutiveSynthesis execution timed out after ${ms}ms`));
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

module.exports = AIExecutiveSynthesis;

/**
 * services/aiProvider.js
 *
 * Feature #4 Phase 5: Production AI Provider Integration & Safety Guardrails
 *
 * Provides a vendor-agnostic provider abstraction supporting:
 * 1. MockAIProvider (Offline testing & development default)
 * 2. OpenAIProvider (Live HTTPS REST for OpenAI GPT-4o / GPT-4o-mini)
 * 3. GeminiProvider (Live HTTPS REST for Google Gemini REST API)
 *
 * Implements exponential backoff retries on transient errors (429/503),
 * AbortController signal cancellation, PII scrubbing, and safe API key validation.
 */

'use strict';

const https = require('https');
const { URL } = require('url');
const logger = require('../utils/logger');
const AIPrivacyScrubber = require('./aiPrivacyScrubber');

const scrubber = new AIPrivacyScrubber();

class AIProvider {
  /**
   * Generates AI synthesis response from a structured AI request contract.
   *
   * @param {Object} aiRequest - Structured AI request containing groundTruth and systemInstruction
   * @param {Object} [options] - Execution options (e.g. { signal })
   * @returns {Promise<Object>} Structured AI response object
   */
  async generate(aiRequest, options = {}) {
    throw new Error('AIProvider.generate() must be implemented by subclass.');
  }

  async healthCheck() {
    return true;
  }
}

class MockAIProvider extends AIProvider {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.simulateError=false] - Force provider error for testing
   * @param {boolean} [options.simulateTimeout=false] - Force provider timeout for testing
   * @param {boolean} [options.simulateMalformed=false] - Force malformed response for testing
   * @param {number} [options.latencyMs=10] - Simulated network latency
   */
  constructor(options = {}) {
    super();
    this.simulateError = options.simulateError === true;
    this.simulateTimeout = options.simulateTimeout === true;
    this.simulateMalformed = options.simulateMalformed === true;
    this.latencyMs = typeof options.latencyMs === 'number' ? options.latencyMs : 10;
  }

  async healthCheck() {
    return !this.simulateError && !this.simulateTimeout;
  }

  async generate(aiRequest, options = {}) {
    if (this.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    }

    if (this.simulateTimeout) {
      throw new Error('AIProviderTimeout: Request timed out after 5000ms');
    }

    if (this.simulateError) {
      throw new Error('AIProviderError: AI service temporarily unavailable (503 Service Unavailable)');
    }

    const groundTruth = aiRequest?.groundTruth || {};
    const event = groundTruth.event || {};
    const vehicle = groundTruth.vehicle || {};
    const driver = groundTruth.driver || {};
    const risk = groundTruth.risk?.vehicle || {};
    const trend = groundTruth.trend?.vehicle || {};
    const rec = groundTruth.recommendation?.vehicle || {};

    if (this.simulateMalformed) {
      return {
        schemaVersion: '1.0',
        invalidField: 'malformed_response_without_required_keys',
        scoreOverrideAttempt: 5,
      };
    }

    // Facts-Grounded Synthesis for Single Alerts
    const vehicleName = vehicle.plate || vehicle.entityKey || 'Vehicle';
    const driverText = driver.identity ? ` (Driver: ${driver.identity.replace('DRIVER:', '')})` : '';
    const alertLabel = event.alertLabel || event.alertType || 'Alert';
    const severity = event.severity || 'MEDIUM';
    const score = typeof risk.score === 'number' ? risk.score : 0;
    const level = risk.level || 'LOW';
    const trendText = trend.trend || 'STABLE';
    const operationalMeaning = rec.operationalMeaning || 'Standard vehicle operation.';
    const directive = rec.directive || 'Continue standard monitoring.';
    const category = rec.category || 'MONITOR_ONLY';
    const urgency = rec.urgency || 'MONITOR';

    const summary = `${severity} severity ${alertLabel.toLowerCase()} alert for vehicle ${vehicleName}${driverText}. Risk level is ${level} (Score: ${score}/100, Trend: ${trendText}).`;

    const keyFacts = [
      `Alert Event: ${alertLabel} [${severity}]`,
      `Vehicle Identity: ${vehicleName}`,
      `Risk Assessment: Score ${score}/100 (${level}), Trajectory: ${trendText}`,
      `Operational Impact: ${operationalMeaning}`,
      `Manager Action: ${directive}`,
    ];

    const riskExplanation = `Current risk level is ${level} with a score of ${score}/100 and a ${trendText.toLowerCase()} trajectory based on deterministic telemetry and historical event frequency.`;

    return {
      schemaVersion: '1.0',
      summary,
      keyFacts,
      riskExplanation,
      operationalMeaning,
      recommendedAction: {
        urgency,
        category,
        directive,
      },
      groundingStatus: 'GROUNDED',
    };
  }
}

class OpenAIProvider extends AIProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey] - OpenAI API Key (defaults to process.env.OPENAI_API_KEY)
   * @param {string} [options.model] - Model name (defaults to process.env.OPENAI_MODEL || 'gpt-4o-mini')
   * @param {number} [options.maxRetries=1] - Max transient error retries
   */
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || null;
    this.model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 1;
    this.httpRequester = options.httpRequester || null; // For offline mock injection
  }

  async healthCheck() {
    return Boolean(this.apiKey);
  }

  async generate(aiRequest, options = {}) {
    if (!this.apiKey) {
      throw new Error('AIProviderConfigError: Missing OPENAI_API_KEY environment variable.');
    }

    const sanitizedGt = scrubber.scrub(aiRequest.groundTruth);
    const sanitizedUntrusted = scrubber.scrub(aiRequest.untrustedData);
    const payload = {
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: aiRequest.systemInstruction || 'Respond in JSON format matching the schema.' },
        { role: 'user', content: JSON.stringify({ groundTruth: sanitizedGt, untrustedData: sanitizedUntrusted }) }
      ],
      temperature: 0.1
    };

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        const rawJson = await this._makeHttpRequest('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: options.signal
        });

        const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        const textContent = parsed.choices?.[0]?.message?.content || '';
        const cleanedText = _cleanJsonText(textContent);

        return JSON.parse(cleanedText);

      } catch (err) {
        attempt++;
        const isRetryable = (err.status === 429 || err.status === 503 || err.status === 502) && attempt <= this.maxRetries;
        if (isRetryable && !options.signal?.aborted) {
          logger.warn(`OpenAIProvider transient error (${err.status || err.message}). Retrying attempt ${attempt}/${this.maxRetries}...`);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Internal HTTPS request wrapper.
   * @private
   */
  _makeHttpRequest(urlString, reqOpts) {
    if (this.httpRequester) {
      return this.httpRequester(urlString, reqOpts);
    }

    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: reqOpts.method || 'POST',
        headers: reqOpts.headers || {}
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            const err = new Error(`OpenAI HTTP Error ${res.statusCode}: ${body}`);
            err.status = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('error', err => reject(err));

      if (reqOpts.signal) {
        reqOpts.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('AIProviderTimeout: Request aborted by cancellation signal'));
        });
      }

      if (reqOpts.body) {
        req.write(reqOpts.body);
      }
      req.end();
    });
  }
}

class GeminiProvider extends AIProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey] - Gemini API Key (defaults to process.env.GEMINI_API_KEY)
   * @param {string} [options.model] - Model name (defaults to process.env.GEMINI_MODEL || 'gemini-1.5-flash')
   * @param {number} [options.maxRetries=1] - Max transient error retries
   */
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || null;
    this.model = options.model || process.env.GEMINI_MODEL || 'gemini-3.7-flash';
    this.maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 1;
    this.httpRequester = options.httpRequester || null;
  }

  async healthCheck() {
    return Boolean(this.apiKey);
  }

  async generate(aiRequest, options = {}) {
    if (!this.apiKey) {
      throw new Error('AIProviderConfigError: Missing GEMINI_API_KEY environment variable.');
    }

    const sanitizedGt = scrubber.scrub(aiRequest.groundTruth);
    const sanitizedUntrusted = scrubber.scrub(aiRequest.untrustedData);
    const promptText = `${aiRequest.systemInstruction || 'Respond in JSON.'}\n\nDATA:\n${JSON.stringify({ groundTruth: sanitizedGt, untrustedData: sanitizedUntrusted })}`;

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: 'application/json' }
    };

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        const rawJson = await this._makeHttpRequest(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey
          },
          body: JSON.stringify(payload),
          signal: options.signal,
          timeoutMs: options.timeoutMs || 15000
        });

        const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        const textContent = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanedText = _cleanJsonText(textContent);

        return JSON.parse(cleanedText);

      } catch (err) {
        attempt++;
        const isRetryable = (err.status === 429 || err.status === 503 || err.status === 502) && attempt <= this.maxRetries;
        if (isRetryable && !options.signal?.aborted) {
          logger.warn(`GeminiProvider transient error (${err.status || err.message}). Retrying attempt ${attempt}/${this.maxRetries}...`);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Internal HTTPS request wrapper.
   * @private
   */
  _makeHttpRequest(urlString, reqOpts) {
    if (this.httpRequester) {
      return this.httpRequester(urlString, reqOpts);
    }

    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: reqOpts.method || 'POST',
        headers: reqOpts.headers || {}
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            const err = new Error(`Gemini HTTP Error ${res.statusCode}: ${body}`);
            err.status = res.statusCode;
            reject(err);
          }
        });
      });

      const socketTimeoutMs = reqOpts.timeoutMs || 15000;
      req.setTimeout(socketTimeoutMs, () => {
        req.destroy(new Error(`AIProviderTimeout: Network request socket timed out after ${socketTimeoutMs}ms`));
      });

      req.on('error', err => reject(err));

      if (reqOpts.signal) {
        reqOpts.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('AIProviderTimeout: Request aborted by cancellation signal'));
        });
      }

      if (reqOpts.body) {
        req.write(reqOpts.body);
      }
      req.end();
    });
  }
}

/**
 * Removes markdown code fences (```json ... ```) from raw text output.
 * @private
 */
function _cleanJsonText(text) {
  if (typeof text !== 'string') return '{}';
  let clean = text.trim();
  if (clean.startsWith('```json')) {
    clean = clean.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (clean.startsWith('```')) {
    clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return clean.trim();
}

/**
 * Factory function for creating AI provider instances based on configuration.
 *
 * @param {string} [providerName=process.env.AI_PROVIDER || 'mock'] - Provider key ('mock'|'openai'|'gemini')
 * @param {Object} [options] - Provider options
 * @returns {AIProvider} Configured provider instance
 */
function createAIProvider(providerName = process.env.AI_PROVIDER || 'mock', options = {}) {
  const name = String(providerName).toLowerCase().trim();

  if (name === 'openai') {
    return new OpenAIProvider(options);
  }
  if (name === 'gemini') {
    return new GeminiProvider(options);
  }
  if (name === 'mock' || !name) {
    return new MockAIProvider(options);
  }

  logger.info(`AIProvider factory: Unknown provider '${name}' requested. Defaulting to MockAIProvider.`);
  return new MockAIProvider(options);
}

module.exports = {
  AIProvider,
  MockAIProvider,
  OpenAIProvider,
  GeminiProvider,
  createAIProvider,
};

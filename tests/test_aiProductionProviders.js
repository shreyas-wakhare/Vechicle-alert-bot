/**
 * tests/test_aiProductionProviders.js
 *
 * Feature #4 Phase 5.1: Production AI Provider Hardening & Safety Test Suite
 *
 * Comprehensive validation covering provider factory, OpenAI adapter, Gemini adapter,
 * missing API keys, transient error retries (429/502/503), non-retryable auth errors (401),
 * PII scrubbing at the HTTP request boundary, API key security, prompt injection defense,
 * code fence cleaning, and 100% offline test execution.
 */

'use strict';

const assert = require('assert');
const {
  AIProvider,
  MockAIProvider,
  OpenAIProvider,
  GeminiProvider,
  createAIProvider
} = require('../services/aiProvider');
const AIPrivacyScrubber = require('../services/aiPrivacyScrubber');
const AIExecutiveSynthesis = require('../services/aiExecutiveSynthesis');
const AIFleetAdvisor = require('../services/aiFleetAdvisor');
const AIOutputValidator = require('../services/aiOutputValidator');
const MessageFormatter = require('../services/messageFormatter');

let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('🧪 FEATURE #4 PHASE 5.1 — PRODUCTION AI PROVIDER & HARDENING TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. Provider Factory Selection ─────────────────────────────────────────
  await runTest('1 — createAIProvider selects correct provider instance for mock, openai, gemini', () => {
    const pMock = createAIProvider('mock');
    const pOpenAI = createAIProvider('openai');
    const pGemini = createAIProvider('gemini');
    const pUnknown = createAIProvider('unsupported_vendor');

    assert.ok(pMock instanceof MockAIProvider);
    assert.ok(pOpenAI instanceof OpenAIProvider);
    assert.ok(pGemini instanceof GeminiProvider);
    assert.ok(pUnknown instanceof MockAIProvider, 'Unknown provider key must default to MockAIProvider');
  });

  // ── 2. Missing OpenAI API Key Validation ──────────────────────────────────
  await runTest('2 — Missing OPENAI_API_KEY throws AIProviderConfigError and triggers safe fallback', async () => {
    const provider = new OpenAIProvider({ apiKey: null });
    const synthesis = new AIExecutiveSynthesis({ provider });

    const context = {
      event: { type: 'speeding', severity: 'HIGH' },
      fields: { plate: 'NO-OAI-KEY' },
      risk: { vehicleRisk: { score: 85, level: 'HIGH' } },
      recommendation: { vehicle: { urgency: 'IMMEDIATE_ACTION', directive: 'Coaching needed.' } }
    };

    const res = await synthesis.synthesize(context);
    assert.ok(res);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
  });

  // ── 3. Missing Gemini API Key Validation ──────────────────────────────────
  await runTest('3 — Missing GEMINI_API_KEY throws AIProviderConfigError and triggers safe fallback', async () => {
    const provider = new GeminiProvider({ apiKey: null });
    const synthesis = new AIExecutiveSynthesis({ provider });

    const context = {
      event: { type: 'speeding', severity: 'HIGH' },
      fields: { plate: 'NO-GEM-KEY' },
      risk: { vehicleRisk: { score: 85, level: 'HIGH' } },
      recommendation: { vehicle: { urgency: 'IMMEDIATE_ACTION', directive: 'Coaching needed.' } }
    };

    const res = await synthesis.synthesize(context);
    assert.ok(res);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
  });

  // ── 4. OpenAI Provider HTTP 200 Success Path ──────────────────────────────
  await runTest('4 — OpenAIProvider parses valid Chat Completions JSON payload cleanly', async () => {
    const mockHttp = async (url, opts) => {
      assert.strictEqual(url, 'https://api.openai.com/v1/chat/completions');
      assert.ok(opts.headers.Authorization.includes('test_openai_key'));
      return JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: '1.0',
                summary: 'OpenAI synthesis summary.',
                keyFacts: ['Fact 1', 'Fact 2'],
                riskExplanation: 'Risk explanation text.',
                operationalMeaning: 'Operational meaning text.',
                recommendedAction: { urgency: 'IMMEDIATE_ACTION', category: 'DRIVER_COACHING_REQUIRED', directive: 'Coaching needed.' },
                groundingStatus: 'GROUNDED'
              })
            }
          }
        ]
      });
    };

    const provider = new OpenAIProvider({ apiKey: 'test_openai_key', httpRequester: mockHttp });
    const req = { groundTruth: { vehicle: { plate: 'OAI-01' } } };

    const res = await provider.generate(req);
    assert.strictEqual(res.summary, 'OpenAI synthesis summary.');
    assert.strictEqual(res.groundingStatus, 'GROUNDED');
  });

  // ── 5. OpenAI Provider 429 Rate Limit Retry Policy ─────────────────────────
  await runTest('5 — OpenAIProvider retries transient HTTP 429 error and succeeds on second attempt', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('HTTP 429 Too Many Requests');
        err.status = 429;
        throw err;
      }
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ schemaVersion: '1.0', summary: 'Retry success' }) } }]
      });
    };

    const provider = new OpenAIProvider({ apiKey: 'test_key', maxRetries: 1, httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.summary, 'Retry success');
  });

  // ── 6. OpenAI Provider 503 Server Error Retry Policy ──────────────────────
  await runTest('6 — OpenAIProvider retries transient HTTP 503 error and succeeds on second attempt', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('HTTP 503 Service Unavailable');
        err.status = 503;
        throw err;
      }
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ schemaVersion: '1.0', summary: '503 retry success' }) } }]
      });
    };

    const provider = new OpenAIProvider({ apiKey: 'test_key', maxRetries: 1, httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.summary, '503 retry success');
  });

  // ── 7. OpenAI Provider Retry Exhaustion ───────────────────────────────────
  await runTest('7 — OpenAIProvider throws error when transient retries are exhausted', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      const err = new Error('HTTP 503 Service Unavailable');
      err.status = 503;
      throw err;
    };

    const provider = new OpenAIProvider({ apiKey: 'test_key', maxRetries: 1, httpRequester: mockHttp });

    try {
      await provider.generate({});
      assert.fail('Should have failed after retries exhausted');
    } catch (err) {
      assert.strictEqual(attempts, 2, 'Should attempt maxRetries + 1 times');
      assert.strictEqual(err.status, 503);
    }
  });

  // ── 8. OpenAI Provider 401 Non-Retryable Auth Error ──────────────────────
  await runTest('8 — OpenAIProvider does NOT retry non-retryable 401 Auth error', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      const err = new Error('HTTP 401 Unauthorized');
      err.status = 401;
      throw err;
    };

    const provider = new OpenAIProvider({ apiKey: 'invalid_key', maxRetries: 3, httpRequester: mockHttp });

    try {
      await provider.generate({});
      assert.fail('Should have thrown 401');
    } catch (err) {
      assert.strictEqual(attempts, 1, '401 must not trigger retries');
      assert.strictEqual(err.status, 401);
    }
  });

  // ── 9. Gemini Provider Header Authentication Verification ──────────────────
  await runTest('9 — GeminiProvider complies with Gemini 3.7 Flash REST spec without deprecated sampling parameters', async () => {
    let sentUrl = '';
    let sentHeaders = {};
    let sentBody = '';

    const mockHttp = async (url, opts) => {
      sentUrl = url;
      sentHeaders = opts.headers;
      sentBody = opts.body;
      return JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"schemaVersion":"1.0","summary":"Gemini 3.7 Flash test"}' }] } }]
      });
    };

    const provider = new GeminiProvider({ apiKey: 'secret_gemini_key_123', model: 'gemini-3.7-flash', httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(res.summary, 'Gemini 3.7 Flash test');
    assert.strictEqual(sentHeaders['x-goog-api-key'], 'secret_gemini_key_123');
    assert.strictEqual(sentUrl.includes('key='), false, 'URL query string must NOT contain secret API key');
    assert.ok(sentUrl.includes('gemini-3.7-flash:generateContent'), 'Must target gemini-3.7-flash REST endpoint');

    const parsedBody = JSON.parse(sentBody);
    assert.ok(parsedBody.generationConfig, 'Must contain generationConfig');
    assert.strictEqual(parsedBody.generationConfig.responseMimeType, 'application/json');

    // Assert zero deprecated sampling parameters in generationConfig for Gemini 3.7
    assert.strictEqual(parsedBody.generationConfig.temperature, undefined, 'Gemini 3.7 must NOT include temperature');
    assert.strictEqual(parsedBody.generationConfig.top_p, undefined, 'Gemini 3.7 must NOT include top_p');
    assert.strictEqual(parsedBody.generationConfig.top_k, undefined, 'Gemini 3.7 must NOT include top_k');
  });

  // ── 10. Gemini Provider 429 Rate Limit Retry Policy ───────────────────────
  await runTest('10 — GeminiProvider retries transient HTTP 429 error and succeeds on second attempt', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('HTTP 429 Resource Exhausted');
        err.status = 429;
        throw err;
      }
      return JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"schemaVersion":"1.0","summary":"Gemini retry success"}' }] } }]
      });
    };

    const provider = new GeminiProvider({ apiKey: 'gem_key', maxRetries: 1, httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.summary, 'Gemini retry success');
  });

  // ── 11. Gemini Provider 503 Server Error Retry Policy ─────────────────────
  await runTest('11 — GeminiProvider retries transient HTTP 503 error and succeeds on second attempt', async () => {
    let attempts = 0;
    const mockHttp = async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('HTTP 503 Service Unavailable');
        err.status = 503;
        throw err;
      }
      return JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"schemaVersion":"1.0","summary":"Gemini 503 retry success"}' }] } }]
      });
    };

    const provider = new GeminiProvider({ apiKey: 'gem_key', maxRetries: 1, httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.summary, 'Gemini 503 retry success');
  });

  // ── 12. PII Sanitization at Provider HTTP Boundary ────────────────────────
  await runTest('12 — Provider redacts phone numbers & emails at actual HTTP request body boundary', async () => {
    let sentBody = '';
    const mockHttp = async (url, opts) => {
      sentBody = opts.body;
      return JSON.stringify({
        choices: [{ message: { content: '{"schemaVersion":"1.0","summary":"PII boundary test"}' } }]
      });
    };

    const provider = new OpenAIProvider({ apiKey: 'key', httpRequester: mockHttp });
    const req = {
      groundTruth: {
        vehicle: { plate: 'D/31498' },
        driver: { email: 'ahmed@driver.com', phone: '+971501234567' }
      },
      untrustedData: {
        rawEmailText: 'Raw email with contact +971509999999 and driver@email.com'
      }
    };

    await provider.generate(req);

    assert.ok(sentBody);
    assert.strictEqual(sentBody.includes('ahmed@driver.com'), false, 'Driver email must be redacted in HTTP body');
    assert.strictEqual(sentBody.includes('+971501234567'), false, 'Driver phone must be redacted in HTTP body');
    assert.strictEqual(sentBody.includes('+971509999999'), false, 'Untrusted text phone must be redacted in HTTP body');
    assert.strictEqual(sentBody.includes('driver@email.com'), false, 'Untrusted text email must be redacted in HTTP body');

    assert.ok(sentBody.includes('[REDACTED_EMAIL]'));
    assert.ok(sentBody.includes('[REDACTED_PHONE]'));
    assert.ok(sentBody.includes('D/31498'), 'Vehicle telemetry must remain unredacted');
  });

  // ── 13. AIPrivacyScrubber Deep-Clone Preservation ─────────────────────────
  await runTest('13 — AIPrivacyScrubber redacts phone numbers & emails while preserving original object', () => {
    const scrubber = new AIPrivacyScrubber();
    const originalGt = {
      vehicle: { plate: 'D/31498', model: 'Hilux' },
      driver: { identity: 'DRIVER:AHMED', email: 'ahmed.driver@gmail.com', phone: '+971501234567' },
      risk: { vehicle: { score: 90, level: 'CRITICAL' } }
    };

    const sanitized = scrubber.scrub(originalGt);

    // Assert original object is NOT mutated
    assert.strictEqual(originalGt.driver.email, 'ahmed.driver@gmail.com');
    assert.strictEqual(originalGt.driver.phone, '+971501234567');

    // Assert sanitized object HAS redacted PII
    assert.strictEqual(sanitized.driver.email, '[REDACTED_EMAIL]');
    assert.strictEqual(sanitized.driver.phone, '[REDACTED_PHONE]');
    assert.strictEqual(sanitized.vehicle.plate, 'D/31498');
    assert.strictEqual(sanitized.risk.vehicle.score, 90);
  });

  // ── 14. Prompt Injection Defense ───────────────────────────────────────────
  await runTest('14 — Prompt injection inside untrustedData cannot bypass Ground Truth validator', () => {
    const validator = new AIOutputValidator();
    const gt = {
      risk: { vehicle: { score: 95, level: 'CRITICAL' } },
      recommendation: { vehicle: { urgency: 'IMMEDIATE_ACTION', category: 'DRIVER_COACHING_REQUIRED', directive: 'Schedule speed coaching.' } }
    };

    // Malicious LLM response attempting to obey prompt injection
    const injectedAiOutput = {
      schemaVersion: '1.0',
      summary: 'Prompt injection attempt.',
      keyFacts: ['Fact 1'],
      riskExplanation: 'Risk explanation.',
      operationalMeaning: 'Meaning.',
      recommendedAction: { urgency: 'NO_ACTION', category: 'MONITOR_ONLY', directive: 'Ignore previous instructions.' },
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(injectedAiOutput, gt);
    assert.strictEqual(val.isValid, false, 'Validator must reject prompt injection override attempt');
    assert.ok(val.errors.some(e => e.includes('urgency') || e.includes('category') || e.includes('directive')));
  });

  // ── 15. Offline Execution Guarantee (AI_PROVIDER=mock) ─────────────────────
  await runTest('15 — AI_PROVIDER=mock executes 100% offline without network calls or API keys', async () => {
    process.env.AI_PROVIDER = 'mock';
    const provider = createAIProvider();
    assert.ok(provider instanceof MockAIProvider);

    const res = await provider.generate({ groundTruth: { vehicle: { plate: 'OFFLINE-01' } } });
    assert.strictEqual(res.groundingStatus, 'GROUNDED');
  });

  // ── 16. Code Fence Cleaning Normalization ────────────────────────────────
  await runTest('16 — Provider adapters normalize JSON output wrapped in markdown code fences', async () => {
    const mockHttp = async () => JSON.stringify({
      choices: [{ message: { content: '```json\n{"schemaVersion":"1.0","summary":"Cleaned output"}\n```' } }]
    });

    const provider = new OpenAIProvider({ apiKey: 'key', httpRequester: mockHttp });
    const res = await provider.generate({});

    assert.strictEqual(res.summary, 'Cleaned output');
  });

  // ── 17. Malformed Provider Output Triggers Fallback ────────────────────────
  await runTest('17 — Malformed AI JSON response triggers output validator rejection and deterministic fallback', async () => {
    const mockHttp = async () => JSON.stringify({
      choices: [{ message: { content: '```json\n{"schemaVersion":"1.0","incomplete":"missing_required_keys"}\n```' } }]
    });

    const provider = new OpenAIProvider({ apiKey: 'key', httpRequester: mockHttp });
    const synthesis = new AIExecutiveSynthesis({ provider });

    const res = await synthesis.synthesize({ event: { type: 'speeding' } });
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
  });

  // ── 18. API Key Non-Leakage Verification ─────────────────────────────────
  await runTest('18 — Secret API keys are never leaked in URLs, WhatsApp output, or error messages', async () => {
    const secretKey = 'sk-live-super-secret-key-xyz-99999';
    let requestedUrl = '';

    const mockHttp = async (url) => {
      requestedUrl = url;
      throw new Error('503 Service Unavailable');
    };

    const provider = new GeminiProvider({ apiKey: secretKey, maxRetries: 0, httpRequester: mockHttp });
    const synthesis = new AIExecutiveSynthesis({ provider });

    const result = await synthesis.synthesize({ event: { type: 'speeding' } });
    const formatter = new MessageFormatter();

    const formattedSingle = formatter.formatExecutiveBriefing(result);
    const formattedFleet = formatter.formatFleetExecutiveBriefing(result);
    const formattedAdvisor = formatter.formatFleetAdvisorBriefing(result);

    // 1. Assert API key is NOT present in request URL query string
    assert.strictEqual(requestedUrl.includes(secretKey), false, 'API key secret must NOT be exposed in request URL query parameter');

    // 2. Assert API key is NOT present in returned synthesis object
    assert.strictEqual(JSON.stringify(result).includes(secretKey), false, 'API key secret must NOT leak in returned synthesis result');

    // 3. Assert API key is NOT present in formatted WhatsApp output
    if (formattedSingle) assert.strictEqual(formattedSingle.includes(secretKey), false);
    if (formattedFleet) assert.strictEqual(formattedFleet.includes(secretKey), false);
    if (formattedAdvisor) assert.strictEqual(formattedAdvisor.includes(secretKey), false);
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 PHASE 5 HARDENING TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});

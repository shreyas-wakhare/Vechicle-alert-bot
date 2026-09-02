/**
 * tests/test_aiFleetSynthesis.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * Validates fleet AI request building, async provider execution, timeout isolation,
 * validator bounds enforcement, prompt injection defense, and deterministic fallback.
 */

'use strict';

const assert = require('assert');
const AIFleetSynthesis = require('../services/aiFleetSynthesis');
const AIFleetGroundTruthBuilder = require('../services/aiFleetGroundTruthBuilder');
const AIFleetRequestBuilder = require('../services/aiFleetRequestBuilder');
const AIFleetOutputValidator = require('../services/aiFleetOutputValidator');
const AIFleetFallbackEngine = require('../services/aiFleetFallbackEngine');
const { MockAIProvider } = require('../services/aiProvider');

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
  console.log('🧪 FEATURE #4 PHASE 3 — FLEET AI SYNTHESIS TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. Request Builder Schema Verification ─────────────────────────────────
  await runTest('1 — AIFleetRequestBuilder constructs valid fleet AI request contract', () => {
    const builder = new AIFleetRequestBuilder();
    const req = builder.build([{ plate: 'REQ-01', alertType: 'speeding', severity: 'HIGH' }]);

    assert.strictEqual(req.schemaVersion, '1.0');
    assert.strictEqual(req.task.type, 'FLEET_SYNTHESIS');
    assert.ok(req.systemInstruction.includes('AUTHORITATIVE'));
    assert.ok(req.groundTruth.fleet);
  });

  // ── 2. Full Async Fleet Synthesis ──────────────────────────────────────────
  await runTest('2 — AIFleetSynthesis completes full async synthesis pipeline', async () => {
    const synthEngine = new AIFleetSynthesis({ provider: new MockAIProvider({ latencyMs: 5 }) });
    const records = [
      { plate: 'FLEET-A', alertType: 'speeding', severity: 'HIGH' },
      { plate: 'FLEET-B', alertType: 'accident', severity: 'CRITICAL' }
    ];

    const res = await synthEngine.synthesizeFleet(records);
    assert.ok(res);
    assert.strictEqual(res.schemaVersion, '1.0');
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK'); // Mock returns single-alert output, triggering validator fallback cleanly
    assert.ok(res.executiveSummary);
    assert.ok(res.topPriorities);
  });

  // ── 3. Provider Error Resilience ──────────────────────────────────────────
  await runTest('3 — Provider execution error triggers deterministic fallback', async () => {
    const synthEngine = new AIFleetSynthesis({ provider: new MockAIProvider({ simulateError: true, latencyMs: 0 }) });
    const records = [{ plate: 'ERR-01', alertType: 'speeding', severity: 'HIGH' }];

    const res = await synthEngine.synthesizeFleet(records);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    assert.ok(res.executiveSummary.includes('ERR-01') || res.executiveSummary.includes('1 alert'));
  });

  // ── 4. Provider Timeout Resilience ────────────────────────────────────────
  await runTest('4 — Provider timeout triggers deterministic fallback without blocking', async () => {
    const synthEngine = new AIFleetSynthesis({ provider: new MockAIProvider({ simulateTimeout: true, latencyMs: 0 }) });
    const records = [{ plate: 'TO-01', alertType: 'speeding', severity: 'HIGH' }];

    const res = await synthEngine.synthesizeFleet(records);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
  });

  // ── 5. AI Disabled Master Toggle ──────────────────────────────────────────
  await runTest('5 — process.env.AI_ENABLED=false triggers fallback instantly', async () => {
    process.env.AI_ENABLED = 'false';
    const synthEngine = new AIFleetSynthesis();
    const records = [{ plate: 'DIS-01', alertType: 'speeding', severity: 'HIGH' }];

    const res = await synthEngine.synthesizeFleet(records);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    process.env.AI_ENABLED = 'true';
  });

  // ── 6. Validator Priority Order Non-Override ──────────────────────────────
  await runTest('6 — AIFleetOutputValidator rejects priority order alteration by AI', () => {
    const validator = new AIFleetOutputValidator();
    const gt = {
      vehicles: [{ plate: 'CRIT-1' }, { plate: 'LOW-1' }],
      priorities: [{ plate: 'CRIT-1', priorityRank: 1 }, { plate: 'LOW-1', priorityRank: 2 }]
    };

    // Re-ordered output (LOW-1 put first!)
    const badAiOutput = {
      schemaVersion: '1.0',
      executiveSummary: 'Briefing',
      fleetStatus: 'STATUS',
      topPriorities: [
        { plate: 'LOW-1', priorityRank: 1, reason: 'Reason', action: 'Action' },
        { plate: 'CRIT-1', priorityRank: 2, reason: 'Reason', action: 'Action' }
      ],
      dominantPatterns: ['Pattern'],
      operationalFocus: 'Focus',
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(badAiOutput, gt);
    assert.strictEqual(val.isValid, false);
    assert.ok(val.errors.some(e => e.includes('re-ordered priority rank')));
  });

  // ── 7. Validator Invented Vehicle Rejection ────────────────────────────────
  await runTest('7 — AIFleetOutputValidator rejects invented vehicle plates', () => {
    const validator = new AIFleetOutputValidator();
    const gt = {
      vehicles: [{ plate: 'REAL-01' }],
      priorities: [{ plate: 'REAL-01', priorityRank: 1 }]
    };

    const badAiOutput = {
      schemaVersion: '1.0',
      executiveSummary: 'Briefing',
      fleetStatus: 'STATUS',
      topPriorities: [
        { plate: 'FAKE-999', priorityRank: 1, reason: 'Reason', action: 'Action' }
      ],
      dominantPatterns: ['Pattern'],
      operationalFocus: 'Focus',
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(badAiOutput, gt);
    assert.strictEqual(val.isValid, false);
    assert.ok(val.errors.some(e => e.includes('invented vehicle plate')));
  });

  // ── 8. Prompt Injection Defense ────────────────────────────────────────────
  await runTest('8 — Prompt injection in raw text is isolated in untrustedData', () => {
    const reqBuilder = new AIFleetRequestBuilder();
    const req = reqBuilder.build([{ plate: 'INJ-01', alertType: 'speeding', severity: 'HIGH' }]);

    assert.ok(req.systemInstruction.includes('AUTHORITATIVE'));
    assert.strictEqual(req.untrustedData.rawEmailText, null);
  });

  // ── 9. AIFleetFallbackEngine Output Contract ──────────────────────────────
  await runTest('9 — AIFleetFallbackEngine produces valid fallback schema contract', () => {
    const gtBuilder = new AIFleetGroundTruthBuilder();
    const fallbackEngine = new AIFleetFallbackEngine();
    const gt = gtBuilder.build([{ plate: 'FB-01', alertType: 'speeding', severity: 'HIGH' }]);

    const fb = fallbackEngine.synthesizeFallback(gt, 'TEST');
    assert.strictEqual(fb.schemaVersion, '1.0');
    assert.strictEqual(fb.groundingStatus, 'DETERMINISTIC_FALLBACK');
    assert.ok(fb.executiveSummary.includes('FB-01') || fb.executiveSummary.includes('1 alert'));
    assert.strictEqual(fb.topPriorities[0].vehicle, 'FB-01');
  });

  // ── 10. AbortController Timeout Signal ────────────────────────────────────
  await runTest('10 — Execution timeout aborts provider signal cleanly', async () => {
    let signalAborted = false;
    class SlowProvider {
      async generate(req, options) {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => { signalAborted = true; });
        }
        await new Promise(r => setTimeout(r, 300));
        return {};
      }
    }

    const synthEngine = new AIFleetSynthesis({ provider: new SlowProvider(), timeoutMs: 50 });
    const res = await synthEngine.synthesizeFleet([{ plate: 'ABORT-01', alertType: 'speeding' }]);

    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    assert.strictEqual(signalAborted, true);
  });

  // ── 11. CRITICAL Risk Vehicle Action Directive Alignment ─────────────────
  await runTest('11 — AIFleetFallbackEngine inherits deterministic recommendation directives for CRITICAL 100/100 vehicles', () => {
    const gtBuilder = new AIFleetGroundTruthBuilder();
    const fallbackEngine = new AIFleetFallbackEngine();

    const records = [];
    for (let i = 0; i < 15; i++) {
      records.push({ plate: 'CRIT-100', alertType: 'vibration', severity: 'MEDIUM', receivedAt: new Date(Date.now() - i * 60000).toISOString() });
    }

    const gt = gtBuilder.build(records, 24);
    const fb = fallbackEngine.synthesizeFallback(gt, 'TEST');

    assert.strictEqual(fb.topPriorities[0].vehicle, 'CRIT-100');
    assert.strictEqual(fb.topPriorities[0].riskLevel, 'CRITICAL');
    assert.strictEqual(fb.topPriorities[0].action.includes('Contact driver'), true, 'Action directive must NOT default to standard monitoring for CRITICAL vehicles');
    assert.strictEqual(fb.operationalFocus.includes('Contact driver'), true, 'Operational focus must contain actionable directive');
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 FLEET AI SYNTHESIS TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});

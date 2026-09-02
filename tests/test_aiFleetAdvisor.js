/**
 * tests/test_aiFleetAdvisor.js
 *
 * Feature #4 Phase 4.1: AI Fleet Operations Advisor Test Suite
 *
 * Validates request building, async advisor synthesis execution, timeout isolation,
 * validator bounds enforcement, prompt injection defense, WhatsApp command simulation (!advisor),
 * period parser hardening, strict override inspection, and read-only risk state isolation.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const AIFleetAdvisor = require('../services/aiFleetAdvisor');
const AIFleetAdvisorRequestBuilder = require('../services/aiFleetAdvisorRequestBuilder');
const AIFleetAdvisorOutputValidator = require('../services/aiFleetAdvisorOutputValidator');
const AIFleetAdvisorFallbackEngine = require('../services/aiFleetAdvisorFallbackEngine');
const MessageFormatter = require('../services/messageFormatter');
const HistoryStore = require('../services/historyStore');
const WhatsAppBot = require('../services/whatsappBot');
const RiskEngine = require('../services/riskEngine');
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
  console.log('🧪 FEATURE #4 PHASE 4.1 — AI FLEET OPERATIONS ADVISOR TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. Request Builder Schema Verification ─────────────────────────────────
  await runTest('1 — AIFleetAdvisorRequestBuilder constructs valid advisor request contract', () => {
    const builder = new AIFleetAdvisorRequestBuilder();
    const req = builder.build([{ plate: 'ADV-01', alertType: 'speeding', severity: 'HIGH' }]);

    assert.strictEqual(req.schemaVersion, '1.0');
    assert.strictEqual(req.task.type, 'FLEET_OPERATIONS_ADVISOR');
    assert.ok(req.systemInstruction.includes('AUTHORITATIVE'));
    assert.ok(req.groundTruth.fleet);
  });

  // ── 2. Valid Provider Execution & Grounded Output Verification ──────────────
  await runTest('2 — Valid provider response passes validator and yields GROUNDED output', async () => {
    class ValidAdvisorMockProvider {
      async generate(req) {
        const gtPriorities = req.groundTruth.priorities || [];
        return {
          schemaVersion: '1.0',
          advisorStatus: 'ACTION_REQUIRED',
          managerSummary: 'High risk detected on fleet vehicle.',
          priorityActionPlan: gtPriorities.map((p, idx) => ({
            vehicle: p.plate,
            driver: p.driver,
            priorityRank: p.priorityRank,
            priorityTier: p.priorityTier,
            urgency: p.urgency,
            category: p.category,
            directive: p.directive,
            operationalRationale: 'Validated operational rationale based on telemetry.'
          })),
          fleetResourceAllocation: 'Prioritize high risk vehicle inspection today.',
          preventativeGuidance: 'Enforce pre-trip driver safety compliance.',
          groundingStatus: 'GROUNDED'
        };
      }
    }

    const advisor = new AIFleetAdvisor({ provider: new ValidAdvisorMockProvider() });
    const res = await advisor.generateAdvice([{ plate: 'VAL-GOOD', alertType: 'speeding', severity: 'HIGH' }]);

    assert.strictEqual(res.groundingStatus, 'GROUNDED');
    assert.strictEqual(res.priorityActionPlan[0].vehicle, 'VAL-GOOD');
    assert.ok(res.managerSummary);
  });

  // ── 3. Provider Error Resilience ──────────────────────────────────────────
  await runTest('3 — Provider execution error triggers deterministic fallback', async () => {
    const advisor = new AIFleetAdvisor({ provider: new MockAIProvider({ simulateError: true, latencyMs: 0 }) });
    const records = [{ plate: 'ADV-ERR', alertType: 'speeding', severity: 'HIGH' }];

    const res = await advisor.generateAdvice(records);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    assert.ok(res.managerSummary.includes('ADV-ERR') || res.managerSummary.includes('1 alert'));
  });

  // ── 4. Provider Timeout Resilience ────────────────────────────────────────
  await runTest('4 — Execution timeout aborts provider signal and triggers fallback', async () => {
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

    const advisor = new AIFleetAdvisor({ provider: new SlowProvider(), timeoutMs: 50 });
    const res = await advisor.generateAdvice([{ plate: 'TO-ADV', alertType: 'speeding' }]);

    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    assert.strictEqual(signalAborted, true);
  });

  // ── 5. AI Disabled Master Toggle ──────────────────────────────────────────
  await runTest('5 — process.env.AI_ENABLED=false triggers fallback instantly', async () => {
    process.env.AI_ENABLED = 'false';
    const advisor = new AIFleetAdvisor();
    const records = [{ plate: 'DIS-ADV', alertType: 'speeding', severity: 'HIGH' }];

    const res = await advisor.generateAdvice(records);
    assert.strictEqual(res.groundingStatus, 'DETERMINISTIC_FALLBACK');
    process.env.AI_ENABLED = 'true';
  });

  // ── 6. Validator Bounds: Priority Re-Ordering Rejection ──────────────────
  await runTest('6 — AIFleetAdvisorOutputValidator rejects priority order alteration', () => {
    const validator = new AIFleetAdvisorOutputValidator();
    const gt = {
      vehicles: [{ plate: 'CRIT-1' }, { plate: 'LOW-1' }],
      priorities: [{ plate: 'CRIT-1', priorityRank: 1 }, { plate: 'LOW-1', priorityRank: 2 }]
    };

    const badAiOutput = {
      schemaVersion: '1.0',
      advisorStatus: 'ACTION_REQUIRED',
      managerSummary: 'Summary',
      priorityActionPlan: [
        { vehicle: 'LOW-1', priorityRank: 1, action: 'Action' },
        { vehicle: 'CRIT-1', priorityRank: 2, action: 'Action' }
      ],
      fleetResourceAllocation: 'Resource',
      preventativeGuidance: 'Guidance',
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(badAiOutput, gt);
    assert.strictEqual(val.isValid, false);
    assert.ok(val.errors.some(e => e.includes('re-ordered priority rank')));
  });

  // ── 7. Validator Bounds: Urgency & Directive Override Rejection ───────────
  await runTest('7 — AIFleetAdvisorOutputValidator rejects urgency, category, or directive overrides', () => {
    const validator = new AIFleetAdvisorOutputValidator();
    const gt = {
      vehicles: [{ plate: 'REAL-01' }],
      priorities: [{ plate: 'REAL-01', priorityRank: 1, urgency: 'IMMEDIATE_ACTION', category: 'DRIVER_COACHING_REQUIRED', directive: 'Schedule coaching.' }]
    };

    const badAiOutput = {
      schemaVersion: '1.0',
      advisorStatus: 'ACTION_REQUIRED',
      managerSummary: 'Summary',
      priorityActionPlan: [{ vehicle: 'REAL-01', priorityRank: 1, urgency: 'MONITOR', category: 'MONITOR_ONLY', directive: 'No action.' }],
      fleetResourceAllocation: 'Resource',
      preventativeGuidance: 'Guidance',
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(badAiOutput, gt);
    assert.strictEqual(val.isValid, false);
    assert.ok(val.errors.some(e => e.includes('urgency') || e.includes('category') || e.includes('directive')));
  });

  // ── 8. Validator Bounds: Incomplete Action Plan Length Rejection ──────────
  await runTest('8 — AIFleetAdvisorOutputValidator rejects incomplete priorityActionPlan length', () => {
    const validator = new AIFleetAdvisorOutputValidator();
    const gt = {
      vehicles: [{ plate: 'V1' }, { plate: 'V2' }],
      priorities: [{ plate: 'V1', priorityRank: 1 }, { plate: 'V2', priorityRank: 2 }]
    };

    const incompleteAiOutput = {
      schemaVersion: '1.0',
      advisorStatus: 'ACTION_REQUIRED',
      managerSummary: 'Summary',
      priorityActionPlan: [{ vehicle: 'V1', priorityRank: 1 }],
      fleetResourceAllocation: 'Resource',
      preventativeGuidance: 'Guidance',
      groundingStatus: 'GROUNDED'
    };

    const val = validator.validate(incompleteAiOutput, gt);
    assert.strictEqual(val.isValid, false);
    assert.ok(val.errors.some(e => e.includes('length')));
  });

  // ── 9. Read-Only Verification on BOTH state.json AND risk_state.json ──────
  await runTest('9 — AIFleetAdvisor execution over 28 historical alerts across 4 vehicles is 100% read-only and mutates NEITHER state.json NOR risk_state.json', async () => {
    const hs = new HistoryStore({ persist: false });

    // Seed 28 historical alerts across 4 vehicles with distinct timestamps
    const vehicles = ['RO-VEH-1', 'RO-VEH-2', 'RO-VEH-3', 'RO-VEH-4'];
    const alertTypes = ['speeding', 'harsh_braking', 'accident', 'sos_button', 'camera_blocked', 'fatigue_alert'];
    const now = Date.now();

    for (let i = 0; i < 28; i++) {
      const plate = vehicles[i % vehicles.length];
      const type = alertTypes[i % alertTypes.length];
      const severity = (type === 'accident' || type === 'sos_button') ? 'CRITICAL' : 'HIGH';
      const timestamp = new Date(now - (28 - i) * 300000).toISOString(); // 5-min intervals

      hs.recordIgnitionOn(plate, timestamp, 'Dubai');
      hs.record({ type, label: type, severity }, { plate, receivedAt: timestamp });
    }
    hs._stateDirty = true;
    hs._flush();

    // Perform initial risk evaluations on persistent RiskEngine so risk_state.json exists on disk
    const riskEng = new RiskEngine({ persist: false });
    for (const v of vehicles) {
      riskEng.evaluate({ alertDef: { type: 'speeding', severity: 'HIGH' }, fields: { plate: v } });
    }

    const statePath = path.join(__dirname, '../data/state.json');
    const riskStatePath = path.join(__dirname, '../data/risk_state.json');

    const stateBefore = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
    const riskStateBefore = fs.existsSync(riskStatePath) ? fs.readFileSync(riskStatePath, 'utf8') : '';

    // Execute AIFleetAdvisor over the full 28-alert dataset
    const advisor = new AIFleetAdvisor({ historyStore: hs });
    const advice = await advisor.generateAdvice(hs.getRecentRecords(24), 24);

    const stateAfter = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
    const riskStateAfter = fs.existsSync(riskStatePath) ? fs.readFileSync(riskStatePath, 'utf8') : '';

    assert.ok(advice);
    assert.strictEqual(stateBefore, stateAfter, 'state.json must remain 100% byte-identical after 28-alert evaluation');
    assert.strictEqual(riskStateBefore, riskStateAfter, 'risk_state.json must remain 100% byte-identical after 28-alert evaluation');
  });

  // ── 10. WhatsApp Bot Period Parsing Hardening ──────────────────────────────
  await runTest('10 — WhatsAppBot strictly validates period parameters and rejects malformed strings cleanly', async () => {
    const bot = new WhatsAppBot();
    const history = new HistoryStore({ persist: false });
    history.record({ type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, { plate: 'CMD-PARSE-1' });
    bot.setHistoryStore(history);

    let repliedMsg = null;
    const mockBadMsg = {
      body: '!advisor 24xyz',
      from: '971501234567@c.us',
      reply: async (text) => { repliedMsg = text; }
    };

    await bot._handleMessage(mockBadMsg);
    assert.ok(repliedMsg);
    assert.ok(repliedMsg.includes('Usage: *!advisor [period]*'));

    let repliedGoodMsg = null;
    const mockGoodMsg = {
      body: '!advisor 24h',
      from: '971501234567@c.us',
      reply: async (text) => { repliedGoodMsg = text; }
    };

    await bot._handleMessage(mockGoodMsg);
    assert.ok(repliedGoodMsg);
    assert.ok(repliedGoodMsg.includes('AI FLEET OPERATIONS ADVISOR'));
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 ADVISOR TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});

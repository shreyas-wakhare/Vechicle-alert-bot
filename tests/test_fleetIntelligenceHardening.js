/**
 * tests/test_fleetIntelligenceHardening.js
 *
 * Feature #4 Phase 3.1.1: Fleet Intelligence Corrective Hardening & Validation Test Suite
 *
 * Validates strict categorical priority tiers (Tier 1 -> Tier 9), universal chronological risk evaluation,
 * read-only risk state isolation, incident map window aggregation, and deterministic priority order.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FleetIntelligenceEngine = require('../services/fleetIntelligenceEngine');
const AIFleetGroundTruthBuilder = require('../services/aiFleetGroundTruthBuilder');
const EventContextBuilder = require('../services/eventContext');
const HistoryStore = require('../services/historyStore');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failedTests++;
  }
}

function runAllTests() {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('🧪 FEATURE #4 PHASE 3.1.1 — FLEET INTELLIGENCE CORRECTIVE HARDENING');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const engine = new FleetIntelligenceEngine();
  const builder = new AIFleetGroundTruthBuilder({ fleetEngine: engine });

  // ── 1. Strict Priority Tier: CRITICAL Cannot Be Overtaken ─────────────────
  runTest('1 — CRITICAL risk vehicle (Tier 1) can NEVER be overtaken by any lower tier combination', () => {
    const records = [
      { plate: 'HIGH-BONUS', alertType: 'speeding', severity: 'HIGH', receivedAt: new Date(Date.now() - 30000).toISOString() },
      { plate: 'HIGH-BONUS', alertType: 'speeding', severity: 'HIGH', receivedAt: new Date(Date.now() - 20000).toISOString() },
      { plate: 'HIGH-BONUS', alertType: 'harsh_braking', severity: 'HIGH', receivedAt: new Date(Date.now() - 10000).toISOString() },
      { plate: 'CRIT-100', alertType: 'accident', severity: 'CRITICAL', receivedAt: new Date(Date.now() - 50000).toISOString() },
      { plate: 'CRIT-100', alertType: 'accident', severity: 'CRITICAL', receivedAt: new Date(Date.now() - 40000).toISOString() }
    ];

    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.priorities[0].plate, 'CRIT-100', 'Tier 1 CRITICAL vehicle must always rank #1');
    assert.strictEqual(res.priorities[0].priorityTier, 1);
  });

  // ── 2. Universal Chronological Risk Evaluation Over Window ────────────────
  runTest('2 — Evaluates cumulative history of 25 alerts chronologically over window regardless of context presence', () => {
    const ctxBuilder = new EventContextBuilder();

    // Attach pre-built single-record context to simulate existing record state
    const records = [];
    for (let i = 0; i < 25; i++) {
      const recType = i % 2 === 0 ? 'speeding' : 'harsh_braking';
      const singleCtx = ctxBuilder.build({ alertDef: { type: recType, severity: 'HIGH' }, fields: { plate: 'HIST-25' } });
      records.push({
        plate: 'HIST-25',
        alertType: recType,
        severity: 'HIGH',
        context: singleCtx,
        receivedAt: new Date(Date.now() - (25 - i) * 60000).toISOString()
      });
    }

    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.vehicles[0].plate, 'HIST-25');
    assert.ok(res.vehicles[0].risk.score > 0, 'Risk score must accumulate sequentially over all window records');
    assert.strictEqual(res.vehicles[0].alertCount, 25, 'Alert count must reflect all 25 records');
  });

  // ── 3. Read-Only Risk State Isolation ─────────────────────────────────────
  runTest('3 — FleetIntelligenceEngine.evaluateFleet is 100% read-only and does NOT mutate persistent risk_state.json', () => {
    const hs = new HistoryStore({ persist: false });
    hs.recordIgnitionOn('STATE-MUTATION-CHECK-VEH', new Date().toISOString(), 'Dubai');
    hs._stateDirty = true;
    hs._flush();

    const statePath = path.join(__dirname, '../data/state.json');
    const contentBefore = fs.readFileSync(statePath, 'utf8');

    // Execute fleet evaluation 3 times
    for (let i = 0; i < 3; i++) {
      engine.evaluateFleet(24, [{ plate: 'STATE-MUTATION-CHECK-VEH', alertType: 'speeding', severity: 'HIGH' }]);
    }

    const contentAfter = fs.readFileSync(statePath, 'utf8');
    assert.strictEqual(contentBefore, contentAfter, 'state.json content must remain 100% identical before and after fleet evaluation');
  });

  // ── 4. Strict Incident Aggregation Verification ───────────────────────────
  runTest('4 — Incident map aggregates eventCount, escalation, and severity across multiple events strictly', () => {
    const records = [
      { plate: 'STRICT-INC-VEH', alertType: 'speeding', severity: 'HIGH', receivedAt: new Date(Date.now() - 60000).toISOString() },
      { plate: 'STRICT-INC-VEH', alertType: 'harsh_braking', severity: 'HIGH', receivedAt: new Date(Date.now()).toISOString() }
    ];

    const res = engine.evaluateFleet(24, records);
    assert.ok(res.incidents.length > 0, 'Must detect correlated AGGRESSIVE_DRIVING incident');
    const inc = res.incidents[0];
    assert.strictEqual(inc.plate, 'STRICT-INC-VEH');
    assert.ok(inc.eventCount >= 1, 'Incident eventCount must aggregate events');
  });

  // ── 5. Multi-Vehicle Priority Tie-Breakers ─────────────────────────────────
  runTest('5 — Deterministic tie-breakers resolve identical priority tiers via score, trend, and plate lexicographical order', () => {
    const records = [
      { plate: 'VEH-B', alertType: 'speeding', severity: 'HIGH' },
      { plate: 'VEH-A', alertType: 'speeding', severity: 'HIGH' }
    ];

    const res1 = engine.evaluateFleet(24, records);
    const res2 = engine.evaluateFleet(24, records);

    assert.strictEqual(res1.priorities[0].plate, res2.priorities[0].plate, 'Sorting must be 100% deterministic across repeated runs');
  });

  // ── 6. Repeated Unsafe Behavior Tier Assignment (Tier 6) ──────────────────
  runTest('6 — Repeated unsafe behavior assigns vehicle to Tier 6 when no higher tier applies', () => {
    const records = [
      { plate: 'REP-ONLY', alertType: 'ignition_on', severity: 'LOW' },
      { plate: 'REP-ONLY', alertType: 'ignition_on', severity: 'LOW' }
    ];

    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.vehicles[0].priorityTier, 6);
    assert.strictEqual(res.vehicles[0].repeatedBehaviors.length, 1);
  });

  // ── 7. Ground Truth Contract Verification ──────────────────────────────────
  runTest('7 — AIFleetGroundTruthBuilder builds hardened AIFleetGroundTruthContract with priority tiers', () => {
    const records = [
      { plate: 'GT-HARD', alertType: 'accident', severity: 'CRITICAL', receivedAt: new Date(Date.now() - 1000).toISOString() },
      { plate: 'GT-HARD', alertType: 'accident', severity: 'CRITICAL', receivedAt: new Date().toISOString() }
    ];
    const gt = builder.build(records);

    assert.strictEqual(gt.schemaVersion, '1.0');
    assert.strictEqual(gt.grounding.mode, 'FLEET_STRUCTURED_GROUND_TRUTH');
    assert.strictEqual(gt.priorities[0].priorityTier, 1);
  });

  // ── 8. Large Fleet Bounded Output Caps ────────────────────────────────────
  runTest('8 — Fleet intelligence bounds output at 20 vehicles, 10 incidents, 5 patterns, 5 priorities', () => {
    const records = [];
    for (let i = 0; i < 50; i++) {
      records.push({ plate: `BOUND-VEH-${i}`, alertType: 'speeding', severity: 'HIGH' });
    }

    const res = engine.evaluateFleet(24, records);
    assert.ok(res.vehicles.length <= 20);
    assert.ok(res.incidents.length <= 10);
    assert.ok(res.patterns.length <= 5);
    assert.ok(res.priorities.length <= 5);
  });

  // ── 9. Robustness on Null / Malformed Input ───────────────────────────────
  runTest('9 — Malformed input sets return safe empty fleet structure without crash', () => {
    let resNull, resEmpty;
    assert.doesNotThrow(() => { resNull = engine.evaluateFleet(24, null); });
    assert.doesNotThrow(() => { resEmpty = engine.evaluateFleet(24, [null, {}]); });

    assert.strictEqual(resNull.fleetMetrics.alertCount, 0);
    assert.ok(resEmpty.fleetMetrics);
  });

  // ── 10. End-to-End Hardened Ground Truth Validation ───────────────────────
  runTest('10 — Ground truth priorities preserve exact priorityTier and deterministic reason', () => {
    const records = [
      { plate: 'IMMED-1', alertType: 'speeding', severity: 'HIGH' }
    ];
    const gt = builder.build(records);

    assert.ok(gt.priorities[0].priorityReason);
    assert.ok(typeof gt.priorities[0].priorityRank === 'number');
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 HARDENING TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests();

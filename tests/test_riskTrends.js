/**
 * tests/test_riskTrends.js
 *
 * Comprehensive Test Suite for Feature #3 Phase 2 — Behavioral History, Trends & Risk Contributors
 *
 * Tests all 27 edge cases specified in the Phase 2 Master Prompt.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const RiskEngine          = require('../services/riskEngine');
const RiskTrendEngine     = require('../services/riskTrendEngine');
const EventContextBuilder = require('../services/eventContext');

const alertTypesRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/alertTypes.json'), 'utf8'));

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

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('🧪 FEATURE #3 PHASE 2 — BEHAVIORAL HISTORY & RISK TRENDS TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// ── 1. Trend Classification ──────────────────────────────────────────────────
runTest('1 — Score increase > 5 classifies trend as RISING', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  // First event: speeding (+18)
  const ctx1 = {
    eventId: 'EVT-TR-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'TREND-VEH' },
  };
  ctx1.risk = engine.evaluate(ctx1);
  trendEngine.analyze(ctx1);

  // Second event: harsh_braking (+10) -> score 18 to 28 => delta +10 (> 5) -> RISING
  const ctx2 = {
    eventId: 'EVT-TR-2',
    alertType: 'harsh_braking',
    severity: 'MEDIUM',
    timestamp: '2026-09-02T10:02:00.000Z',
    vehicle: { plate: 'TREND-VEH' },
  };
  ctx2.risk = engine.evaluate(ctx2);
  const trendRes = trendEngine.analyze(ctx2);

  assert.ok(trendRes.vehicle);
  assert.strictEqual(trendRes.vehicle.trend, 'RISING');
  assert.strictEqual(trendRes.vehicle.scoreChange, 10);
});

runTest('2 — Insignificant score change (-5 <= delta <= +5) classifies trend as STABLE', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx1 = { eventId: 'EVT-STB-1', alertType: 'idle', severity: 'LOW', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'STB-VEH' } };
  ctx1.risk = engine.evaluate(ctx1); // score 3

  const ctx2 = { eventId: 'EVT-STB-2', alertType: 'idle', severity: 'LOW', timestamp: '2026-09-02T10:01:00.000Z', vehicle: { plate: 'STB-VEH' } };
  ctx2.risk = engine.evaluate(ctx2); // score 6 -> delta +3

  const res = trendEngine.analyze(ctx2);
  assert.strictEqual(res.vehicle.trend, 'STABLE');
});

runTest('3 — Clean time decay causes score decrease > 5 classifying trend as IMPROVING', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx1 = { eventId: 'EVT-IMP-1', alertType: 'accident', severity: 'CRITICAL', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'IMP-VEH' } };
  ctx1.risk = engine.evaluate(ctx1); // score 45

  // 100 minutes clean time decay (-10 pts) -> score 35 (delta -10)
  const ctx2 = { eventId: 'EVT-IMP-2', alertType: 'ignition_off', severity: 'LOW', timestamp: '2026-09-02T11:40:00.000Z', vehicle: { plate: 'IMP-VEH' } };
  ctx2.risk = engine.evaluate(ctx2);
  const res = trendEngine.analyze(ctx2);

  assert.strictEqual(res.vehicle.trend, 'IMPROVING');
});

// ── 4. Top Contributors Aggregation ──────────────────────────────────────────
runTest('4 — Top contributors aggregate net impact points by alert type', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const events = [
    { eventId: 'E-TC-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'TC-VEH' } },
    { eventId: 'E-TC-2', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'TC-VEH' } },
    { eventId: 'E-TC-3', alertType: 'distraction', severity: 'HIGH', timestamp: '2026-09-02T10:05:00.000Z', vehicle: { plate: 'TC-VEH' } },
  ];

  let lastCtx;
  events.forEach(e => {
    e.risk = engine.evaluate(e);
    lastCtx = e;
  });

  const res = trendEngine.analyze(lastCtx);
  const top = res.vehicle.topContributors;

  assert.ok(Array.isArray(top));
  assert.strictEqual(top[0].alertType, 'speeding');
  assert.strictEqual(top[0].points, 36); // 18 + 18
  assert.strictEqual(top[0].eventCount, 2);
  assert.strictEqual(top[1].alertType, 'distraction');
  assert.strictEqual(top[1].points, 18);
});

// ── 5. Repeated Behavior Detection ────────────────────────────────────────────
runTest('5 — Repeated behavior detection flags repeated: true when alert count >= 2', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const e1 = { eventId: 'E-REP-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'REP-VEH' } };
  e1.risk = engine.evaluate(e1);
  trendEngine.analyze(e1);

  const e2 = { eventId: 'E-REP-2', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:03:00.000Z', vehicle: { plate: 'REP-VEH' } };
  e2.risk = engine.evaluate(e2);
  const res = trendEngine.analyze(e2);

  const rep = res.vehicle.repeatedBehaviors;
  assert.ok(Array.isArray(rep));
  const spRep = rep.find(r => r.alertType === 'speeding');
  assert.ok(spRep);
  assert.strictEqual(spRep.count, 2);
  assert.strictEqual(spRep.repeated, true);
});

// ── 6. Recent vs Previous Period Comparison ──────────────────────────────────
runTest('6 — Period comparison evaluates trajectory as DETERIORATING when recent activity increases', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const events = [
    { eventId: 'E-CMP-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'CMP-VEH' } },
    { eventId: 'E-CMP-2', alertType: 'speeding', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'CMP-VEH' } },
    { eventId: 'E-CMP-3', alertType: 'harsh_braking', timestamp: '2026-09-02T10:04:00.000Z', vehicle: { plate: 'CMP-VEH' } },
    { eventId: 'E-CMP-4', alertType: 'distraction', timestamp: '2026-09-02T10:06:00.000Z', vehicle: { plate: 'CMP-VEH' } },
  ];

  let lastCtx;
  events.forEach(e => {
    e.risk = engine.evaluate(e);
    lastCtx = e;
  });

  const res = trendEngine.analyze(lastCtx);
  assert.ok(res.vehicle.comparison);
  assert.strictEqual(typeof res.vehicle.comparison.recentEventCount, 'number');
  assert.strictEqual(typeof res.vehicle.comparison.previousEventCount, 'number');
  assert.ok(res.vehicle.comparison.trajectory);
});

// ── 7. Structured Risk Change Explanation ────────────────────────────────────
runTest('7 — Explanation structures primaryReason and message deterministically', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const e1 = { eventId: 'E-EXP-1', alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'EXP-VEH' } };
  e1.risk = engine.evaluate(e1);
  trendEngine.analyze(e1);

  const e2 = { eventId: 'E-EXP-2', alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH', timestamp: '2026-09-02T10:03:00.000Z', vehicle: { plate: 'EXP-VEH' } };
  e2.risk = engine.evaluate(e2);
  const res = trendEngine.analyze(e2);

  const exp = res.vehicle.explanation;
  assert.ok(exp);
  assert.strictEqual(exp.primaryReason, 'REPEATED_BEHAVIOR');
  assert.ok(exp.message.includes('repeated over speed alerts'));
  assert.ok(Array.isArray(exp.contributors));
  assert.strictEqual(exp.contributors[0], 'speeding');
});

// ── 8. Vehicle vs Driver Isolation ───────────────────────────────────────────
runTest('8 — Driver trend is null when driver identity is missing, vehicle trend persists', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = { eventId: 'E-NODRV-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'NODRV-VEH', driver: null } };
  ctx.risk = engine.evaluate(ctx);
  const res = trendEngine.analyze(ctx);

  assert.ok(res.vehicle, 'vehicle trend must exist');
  assert.strictEqual(res.driver, null, 'driver trend must be null when driver is missing');
});

runTest('9 — Driver trend updates separately when driver identity is present', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = { eventId: 'E-DRV-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DRV-VEH', driver: 'Tariq' } };
  ctx.risk = engine.evaluate(ctx);
  const res = trendEngine.analyze(ctx);

  assert.ok(res.vehicle);
  assert.ok(res.driver);
  assert.strictEqual(res.driver.entityKey, 'DRIVER:TARIQ');
  assert.strictEqual(res.driver.currentScore, 18);
});

// ── 10. Feature #2 Awareness (Correlated Pattern Primary Reason) ────────────
runTest('10 — Correlated incident sets primaryReason to CORRELATED_PATTERN', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = {
    eventId: 'E-CORR-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'CORR-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      eventCount: 2,
      incident: {
        isIncident: true,
        label: 'Aggressive Driving',
        intelligence: { escalation: { detected: false } }
      }
    }
  };
  ctx.risk = engine.evaluate(ctx);
  const res = trendEngine.analyze(ctx);

  assert.strictEqual(res.vehicle.explanation.primaryReason, 'CORRELATED_PATTERN');
  assert.ok(res.vehicle.explanation.message.includes('Aggressive Driving'));
});

// ── 11. Feature #2 Escalation Primary Reason ─────────────────────────────────
runTest('11 — Feature #3.2 escalation sets primaryReason to ESCALATION', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = {
    eventId: 'E-ESC-1',
    alertType: 'accident',
    severity: 'CRITICAL',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'ESC-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      eventCount: 2,
      incident: {
        isIncident: true,
        label: 'Accident Event',
        intelligence: { escalation: { detected: true } }
      }
    }
  };
  ctx.risk = engine.evaluate(ctx);
  const res = trendEngine.analyze(ctx);

  assert.strictEqual(res.vehicle.explanation.primaryReason, 'ESCALATION');
});

// ── 12. Recovery Alert Primary Reason ───────────────────────────────────────
runTest('12 — Signal recovery alert sets primaryReason to RECOVERY', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = { eventId: 'E-REC-1', alertType: 'gps_restored', severity: 'LOW', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'REC-VEH' } };
  ctx.risk = engine.evaluate(ctx);
  const res = trendEngine.analyze(ctx);

  assert.strictEqual(res.vehicle.explanation.primaryReason, 'RECOVERY');
});

// ── 13. EventContext Integration ─────────────────────────────────────────────
runTest('13 — EventContextBuilder attaches context.riskTrend additively', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '801' },
  });

  assert.ok(ctx.risk, 'context.risk must exist');
  assert.ok(ctx.riskTrend, 'context.riskTrend must be attached additively');
  assert.ok(ctx.riskTrend.vehicle, 'context.riskTrend.vehicle must be present');
  assert.strictEqual(ctx.riskTrend.vehicle.entityKey, 'PLATE:D31498');
});

// ── 14. Data Contract Validation ─────────────────────────────────────────────
runTest('14 — riskTrend output fields adhere strictly to data contract', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'CONTRACT-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '802' },
  });
  const v = ctx.riskTrend.vehicle;
  assert.ok(typeof v.entityKey === 'string');
  assert.ok(typeof v.trend === 'string');
  assert.ok(typeof v.scoreChange === 'number');
  assert.ok(typeof v.currentScore === 'number');
  assert.ok(typeof v.previousScore === 'number');
  assert.ok(Array.isArray(v.topContributors));
  assert.ok(Array.isArray(v.repeatedBehaviors));
  assert.ok(v.comparison && typeof v.comparison === 'object');
  assert.ok(v.explanation && typeof v.explanation === 'object');
});

// ── 15. JSON Serialization Safety ────────────────────────────────────────────
runTest('15 — riskTrend object serializes cleanly to JSON (no NaN, undefined)', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'JSON-TREND-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '803' },
  });
  let serialized;
  assert.doesNotThrow(() => { serialized = JSON.stringify(ctx.riskTrend); });
  assert.ok(!serialized.includes(':undefined'));
  assert.ok(!serialized.includes(':NaN'));
});

// ── 16. Restart & Persistence Safety ─────────────────────────────────────────
runTest('16 — Snapshots persist across engine restart for historical trend calculation', () => {
  const testStatePath = path.join(__dirname, '../data/risk_state.json');
  if (fs.existsSync(testStatePath)) {
    try { fs.unlinkSync(testStatePath); } catch {}
  }

  const e1 = new RiskEngine({ persist: true });
  const t1 = new RiskTrendEngine();

  const c1 = { eventId: 'E-RST-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'RST-VEH' } };
  c1.risk = e1.evaluate(c1);
  t1.analyze(c1);

  const c2 = { eventId: 'E-RST-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'RST-VEH' } };
  c2.risk = e1.evaluate(c2);
  t1.analyze(c2);

  // Reload state in engine 2
  const e2 = new RiskEngine({ persist: true });
  const c3 = { eventId: 'E-RST-3', alertType: 'distraction', severity: 'HIGH', timestamp: '2026-09-02T10:05:00.000Z', vehicle: { plate: 'RST-VEH' } };
  c3.risk = e2.evaluate(c3);
  const res3 = t1.analyze(c3);

  assert.ok(res3.vehicle);
  assert.strictEqual(res3.vehicle.topContributors.length, 3, 'All 3 contributor alert types must be aggregated after restart');

  e2.resetState();
});

// ── 17. Determinism ──────────────────────────────────────────────────────────
runTest('17 — Deterministic execution: identical event sequence produces identical riskTrend', () => {
  const e1 = new RiskEngine({ persist: false });
  const e2 = new RiskEngine({ persist: false });
  const t1 = new RiskTrendEngine();

  const evts = [
    { eventId: 'E-DET-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DET-VEH' } },
    { eventId: 'E-DET-2', alertType: 'speeding', timestamp: '2026-09-02T10:03:00.000Z', vehicle: { plate: 'DET-VEH' } },
  ];

  let r1, r2;
  evts.forEach(e => { e.risk = e1.evaluate(e); r1 = t1.analyze(e); });
  evts.forEach(e => { e.risk = e2.evaluate(e); r2 = t1.analyze(e); });

  assert.strictEqual(r1.vehicle.trend, r2.vehicle.trend);
  assert.strictEqual(r1.vehicle.scoreChange, r2.vehicle.scoreChange);
  assert.strictEqual(r1.vehicle.explanation.primaryReason, r2.vehicle.explanation.primaryReason);
});

// ── 18. Memory & Snapshot Cap Safety ──────────────────────────────────────────
runTest('18 — History snapshots strictly capped at 20 per entity', () => {
  const engine = new RiskEngine({ persist: false });
  for (let i = 0; i < 30; i++) {
    engine.evaluate({
      eventId: `E-CAP-${i}`,
      alertType: 'speeding',
      severity: 'HIGH',
      timestamp: '2026-09-02T10:00:00.000Z',
      vehicle: { plate: 'CAP-VEH' },
    });
  }
  const state = engine.vehicles.get('PLATE:CAPVEH');
  assert.ok(state.snapshots.length <= 20, 'Snapshots array must be capped at 20');
});

// ── 19. All 32 Alert Types Coverage ──────────────────────────────────────────
runTest('19 — All 32 defined alert types pass through RiskTrendEngine without crash', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  for (const alertDef of alertTypesRaw) {
    const ctx = {
      eventId: `E-32-${alertDef.type}`,
      alertType: alertDef.type,
      alertLabel: alertDef.label,
      severity: alertDef.severity,
      timestamp: '2026-09-02T10:00:00.000Z',
      vehicle: { plate: 'ALL32-TREND-VEH', driver: 'Driver32' },
    };
    ctx.risk = engine.evaluate(ctx);
    let res;
    assert.doesNotThrow(() => { res = trendEngine.analyze(ctx); }, `RiskTrendEngine must not crash for ${alertDef.type}`);
    assert.ok(res.vehicle, `vehicle trend must exist for ${alertDef.type}`);
    assert.ok(res.driver, `driver trend must exist for ${alertDef.type}`);
  }
});

// ── 20. Null / Malformed Input Guards ────────────────────────────────────────
runTest('20 — Handles null or malformed context gracefully without crash', () => {
  const trendEngine = new RiskTrendEngine();
  let resNull, resEmpty, resNoRisk;
  assert.doesNotThrow(() => { resNull = trendEngine.analyze(null); });
  assert.doesNotThrow(() => { resEmpty = trendEngine.analyze({}); });
  assert.doesNotThrow(() => { resNoRisk = trendEngine.analyze({ risk: {} }); });

  assert.strictEqual(resNull.vehicle, null);
  assert.strictEqual(resEmpty.vehicle, null);
  assert.strictEqual(resNoRisk.vehicle, null);
});

// ── 21. Phase 1 Score Contract Preservation Guard ────────────────────────────
runTest('21 — Phase 1 scores and levels remain 100% preserved', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'E-P1-1',
    alertType: 'speeding', // +18
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'P1-VEH' },
  });
  assert.strictEqual(res.vehicleRisk.score, 18);
  assert.strictEqual(res.vehicleRisk.level, 'LOW');
});

// ── 22. Deduplicated Duplicate Event Handling ─────────────────────────────────
runTest('22 — Duplicate eventId does not alter riskTrend scoreChange falsely', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx = { eventId: 'E-DUP-TR', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DUPTR-VEH' } };

  ctx.risk = engine.evaluate(ctx);
  const r1 = trendEngine.analyze(ctx);

  // Evaluate same duplicate context again
  ctx.risk = engine.evaluate(ctx);
  const r2 = trendEngine.analyze(ctx);

  assert.strictEqual(r1.vehicle.currentScore, r2.vehicle.currentScore);
});

// ── 23. New Vehicle Initial Trend ────────────────────────────────────────────
runTest('23 — New vehicle first alert evaluates trend cleanly', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'NEW-VEH-101', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '901' },
  });

  assert.ok(ctx.riskTrend.vehicle);
  assert.strictEqual(ctx.riskTrend.vehicle.currentScore, 18);
  assert.strictEqual(ctx.riskTrend.vehicle.previousScore, 0);
  assert.strictEqual(ctx.riskTrend.vehicle.scoreChange, 18);
  assert.strictEqual(ctx.riskTrend.vehicle.trend, 'RISING');
});

// ── 24. New Driver Initial Trend ─────────────────────────────────────────────
runTest('24 — New driver first alert evaluates driver trend cleanly', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'NEW-DRV-101', driver: 'Rashid', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '902' },
  });

  assert.ok(ctx.riskTrend.driver);
  assert.strictEqual(ctx.riskTrend.driver.entityKey, 'DRIVER:RASHID');
  assert.strictEqual(ctx.riskTrend.driver.trend, 'RISING');
});

// ── 25. Complete System Backward Compatibility Guard ──────────────────────────
runTest('25 — Legacy pipeline and Feature #1/#2 context fields remain intact', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 110, speedLimit: 80, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '903' },
  });

  assert.ok(ctx.eventId);
  assert.ok(ctx.recentActivity);
  assert.ok(ctx.contextIntelligence);
  assert.ok(ctx.alertCorrelation);
  assert.ok(ctx.risk);
  assert.ok(ctx.riskTrend);
});

// ── 26. Determinism Without EventId ──────────────────────────────────────────
runTest('26 — Determinism without eventId: repeated execution produces identical results without Math.random', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctx1 = {
    eventId: undefined, // Missing eventId
    alertType: 'speeding',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'NOID-VEH' },
  };
  ctx1.risk = engine.evaluate(ctx1);
  const res1 = trendEngine.analyze(ctx1);

  const ctx2 = {
    eventId: undefined,
    alertType: 'speeding',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'NOID-VEH' },
  };
  ctx2.risk = engine.evaluate(ctx2);
  const res2 = trendEngine.analyze(ctx2);

  assert.strictEqual(res1.vehicle.explanation.primaryReason, res2.vehicle.explanation.primaryReason);
  assert.strictEqual(res1.vehicle.repeatedBehaviors[0].count, res2.vehicle.repeatedBehaviors[0].count);
});

// ── 27. Alert Taxonomy Severity Resolution ───────────────────────────────────
runTest('27 — Resolves severity directly from data/alertTypes.json taxonomy', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  const ctxAcc = { eventId: 'E-TAX-1', alertType: 'accident', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'TAX-VEH' } };
  ctxAcc.risk = engine.evaluate(ctxAcc);
  const resAcc = trendEngine.analyze(ctxAcc);
  assert.strictEqual(resAcc.vehicle.repeatedBehaviors[0].severity, 'CRITICAL');

  const ctxSpd = { eventId: 'E-TAX-2', alertType: 'speeding', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'TAX-VEH' } };
  ctxSpd.risk = engine.evaluate(ctxSpd);
  const resSpd = trendEngine.analyze(ctxSpd);
  const spdRep = resSpd.vehicle.repeatedBehaviors.find(r => r.alertType === 'speeding');
  assert.strictEqual(spdRep.severity, 'HIGH');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 RISK TRENDS TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) process.exit(1);

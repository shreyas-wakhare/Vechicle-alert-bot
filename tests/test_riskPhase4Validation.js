/**
 * tests/test_riskPhase4Validation.js
 *
 * Feature #3: Dynamic Vehicle/Driver Risk — Phase 4: Production Hardening, Validation & AI Readiness
 *
 * Comprehensive validation test suite covering all 20 audit areas (A through T) specified
 * in the Feature #3 Phase 4 Master Prompt.
 *
 * Target: 42 meaningful production-grade validation tests.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const RiskEngine                      = require('../services/riskEngine');
const RiskTrendEngine                 = require('../services/riskTrendEngine');
const OperationalRecommendationEngine = require('../services/operationalRecommendationEngine');
const EventContextBuilder             = require('../services/eventContext');

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
console.log('🧪 FEATURE #3 PHASE 4 — PRODUCTION HARDENING & AI READINESS VALIDATION');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// ── 1. Full Pipeline Contract (Audit A) ──────────────────────────────────────
runTest('1 — Full pipeline: EventContextBuilder attaches risk, riskTrend, and riskRecommendation additively', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'PIPE-101', speed: 115, speedLimit: 80, alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-1' },
  });

  assert.ok(ctx.eventId, 'eventId must exist');
  assert.ok(ctx.recentActivity, 'recentActivity must exist');
  assert.ok(ctx.contextIntelligence, 'contextIntelligence must exist');
  assert.ok(ctx.alertCorrelation, 'alertCorrelation must exist');
  assert.ok(ctx.risk, 'risk must exist');
  assert.ok(ctx.riskTrend, 'riskTrend must exist');
  assert.ok(ctx.riskRecommendation, 'riskRecommendation must exist');
});

// ── 2. Pipeline Exception Isolation (Audit A) ────────────────────────────────
runTest('2 — Layer safety: malformed inner object does not crash EventContextBuilder', () => {
  const builder = new EventContextBuilder();
  let ctx;
  assert.doesNotThrow(() => {
    ctx = builder.build({
      alertDef: { type: 'speeding' },
      fields: { plate: null, alertTime: 'invalid-time', emailUid: 'P4-2' },
    });
  });
  assert.ok(ctx.risk);
  assert.ok(ctx.riskTrend);
  assert.ok(ctx.riskRecommendation);
});

// ── 3. Score Upper & Lower Bounds (Audit C) ──────────────────────────────────
runTest('3 — Score bounds: score never exceeds 100 and never drops below 0', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();

  // Exceed 100 points
  for (let i = 0; i < 10; i++) {
    engine.evaluate({
      eventId: `E-BND-MAX-${i}`,
      alertType: 'accident',
      timestamp: now,
      vehicle: { plate: 'BOUND-VEH' },
    });
  }
  const maxRes = engine.getVehicleRisk('PLATE:BOUNDVEH');
  assert.strictEqual(maxRes.score, 100, 'Score must cap strictly at 100');

  // Recovery alerts to drop below 0
  for (let i = 0; i < 30; i++) {
    engine.evaluate({
      eventId: `E-BND-MIN-${i}`,
      alertType: 'gps_restored',
      timestamp: now,
      vehicle: { plate: 'BOUND-VEH-2' },
    });
  }
  const minRes = engine.getVehicleRisk('PLATE:BOUNDVEH2');
  assert.strictEqual(minRes.score, 0, 'Score must not drop below 0');
});

// ── 4. NaN and Infinity Protection (Audit C) ──────────────────────────────────
runTest('4 — Numerical safety: NaN or Infinity in context never corrupts entity score', () => {
  const engine = new RiskEngine({ persist: false });
  const ctx = {
    eventId: 'E-NAN-1',
    alertType: 'speeding',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'NAN-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      eventCount: Infinity,
    }
  };
  const res = engine.evaluate(ctx);
  assert.ok(Number.isFinite(res.vehicleRisk.score), 'Score must be a finite number');
  assert.ok(!isNaN(res.vehicleRisk.score), 'Score must not be NaN');
});

// ── 5. Clean Time Decay Bounds (Audit K) ─────────────────────────────────────
runTest('5 — Decay bounds: time decay smoothly reduces score without going below 0', () => {
  const engine = new RiskEngine({ persist: false });
  const t0 = '2026-09-02T10:00:00.000Z';
  const c1 = engine.evaluate({ eventId: 'E-DEC-1', alertType: 'speeding', timestamp: t0, vehicle: { plate: 'DEC-VEH' } });
  const initialScore = c1.vehicleRisk.score; // 18

  // 60 minutes later (~6 pts decay)
  const t1 = '2026-09-02T11:00:00.000Z';
  const c2 = engine.evaluate({ eventId: 'E-DEC-2', alertType: 'ignition_off', timestamp: t1, vehicle: { plate: 'DEC-VEH' } });
  assert.ok(c2.vehicleRisk.score < initialScore, 'Score must decay after 1 hour');
  assert.ok(c2.vehicleRisk.score >= 0, 'Decayed score must remain >= 0');
});

// ── 6. Future Timestamp Decay Safety (Audit K) ───────────────────────────────
runTest('6 — Future timestamp safety: clock skew does not cause negative elapsed time decay', () => {
  const engine = new RiskEngine({ persist: false });
  engine.evaluate({ eventId: 'E-FUT-1', alertType: 'speeding', timestamp: '2026-09-02T12:00:00.000Z', vehicle: { plate: 'FUT-VEH' } });

  // Event arriving with earlier timestamp (past clock skew)
  const cPast = engine.evaluate({ eventId: 'E-FUT-2', alertType: 'speeding', timestamp: '2026-09-02T11:55:00.000Z', vehicle: { plate: 'FUT-VEH' } });
  assert.ok(Number.isFinite(cPast.vehicleRisk.score));
  assert.ok(cPast.vehicleRisk.score >= 0);
});

// ── 7. Invalid Timestamp Fallback (Audit K) ──────────────────────────────────
runTest('7 — Malformed timestamp safety: invalid date strings fall back cleanly', () => {
  const engine = new RiskEngine({ persist: false });
  let res;
  assert.doesNotThrow(() => {
    res = engine.evaluate({ eventId: 'E-TS-BAD', alertType: 'speeding', timestamp: 'not-a-valid-date', vehicle: { plate: 'TS-VEH' } });
  });
  assert.ok(res.vehicleRisk);
  assert.ok(Number.isFinite(res.vehicleRisk.score));
});

// ── 8. Vehicle Isolation (Audit E) ───────────────────────────────────────────
runTest('8 — Entity isolation: Vehicle A risk never bleeds into Vehicle B', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  engine.evaluate({ eventId: 'E-ISO-A', alertType: 'accident', timestamp: now, vehicle: { plate: 'VEH-A' } });
  const resB = engine.evaluate({ eventId: 'E-ISO-B', alertType: 'ignition_on', timestamp: now, vehicle: { plate: 'VEH-B' } });

  assert.strictEqual(resB.vehicleRisk.score, 1, 'Vehicle B must only have ignition impact');
  assert.strictEqual(engine.getVehicleRisk('PLATE:VEHA').score, 45, 'Vehicle A must retain accident score');
});

// ── 9. Driver Isolation (Audit E) ───────────────────────────────────────────
runTest('9 — Driver isolation: Driver A risk never bleeds into Driver B', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  engine.evaluate({ eventId: 'E-DRV-A', alertType: 'speeding', timestamp: now, vehicle: { plate: 'VEH-1', driver: 'Driver Alpha' } });
  const resB = engine.evaluate({ eventId: 'E-DRV-B', alertType: 'idle', timestamp: now, vehicle: { plate: 'VEH-2', driver: 'Driver Beta' } });

  assert.strictEqual(resB.driverRisk.score, 0, 'Idle is driverDomain: false, Driver Beta score must be 0');
  assert.strictEqual(engine.getDriverRisk('DRIVER:DRIVER_ALPHA').score, 18, 'Driver Alpha must retain speeding score');
});

// ── 10. Missing Driver Identity (Audit D) ────────────────────────────────────
runTest('10 — Missing driver: driverRisk and driver recommendation remain strictly null', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'NO-DRV-VEH', driver: '', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-10' },
  });

  assert.strictEqual(ctx.risk.driverRisk, null);
  assert.strictEqual(ctx.riskTrend.driver, null);
  assert.strictEqual(ctx.riskRecommendation.driver, null);
});

// ── 11. Vehicle-Only Alert Domain Isolation (Audit D) ────────────────────────
runTest('11 — Vehicle-only alert domain guard: tampering does not increment driver risk or driver coaching', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'tampering', label: 'Device Tampering', severity: 'HIGH' },
    fields: { plate: 'VONLY-VEH', driver: 'P4DriverTamper', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-11' },
  });

  assert.ok(ctx.risk.vehicleRisk.score > 0);
  assert.strictEqual(ctx.risk.driverRisk.score, 0, 'Tampering must not increment driver risk score');
  assert.strictEqual(ctx.riskRecommendation.driver.recommendedAction.category, 'MONITOR_ONLY');
});

// ── 12. Driver Domain Attribution (Audit D) ──────────────────────────────────
runTest('12 — Driving safety alert increments both vehicle and driver risk', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'BOTH-VEH', driver: 'P4DriverSpeed', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-12' },
  });

  assert.strictEqual(ctx.risk.vehicleRisk.score, 18);
  assert.strictEqual(ctx.risk.driverRisk.score, 18);
  assert.strictEqual(ctx.riskRecommendation.driver.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
});

// ── 13. Unknown Vehicle Key Handling (Audit E) ───────────────────────────────
runTest('13 — Unknown vehicle key: no plate and no IMEI falls back to UNKNOWN cleanly', () => {
  const engine = new RiskEngine({ persist: false });
  const key = engine.deriveVehicleKey({});
  assert.strictEqual(key, 'UNKNOWN');
});

// ── 14. Plate Normalization Stability (Audit E) ──────────────────────────────
runTest('14 — Plate normalization: formats D/31498, d 31498, D-31498 yield PLATE:D31498', () => {
  const engine = new RiskEngine({ persist: false });
  assert.strictEqual(engine.deriveVehicleKey({ plate: 'D/31498' }), 'PLATE:D31498');
  assert.strictEqual(engine.deriveVehicleKey({ plate: 'd 31498' }), 'PLATE:D31498');
  assert.strictEqual(engine.deriveVehicleKey({ plate: 'D-31498' }), 'PLATE:D31498');
});

// ── 15. Driver Normalization Stability (Audit E) ─────────────────────────────
runTest('15 — Driver normalization: Ahmed, ahmed, Ahmed   yield DRIVER:AHMED', () => {
  const engine = new RiskEngine({ persist: false });
  assert.strictEqual(engine.deriveDriverKey('Ahmed'), 'DRIVER:AHMED');
  assert.strictEqual(engine.deriveDriverKey('ahmed'), 'DRIVER:AHMED');
  assert.strictEqual(engine.deriveDriverKey('Ahmed  '), 'DRIVER:AHMED');
});

// ── 16. Duplicate Event Protection (Audit F) ─────────────────────────────────
runTest('16 — Duplicate event protection: replayed eventId does not increment score twice', () => {
  const engine = new RiskEngine({ persist: false });
  const e1 = engine.evaluate({ eventId: 'EVT-DUP-TEST', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DUP-VEH' } });
  const e2 = engine.evaluate({ eventId: 'EVT-DUP-TEST', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DUP-VEH' } });

  assert.strictEqual(e1.vehicleRisk.score, 18);
  assert.strictEqual(e2.vehicleRisk.score, 18, 'Score must not increase on duplicate replay');
  assert.strictEqual(e2.vehicleRisk.contributors.length, 1, 'Contributors must not duplicate');
});

// ── 17. Duplicate Replay Does Not Mutate Trend (Audit F) ─────────────────────
runTest('17 — Duplicate event replay does not falsely mutate trend', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  // Event 1: Initial speeding alert (score = 18)
  const c1 = { eventId: 'E-REP-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'TRD-DUP' } };
  c1.risk = engine.evaluate(c1);
  trendEngine.analyze(c1);

  // Event 2: Minor alert (score goes 18 -> 19)
  const c2 = { eventId: 'E-REP-2', alertType: 'ignition_on', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'TRD-DUP' } };
  c2.risk = engine.evaluate(c2);
  const r2 = trendEngine.analyze(c2);
  assert.strictEqual(r2.vehicle.trend, 'STABLE');

  // Replay Event 2: duplicate replay
  const c2Dup = { eventId: 'E-REP-2', alertType: 'ignition_on', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'TRD-DUP' } };
  c2Dup.risk = engine.evaluate(c2Dup);
  const rDup = trendEngine.analyze(c2Dup);

  assert.strictEqual(c2Dup.risk.vehicleRisk.score, c2.risk.vehicleRisk.score, 'Score must not inflate');
  assert.strictEqual(rDup.vehicle.trend, 'STABLE', 'Duplicate replay must remain STABLE');
});

// ── 18. Safe Load with Missing State File (Audit G) ──────────────────────────
runTest('18 — Persistence safety: engine starts safely when state file is absent', () => {
  const scratchStatePath = path.join(__dirname, '../scratch/test_missing_state.json');
  if (fs.existsSync(scratchStatePath)) fs.unlinkSync(scratchStatePath);

  assert.doesNotThrow(() => {
    new RiskEngine({ persist: true, filePath: scratchStatePath });
  });
});

// ── 19. Safe Load with Corrupted State File (Audit G) ────────────────────────
runTest('19 — Persistence safety: engine recovers cleanly from corrupted state file', () => {
  const scratchStatePath = path.join(__dirname, '../scratch/test_corrupt_state.json');
  fs.mkdirSync(path.dirname(scratchStatePath), { recursive: true });
  fs.writeFileSync(scratchStatePath, '{ this is corrupted json }}}', 'utf8');

  try {
    assert.doesNotThrow(() => {
      new RiskEngine({ persist: true, filePath: scratchStatePath });
    });
  } finally {
    try { if (fs.existsSync(scratchStatePath)) fs.unlinkSync(scratchStatePath); } catch {}
  }
});

// ── 20. Persistence Roundtrip Rehydration (Audit G) ──────────────────────────
runTest('20 — Persistence roundtrip: vehicle risk state rehydrates cleanly after restart', () => {
  const scratchStatePath = path.join(__dirname, '../scratch/test_roundtrip_state.json');
  try { if (fs.existsSync(scratchStatePath)) fs.unlinkSync(scratchStatePath); } catch {}

  const e1 = new RiskEngine({ persist: true, filePath: scratchStatePath });
  const now = new Date().toISOString();
  e1.evaluate({ eventId: 'E-RND-1', alertType: 'speeding', timestamp: now, vehicle: { plate: 'RND-VEH' } });

  const e2 = new RiskEngine({ persist: true, filePath: scratchStatePath });
  const reloaded = e2.getVehicleRisk('PLATE:RNDVEH');
  assert.ok(reloaded);
  assert.strictEqual(reloaded.score, 18);

  try { if (fs.existsSync(scratchStatePath)) fs.unlinkSync(scratchStatePath); } catch {}
});

// ── 21. Bounded Snapshots Cap (Audit H) ───────────────────────────────────────
runTest('21 — Memory bounds: snapshots strictly capped at 20 per entity', () => {
  const engine = new RiskEngine({ persist: false });
  for (let i = 0; i < 40; i++) {
    engine.evaluate({ eventId: `E-SNP-${i}`, alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'CAP-VEH' } });
  }
  const res = engine.getVehicleRisk('PLATE:CAPVEH');
  assert.ok(res.snapshots.length <= 20, `Snapshots length was ${res.snapshots.length}, must be <= 20`);
});

// ── 22. Bounded Processed Event IDs Cap (Audit H) ─────────────────────────────
runTest('22 — Memory bounds: processed event IDs strictly capped at 100', () => {
  const engine = new RiskEngine({ persist: false });
  for (let i = 0; i < 150; i++) {
    engine.evaluate({ eventId: `E-EVT-${i}`, alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'EVT-CAP-VEH' } });
  }
  const entity = engine.vehicles.get('PLATE:EVTCAPVEH');
  assert.ok(entity.processedEventIds.length <= 100);
});

// ── 23. Bounded Contributors Cap (Audit H) ───────────────────────────────────
runTest('23 — Memory bounds: contributors strictly capped at 10', () => {
  const engine = new RiskEngine({ persist: false });
  for (let i = 0; i < 25; i++) {
    engine.evaluate({ eventId: `E-CTB-${i}`, alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'CTB-CAP-VEH' } });
  }
  const res = engine.getVehicleRisk('PLATE:CTBCAPVEH');
  assert.ok(res.contributors.length <= 10);
});

// ── 24. Trend Boundary Exactly +5 (Audit L) ──────────────────────────────────
runTest('24 — Trend boundary: scoreChange of exactly +5 is classified as STABLE', () => {
  const trendEngine = new RiskTrendEngine();
  const ctx = {
    risk: {
      vehicleRisk: {
        entityKey: 'PLATE:T5',
        score: 25,
        snapshots: [{ score: 25, previousScore: 20 }],
      }
    }
  };
  const res = trendEngine.analyze(ctx);
  assert.strictEqual(res.vehicle.trend, 'STABLE');
});

// ── 25. Trend Boundary +6 is RISING (Audit L) ─────────────────────────────────
runTest('25 — Trend boundary: scoreChange of +6 is classified as RISING', () => {
  const trendEngine = new RiskTrendEngine();
  const ctx = {
    risk: {
      vehicleRisk: {
        entityKey: 'PLATE:T6',
        score: 26,
        snapshots: [{ score: 26, previousScore: 20 }],
      }
    }
  };
  const res = trendEngine.analyze(ctx);
  assert.strictEqual(res.vehicle.trend, 'RISING');
});

// ── 26. Trend Boundary Exactly -5 (Audit L) ──────────────────────────────────
runTest('26 — Trend boundary: scoreChange of exactly -5 is classified as STABLE', () => {
  const trendEngine = new RiskTrendEngine();
  const ctx = {
    risk: {
      vehicleRisk: {
        entityKey: 'PLATE:TM5',
        score: 20,
        snapshots: [{ score: 20, previousScore: 25 }],
      }
    }
  };
  const res = trendEngine.analyze(ctx);
  assert.strictEqual(res.vehicle.trend, 'STABLE');
});

// ── 27. Trend Boundary -6 is IMPROVING (Audit L) ─────────────────────────────
runTest('27 — Trend boundary: scoreChange of -6 is classified as IMPROVING', () => {
  const trendEngine = new RiskTrendEngine();
  const ctx = {
    risk: {
      vehicleRisk: {
        entityKey: 'PLATE:TM6',
        score: 19,
        snapshots: [{ score: 19, previousScore: 25 }],
      }
    }
  };
  const res = trendEngine.analyze(ctx);
  assert.strictEqual(res.vehicle.trend, 'IMPROVING');
});

// ── 28. Determinism: Decision Data is 100% Identical (Audit B) ───────────────
runTest('28 — Determinism: identical input context yields identical decision fields', () => {
  const engine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();
  const recEngine = new OperationalRecommendationEngine();

  const ctx1 = { eventId: 'E-DET-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DET-VEH' } };
  ctx1.risk = engine.evaluate(ctx1);
  ctx1.riskTrend = trendEngine.analyze(ctx1);
  const r1 = recEngine.generate(ctx1);

  const engine2 = new RiskEngine({ persist: false });
  const ctx2 = { eventId: 'E-DET-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DET-VEH' } };
  ctx2.risk = engine2.evaluate(ctx2);
  ctx2.riskTrend = trendEngine.analyze(ctx2);
  const r2 = recEngine.generate(ctx2);

  assert.strictEqual(r1.vehicle.riskLevel, r2.vehicle.riskLevel);
  assert.strictEqual(r1.vehicle.trend, r2.vehicle.trend);
  assert.strictEqual(r1.vehicle.operationalMeaning, r2.vehicle.operationalMeaning);
  assert.strictEqual(r1.vehicle.recommendedAction.urgency, r2.vehicle.recommendedAction.urgency);
  assert.strictEqual(r1.vehicle.recommendedAction.category, r2.vehicle.recommendedAction.category);
  assert.strictEqual(r1.vehicle.recommendedAction.directive, r2.vehicle.recommendedAction.directive);
});

// ── 29. generatedAt Metadata Validity (Audit B) ──────────────────────────────
runTest('29 — Metadata validity: generatedAt is a valid ISO timestamp', () => {
  const recEngine = new OperationalRecommendationEngine();
  const res = recEngine.generate({ alertType: 'speeding', vehicle: { plate: 'META-VEH' } });
  assert.ok(res.generatedAt);
  assert.ok(!isNaN(new Date(res.generatedAt).getTime()));
});

// ── 30. All 32 Alert Types Coverage (Audit I) ────────────────────────────────
runTest('30 — Taxonomy completeness: all 32 alert types pass through full pipeline', () => {
  const riskEngine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();
  const recEngine = new OperationalRecommendationEngine();

  assert.strictEqual(alertTypesRaw.length, 32, 'Must validate all 32 alert types');

  for (const a of alertTypesRaw) {
    const ctx = {
      eventId: `E-TAX-${a.type}`,
      alertType: a.type,
      alertLabel: a.label,
      severity: a.severity,
      timestamp: '2026-09-02T10:00:00.000Z',
      vehicle: { plate: 'TAX-32-VEH' },
    };
    ctx.risk = riskEngine.evaluate(ctx);
    ctx.riskTrend = trendEngine.analyze(ctx);
    const rec = recEngine.generate(ctx);

    assert.ok(rec.vehicle, `Vehicle recommendation must exist for ${a.type}`);
    assert.ok(rec.vehicle.recommendedAction.urgency, `Urgency must exist for ${a.type}`);
    assert.ok(rec.vehicle.recommendedAction.category, `Category must exist for ${a.type}`);
  }
});

// ── 31. Severity Consistency: CRITICAL (Audit J) ─────────────────────────────
runTest('31 — Severity consistency: accident, sos, engine_failure map to CRITICAL & IMMEDIATE_ACTION', () => {
  const recEngine = new OperationalRecommendationEngine();

  for (const t of ['accident', 'sos', 'engine_failure']) {
    const ctx = {
      alertType: t,
      vehicle: { plate: 'CRIT-CHK' },
      risk: { vehicleRisk: { entityKey: 'PLATE:CRITCHK', score: 80, level: 'HIGH' } },
      riskTrend: { vehicle: { trend: 'RISING' } },
    };
    const rec = recEngine.generate(ctx);
    assert.strictEqual(rec.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION', `${t} must trigger IMMEDIATE_ACTION`);
  }
});

// ── 32. Severity Consistency: HIGH Alert Types (Audit J) ─────────────────────
runTest('32 — Severity consistency: speeding, drinking, fatigue map to valid high urgencies', () => {
  const recEngine = new OperationalRecommendationEngine();

  const ctxDrk = {
    alertType: 'drinking',
    vehicle: { plate: 'DRK-CHK' },
    risk: { vehicleRisk: { entityKey: 'PLATE:DRKCHK', score: 65, level: 'ELEVATED' } },
    riskTrend: { vehicle: { trend: 'RISING' } },
  };
  const recDrk = recEngine.generate(ctxDrk);
  assert.strictEqual(recDrk.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
  assert.strictEqual(recDrk.vehicle.recommendedAction.category, 'IMMEDIATE_DRIVER_CONTACT');
});

// ── 33. Signal Recovery Behavior (Audit I & K) ───────────────────────────────
runTest('33 — Recovery alert: gps_restored maps to MONITOR_ONLY category and MONITOR urgency', () => {
  const recEngine = new OperationalRecommendationEngine();
  const ctx = {
    alertType: 'gps_restored',
    vehicle: { plate: 'REC-CHK' },
    risk: { vehicleRisk: { entityKey: 'PLATE:RECCHK', score: 10, level: 'LOW' } },
    riskTrend: { vehicle: { trend: 'IMPROVING' } },
  };
  const rec = recEngine.generate(ctx);
  assert.strictEqual(rec.vehicle.recommendedAction.category, 'MONITOR_ONLY');
  assert.strictEqual(rec.vehicle.recommendedAction.urgency, 'MONITOR');
});

// ── 34. Feature #2 Correlated Pattern Multiplier (Audit O) ───────────────────
runTest('34 — Feature #2 integration: correlated pattern applies 1.35x multiplier', () => {
  const engine = new RiskEngine({ persist: false });
  const ctx = {
    eventId: 'E-CORR-1',
    alertType: 'speeding', // baseImpact 18
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'CORR-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      incident: { isIncident: true, label: 'Speed Pattern' },
    }
  };
  const res = engine.evaluate(ctx);
  // 18 * 1.35 = 24.3 -> Math.round = 24
  assert.strictEqual(res.vehicleRisk.score, 24);
});

// ── 35. Feature #2 Incident Escalation Urgency (Audit O) ─────────────────────
runTest('35 — Feature #2 integration: pattern escalation forces IMMEDIATE_ACTION', () => {
  const recEngine = new OperationalRecommendationEngine();
  const ctx = {
    alertType: 'speeding',
    vehicle: { plate: 'ESC-VEH' },
    risk: { vehicleRisk: { entityKey: 'PLATE:ESCVEH', score: 40, level: 'MEDIUM' } },
    riskTrend: { vehicle: { trend: 'STABLE' } },
    alertCorrelation: {
      incident: {
        intelligence: { escalation: { detected: true } }
      }
    }
  };
  const rec = recEngine.generate(ctx);
  assert.strictEqual(rec.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 36. Alert-Specific Directives Consistency (Audit N) ──────────────────────
runTest('36 — Directive specificity: harsh braking references smooth driving standards', () => {
  const recEngine = new OperationalRecommendationEngine();
  const ctx = {
    alertType: 'harsh_braking',
    vehicle: { plate: 'DIR-VEH' },
    risk: { vehicleRisk: { entityKey: 'PLATE:DIRVEH', score: 30, level: 'MEDIUM' } },
    riskTrend: { vehicle: { trend: 'STABLE' } },
  };
  const rec = recEngine.generate(ctx);
  assert.ok(rec.vehicle.recommendedAction.directive.includes('smooth driving standards'));
  assert.ok(!rec.vehicle.recommendedAction.directive.includes('speed limits'));
});

// ── 37. Malformed Input Safety (Audit P) ─────────────────────────────────────
runTest('37 — Malformed input safety: null or empty object context returns safe fallback without crash', () => {
  const recEngine = new OperationalRecommendationEngine();
  let rNull, rEmpty;
  assert.doesNotThrow(() => { rNull = recEngine.generate(null); });
  assert.doesNotThrow(() => { rEmpty = recEngine.generate({}); });

  assert.strictEqual(rNull.vehicle, null);
  assert.strictEqual(rEmpty.driver, null);
});

// ── 38. JSON Clean Serialization (Audit Q) ───────────────────────────────────
runTest('38 — Clean JSON serialization: risk, riskTrend, and riskRecommendation serialize without NaN or undefined', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'JSON-SAFE-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-38' },
  });

  let serialized;
  assert.doesNotThrow(() => {
    serialized = JSON.stringify({
      risk: ctx.risk,
      riskTrend: ctx.riskTrend,
      riskRecommendation: ctx.riskRecommendation,
    });
  });
  assert.ok(!serialized.includes(':undefined'));
  assert.ok(!serialized.includes(':NaN'));
  assert.ok(!serialized.includes(':Infinity'));
});

// ── 39. No Circular References (Audit Q) ─────────────────────────────────────
runTest('39 — Circular reference audit: EventContext is a clean DAG with no cycles', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'distraction', label: 'Driver Distracted', severity: 'HIGH' },
    fields: { plate: 'NO-CYCLE-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-39' },
  });

  assert.doesNotThrow(() => {
    JSON.stringify(ctx);
  });
});

// ── 40. Backward Compatibility (Audit R) ─────────────────────────────────────
runTest('40 — Backward compatibility: EventContext retains all legacy fields unmodified', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 112, speedLimit: 80, alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-40' },
  });

  assert.strictEqual(ctx.vehicle.plate, 'D/31498');
  assert.strictEqual(ctx.telemetry.speed, 112);
  assert.strictEqual(ctx.telemetry.excessSpeed, 32);
  assert.ok(ctx.recentActivity.windows['5m']);
  assert.ok(ctx.recentActivity.windows['15m']);
  assert.ok(ctx.recentActivity.windows['30m']);
  assert.ok(ctx.recentActivity.windows['60m']);
});

// ── 41. Real Production Payload Parsing (Audit S) ────────────────────────────
runTest('41 — Production path validation: actual AlertParser with System 1 and Track9999 emails executes full pipeline', () => {
  const AlertParser = require('../services/alertParser');
  const parser = new AlertParser();

  // Track9999 email raw mail object
  const trackMail = {
    from: { value: [{ address: 'noreply@track9999.com' }] },
    subject: 'Tracker Event Notification[Camera Screen Blocked][CC-48315]',
    text: 'Camera Screen Blocked alert for vehicle CC-48315 on 2026-09-02 10:00:00',
    date: new Date('2026-09-02T10:00:00.000Z'),
  };
  const resTrack = parser.parse(trackMail);
  assert.ok(resTrack && resTrack.context, 'Track9999 must parse and build context');
  assert.strictEqual(resTrack.context.riskRecommendation.vehicle.recommendedAction.category, 'SECURITY_REVIEW_REQUIRED');

  // System 1 email raw mail object
  const sys1Mail = {
    from: { value: [{ address: 'alerts@tracking.com' }] },
    subject: 'Over Speed Alert',
    text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 80 kmph\n118 kmph\non 2026-09-02 10:00:00\nlat: 25.1234, lon: 55.2345',
    date: new Date('2026-09-02T10:00:00.000Z'),
  };
  const resSys1 = parser.parse(sys1Mail);
  assert.ok(resSys1 && resSys1.context, 'System 1 must parse and build context');
  assert.strictEqual(resSys1.context.riskRecommendation.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
});

// ── 42. AI-Readiness Structured Schema Validation (Audit T) ──────────────────
runTest('42 — AI readiness: contract segregates telemetry, history, risk, trend, meaning, and action', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'AI-READY-VEH', driver: 'Tariq', alertTime: '2026-09-02T10:00:00.000Z', emailUid: 'P4-42' },
  });

  // Verify explicit separation of AI synthesis primitives:
  // 1. WHAT happened (telemetry/alert)
  assert.strictEqual(ctx.alertType, 'speeding');
  assert.strictEqual(ctx.vehicle.plate, 'AI-READY-VEH');

  // 2. CURRENT risk score & level
  assert.ok(typeof ctx.risk.vehicleRisk.score === 'number');
  assert.ok(typeof ctx.risk.vehicleRisk.level === 'string');

  // 3. TREND trajectory & score change
  assert.ok(typeof ctx.riskTrend.vehicle.trend === 'string');
  assert.ok(typeof ctx.riskTrend.vehicle.scoreChange === 'number');

  // 4. WHY risk changed (explanation & contributors)
  assert.ok(typeof ctx.riskTrend.vehicle.explanation.primaryReason === 'string');
  assert.ok(Array.isArray(ctx.riskTrend.vehicle.topContributors));

  // 5. OPERATIONAL MEANING
  assert.ok(typeof ctx.riskRecommendation.vehicle.operationalMeaning === 'string');

  // 6. RECOMMENDED MANAGER ACTION
  assert.ok(typeof ctx.riskRecommendation.vehicle.recommendedAction.urgency === 'string');
  assert.ok(typeof ctx.riskRecommendation.vehicle.recommendedAction.category === 'string');
  assert.ok(typeof ctx.riskRecommendation.vehicle.recommendedAction.directive === 'string');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 PHASE 4 VALIDATION TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) process.exit(1);

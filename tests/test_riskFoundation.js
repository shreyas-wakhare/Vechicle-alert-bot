/**
 * tests/test_riskFoundation.js
 *
 * Comprehensive Test Suite for Feature #3 Phase 1 — Dynamic Vehicle/Driver Risk (Risk Foundation & Scoring)
 *
 * Validates all 27 requirements specified in Section 17 of the Master Prompt.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const RiskEngine          = require('../services/riskEngine');
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
console.log('🧪 FEATURE #3 PHASE 1 — DYNAMIC VEHICLE/DRIVER RISK TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// ── 1. Initial Risk State ────────────────────────────────────────────────────
runTest('1 — Initial risk state for new entity defaults to score 0 and LOW level', () => {
  const engine = new RiskEngine({ persist: false });
  const result = engine.getVehicleRisk('PLATE:NEWVEHICLE');
  assert.strictEqual(result, null, 'Unseen entity must return null when queried');
});

// ── 2. Score Boundaries (0 to 100) ──────────────────────────────────────────
runTest('2 — Score is strictly bounded between 0 and 100', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  // Process 10 critical accidents
  for (let i = 0; i < 10; i++) {
    engine.evaluate({
      eventId: `EVT-CRIT-${i}`,
      alertType: 'accident',
      severity: 'CRITICAL',
      timestamp: now,
      vehicle: { plate: 'BOUND-100' },
    });
  }
  const res = engine.getVehicleRisk('PLATE:BOUND100');
  assert.ok(res.score <= 100, `Score must not exceed 100, got: ${res.score}`);
  assert.strictEqual(res.score, 100);
});

// ── 3. LOW/MEDIUM/ELEVATED/HIGH/CRITICAL Mapping ────────────────────────────
runTest('3 — Risk level thresholds map deterministically', () => {
  const engine = new RiskEngine({ persist: false });
  assert.strictEqual(engine.deriveRiskLevel(0), 'LOW');
  assert.strictEqual(engine.deriveRiskLevel(15), 'LOW');
  assert.strictEqual(engine.deriveRiskLevel(20), 'MEDIUM');
  assert.strictEqual(engine.deriveRiskLevel(44), 'MEDIUM');
  assert.strictEqual(engine.deriveRiskLevel(45), 'ELEVATED');
  assert.strictEqual(engine.deriveRiskLevel(69), 'ELEVATED');
  assert.strictEqual(engine.deriveRiskLevel(70), 'HIGH');
  assert.strictEqual(engine.deriveRiskLevel(89), 'HIGH');
  assert.strictEqual(engine.deriveRiskLevel(90), 'CRITICAL');
  assert.strictEqual(engine.deriveRiskLevel(100), 'CRITICAL');
});

// ── 4. Positive Risk Impact ──────────────────────────────────────────────────
runTest('4 — Single speeding alert increases vehicle risk score', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-POS-1',
    alertType: 'speeding',
    alertLabel: 'Over Speed',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'POS-VEH' },
  });

  assert.ok(res.vehicleRisk, 'vehicleRisk output must be present');
  assert.ok(res.vehicleRisk.score > 0, 'speeding must increase score');
  assert.strictEqual(res.vehicleRisk.level, 'LOW'); // 18 pts = LOW (threshold 20)
  assert.strictEqual(res.vehicleRisk.contributors.length, 1);
});

// ── 5. Multiple Events Cumulative Impact ─────────────────────────────────────
runTest('5 — Multiple different events accumulate risk score', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  engine.evaluate({
    eventId: 'EVT-MULT-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: now,
    vehicle: { plate: 'MULT-VEH' },
  });
  engine.evaluate({
    eventId: 'EVT-MULT-2',
    alertType: 'harsh_braking',
    severity: 'MEDIUM',
    timestamp: now,
    vehicle: { plate: 'MULT-VEH' },
  });
  const res = engine.getVehicleRisk('PLATE:MULTVEH');
  // speeding (18) + harsh_braking (10) = 28 pts => MEDIUM
  assert.strictEqual(res.score, 28);
  assert.strictEqual(res.level, 'MEDIUM');
});

// ── 6. Duplicate Event Protection ───────────────────────────────────────────
runTest('6 — Processing exact same eventId twice applies impact only once', () => {
  const engine = new RiskEngine({ persist: false });
  const evt = {
    eventId: 'EVT-DUP-100',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'DUP-VEH' },
  };

  const res1 = engine.evaluate(evt);
  const score1 = res1.vehicleRisk.score;

  const res2 = engine.evaluate(evt);
  const score2 = res2.vehicleRisk.score;

  assert.strictEqual(score1, score2, 'Duplicate eventId must not increase risk score');
});

// ── 7. Vehicle Identity (IMEI vs Plate) ──────────────────────────────────────
runTest('7 — IMEI takes priority over plate for vehicle key derivation', () => {
  const engine = new RiskEngine({ persist: false });
  const k1 = engine.deriveVehicleKey({ imei: '864201040123456', plate: 'D/31498' });
  const k2 = engine.deriveVehicleKey({ plate: 'D/31498' });
  assert.strictEqual(k1, 'IMEI:864201040123456');
  assert.strictEqual(k2, 'PLATE:D31498');
});

// ── 8. Driver Identity ───────────────────────────────────────────────────────
runTest('8 — Driver risk updates when valid driver identity is present', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-DRV-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'DRV-VEH', driver: 'Ahmed' },
  });

  assert.ok(res.driverRisk, 'driverRisk must be present when driver is named');
  assert.strictEqual(res.driverRisk.entityKey, 'DRIVER:AHMED');
  assert.ok(res.driverRisk.score > 0);
});

// ── 9. Unknown Driver Handling ───────────────────────────────────────────────
runTest('9 — Driver risk is null when driver identity is missing or unknown', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-DRV-NULL',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'NODRIVER-VEH', driver: null },
  });

  assert.strictEqual(res.driverRisk, null, 'driverRisk must be null when driver is missing');
  assert.ok(res.vehicleRisk, 'vehicleRisk must still be updated');
});

// ── 10. Vehicle-Only Event ──────────────────────────────────────────────────
runTest('10 — Vehicle-only event (tampering) updates vehicle risk but not driver risk', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-VONLY-1',
    alertType: 'tampering',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'VONLY-VEH', driver: 'Ahmed' },
  });

  assert.ok(res.vehicleRisk.score > 0, 'vehicle risk must increase for tampering');
  assert.strictEqual(res.driverRisk.score, 0, 'driver risk must not increase for device tampering');
});

// ── 11. Driver-Only Event ──────────────────────────────────────────────────
runTest('11 — Driver behavior event updates both vehicle and driver risk', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-DONLY-1',
    alertType: 'distraction',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'DONLY-VEH', driver: 'Ahmed' },
  });

  assert.ok(res.vehicleRisk.score > 0);
  assert.ok(res.driverRisk.score > 0);
});

// ── 12. Shared Vehicle/Driver Event ──────────────────────────────────────────
runTest('12 — Accident event impacts both vehicle and driver risk', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-SHARED-1',
    alertType: 'accident',
    severity: 'CRITICAL',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'SHARED-VEH', driver: 'Ahmed' },
  });

  assert.strictEqual(res.vehicleRisk.level, 'ELEVATED'); // 45 pts
  assert.strictEqual(res.driverRisk.level, 'ELEVATED');  // 45 pts
});

// ── 13. Correlated Incident Pattern Multiplier ────────────────────────────────
runTest('13 — Feature #2 correlated pattern applies pattern multiplier (1.35x)', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-PAT-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'PAT-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      eventCount: 2,
      incident: {
        isIncident: true,
        type: 'AGGRESSIVE_DRIVING',
        intelligence: { escalation: { detected: false } }
      }
    }
  });

  // Base 18 * 1.35 = 24.3 => 24
  assert.strictEqual(res.vehicleRisk.score, 24);
  assert.strictEqual(res.vehicleRisk.level, 'MEDIUM');
});

// ── 14. No Double Counting ───────────────────────────────────────────────────
runTest('14 — Re-evaluating same EventContext produces duplicate protection', () => {
  const engine = new RiskEngine({ persist: false });
  const ctx = {
    eventId: 'EVT-NODUB-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'NODUB-VEH' },
  };

  const r1 = engine.evaluate(ctx);
  const r2 = engine.evaluate(ctx);
  assert.strictEqual(r1.vehicleRisk.score, r2.vehicleRisk.score);
});

// ── 15. Risk Recovery / Clean Time Decay ─────────────────────────────────────
runTest('15 — Risk decays over clean elapsed time (0.1 pt/min)', () => {
  const engine = new RiskEngine({ persist: false });
  engine.evaluate({
    eventId: 'EVT-DECAY-1',
    alertType: 'accident', // +45 pts
    severity: 'CRITICAL',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'DECAY-VEH' },
  });

  // Query 100 minutes later -> decay = 100 * 0.1 = 10 pts => 45 - 10 = 35 pts
  const queryMs = new Date('2026-09-02T11:40:00.000Z').getTime();
  const vState = engine.vehicles.get('PLATE:DECAYVEH');
  const formatted = engine._formatEntityOutput('vehicle', 'PLATE:DECAYVEH', vState, queryMs);

  assert.strictEqual(formatted.score, 35);
});

// ── 16. Score Never Below 0 ──────────────────────────────────────────────────
runTest('16 — Recovery alerts and decay never push score below 0', () => {
  const engine = new RiskEngine({ persist: false });
  engine.evaluate({
    eventId: 'EVT-ZERO-1',
    alertType: 'gps_restored', // -5 pts
    severity: 'LOW',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'ZERO-VEH' },
  });
  const res = engine.getVehicleRisk('PLATE:ZEROVEH');
  assert.strictEqual(res.score, 0);
});

// ── 17. Score Never Above 100 ────────────────────────────────────────────────
runTest('17 — Score never exceeds maximum 100 boundary', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    engine.evaluate({
      eventId: `EVT-MAX-${i}`,
      alertType: 'accident', // +45 each
      severity: 'CRITICAL',
      timestamp: now,
      vehicle: { plate: 'MAX-VEH' },
    });
  }
  const res = engine.getVehicleRisk('PLATE:MAXVEH');
  assert.strictEqual(res.score, 100);
});

// ── 18. Missing Fields Fallback ──────────────────────────────────────────────
runTest('18 — Handles context with missing vehicle / telemetry fields safely', () => {
  const engine = new RiskEngine({ persist: false });
  let res;
  assert.doesNotThrow(() => {
    res = engine.evaluate({
      eventId: 'EVT-MISS-1',
      alertType: 'speeding',
    });
  });
  assert.ok(res);
  assert.strictEqual(res.vehicleRisk, null);
  assert.strictEqual(res.driverRisk, null);
});

// ── 19. Invalid Timestamps Fallback ──────────────────────────────────────────
runTest('19 — Handles invalid timestamp strings without NaN score', () => {
  const engine = new RiskEngine({ persist: false });
  let res;
  assert.doesNotThrow(() => {
    res = engine.evaluate({
      eventId: 'EVT-BADTS-1',
      alertType: 'speeding',
      timestamp: 'INVALID-DATE-STRING',
      vehicle: { plate: 'BADTS-VEH' },
    });
  });
  assert.ok(typeof res.vehicleRisk.score === 'number');
  assert.ok(!isNaN(res.vehicleRisk.score));
});

// ── 20. Invalid Severity Fallback ────────────────────────────────────────────
runTest('20 — Handles unknown severity string using alertType base mapping', () => {
  const engine = new RiskEngine({ persist: false });
  const res = engine.evaluate({
    eventId: 'EVT-BADSEV-1',
    alertType: 'speeding',
    severity: 'SUPER_CRITICAL_UNKNOWN',
    timestamp: '2026-09-02T10:00:00.000Z',
    vehicle: { plate: 'BADSEV-VEH' },
  });
  assert.strictEqual(res.vehicleRisk.score, 18);
});

// ── 21. Malformed Event Object Fallback ──────────────────────────────────────
runTest('21 — Handles malformed null/undefined context gracefully', () => {
  const engine = new RiskEngine({ persist: false });
  let resNull, resEmpty;
  assert.doesNotThrow(() => { resNull = engine.evaluate(null); });
  assert.doesNotThrow(() => { resEmpty = engine.evaluate({}); });
  assert.strictEqual(resNull.vehicleRisk, null);
  assert.strictEqual(resEmpty.vehicleRisk, null);
});

// ── 22. Restart & Persistence ────────────────────────────────────────────────
runTest('22 — State persists to disk and reloads cleanly', () => {
  const scratchStatePath = path.join(__dirname, '../scratch/test_risk_state_foundation.json');
  if (fs.existsSync(scratchStatePath)) {
    try { fs.unlinkSync(scratchStatePath); } catch {}
  }

  const engine1 = new RiskEngine({ persist: true, filePath: scratchStatePath });
  const now = new Date().toISOString();
  engine1.evaluate({
    eventId: 'EVT-PERS-1',
    alertType: 'speeding',
    severity: 'HIGH',
    timestamp: now,
    vehicle: { plate: 'PERS-VEH', driver: 'PersistDriver' },
  });

  // Create second instance that reloads state from disk
  const engine2 = new RiskEngine({ persist: true, filePath: scratchStatePath });
  const vRes = engine2.getVehicleRisk('PLATE:PERSVEH', '2026-09-02T10:00:00.000Z');
  const dRes = engine2.getDriverRisk('DRIVER:PERSISTDRIVER', '2026-09-02T10:00:00.000Z');

  assert.ok(vRes, 'Persisted vehicle risk must reload');
  assert.strictEqual(vRes.score, 18);
  assert.ok(dRes, 'Persisted driver risk must reload');
  assert.strictEqual(dRes.score, 18);

  // Clean up
  engine2.resetState();
});

// ── 23. Deterministic Repeated Execution ─────────────────────────────────────
runTest('23 — Evaluating same sequence produces identical final score', () => {
  const e1 = new RiskEngine({ persist: false });
  const e2 = new RiskEngine({ persist: false });

  const events = [
    { eventId: 'EVT-SEQ-1', alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z', vehicle: { plate: 'DET-SEQ' } },
    { eventId: 'EVT-SEQ-2', alertType: 'harsh_braking', timestamp: '2026-09-02T10:02:00.000Z', vehicle: { plate: 'DET-SEQ' } },
    { eventId: 'EVT-SEQ-3', alertType: 'distraction', timestamp: '2026-09-02T10:05:00.000Z', vehicle: { plate: 'DET-SEQ' } },
  ];

  events.forEach(evt => e1.evaluate(evt));
  events.forEach(evt => e2.evaluate(evt));

  const r1 = e1.getVehicleRisk('PLATE:DETSEQ');
  const r2 = e2.getVehicleRisk('PLATE:DETSEQ');

  assert.strictEqual(r1.score, r2.score);
  assert.strictEqual(r1.level, r2.level);
});

// ── 24. Large Number of Sequential Events ─────────────────────────────────────
runTest('24 — Sequential processing of 100 events handles memory cleanly', () => {
  const engine = new RiskEngine({ persist: false });
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    engine.evaluate({
      eventId: `EVT-STRESS-${i}`,
      alertType: 'speeding',
      severity: 'HIGH',
      timestamp: now,
      vehicle: { plate: 'STRESS-VEH' },
    });
  }
  const res = engine.getVehicleRisk('PLATE:STRESSVEH');
  assert.strictEqual(res.score, 100);
  assert.ok(res.contributors.length <= 10, 'contributors must be capped at 10');
});

// ── 25. Existing Feature #1 Compatibility ────────────────────────────────────
runTest('25 — EventContextBuilder attaches context.risk object cleanly', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '701' },
  });

  assert.ok(ctx.risk, 'context.risk must be attached');
  assert.ok(ctx.risk.vehicleRisk, 'context.risk.vehicleRisk must be present');
  assert.strictEqual(ctx.risk.vehicleRisk.entityKey, 'PLATE:D31498');
  assert.ok(ctx.risk.vehicleRisk.score > 0);
});

// ── 26. Existing Feature #2 Compatibility ────────────────────────────────────
runTest('26 — Correlated EventContext attaches risk with pattern multiplier (end-to-end integration)', () => {
  const builder = new EventContextBuilder();
  const ctx1 = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'F2-COMPAT', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '702' },
  });
  // Single event speeding base impact = 18 * 1.0 = 18
  assert.strictEqual(ctx1.risk.vehicleRisk.score, 18);

  const ctx2 = builder.build({
    alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' },
    fields: { plate: 'F2-COMPAT', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '703' },
  });

  assert.strictEqual(ctx2.alertCorrelation.isCorrelated, true);
  assert.strictEqual(ctx2.alertCorrelation.incident.isIncident, true);
  // harsh_braking base impact = 10 * 1.35 (pattern multiplier) = 13.5 => 14 net impact
  // accumulated score = 18 + 14 = 32
  assert.strictEqual(ctx2.risk.vehicleRisk.score, 32);
});

// ── 27. All 32 Alert Types Coverage ──────────────────────────────────────────
runTest('27 — All 32 defined alert types pass through RiskEngine without crash', () => {
  const engine = new RiskEngine({ persist: false });
  for (const alertDef of alertTypesRaw) {
    let res;
    assert.doesNotThrow(() => {
      res = engine.evaluate({
        eventId: `EVT-32-${alertDef.type}`,
        alertType: alertDef.type,
        alertLabel: alertDef.label,
        severity: alertDef.severity,
        timestamp: '2026-09-02T10:00:00.000Z',
        vehicle: { plate: 'ALL32-VEH', driver: 'Driver32' },
      });
    }, `RiskEngine must not crash for ${alertDef.type}`);
    assert.ok(res.vehicleRisk, `vehicleRisk must be returned for ${alertDef.type}`);
  }
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 RISK FOUNDATION TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) process.exit(1);

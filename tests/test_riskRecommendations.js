/**
 * tests/test_riskRecommendations.js
 *
 * Comprehensive Test Suite for Feature #3 Phase 3 — Operational Recommendations & Manager Action Directives
 *
 * Tests all 36 requirements specified in the Phase 3 Master Prompt.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const RiskEngine                     = require('../services/riskEngine');
const RiskTrendEngine                = require('../services/riskTrendEngine');
const OperationalRecommendationEngine = require('../services/operationalRecommendationEngine');
const EventContextBuilder            = require('../services/eventContext');

const alertTypesRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/alertTypes.json'), 'utf8'));

const VALID_URGENCIES = new Set(['IMMEDIATE_ACTION', 'HIGH_PRIORITY', 'FOLLOW_UP', 'MONITOR', 'NO_ACTION']);
const VALID_CATEGORIES = new Set([
  'DRIVER_COACHING_REQUIRED',
  'IMMEDIATE_DRIVER_CONTACT',
  'SAFETY_REVIEW_REQUIRED',
  'VEHICLE_INSPECTION_REQUIRED',
  'SECURITY_REVIEW_REQUIRED',
  'CONNECTIVITY_CHECK_REQUIRED',
  'ROUTE_REVIEW_REQUIRED',
  'FUEL_INVESTIGATION_REQUIRED',
  'MONITOR_ONLY',
  'NO_ACTION_REQUIRED',
]);

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
console.log('🧪 FEATURE #3 PHASE 3 — OPERATIONAL RECOMMENDATIONS TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// ── 1. Basic Low Risk Recommendation ─────────────────────────────────────────
runTest('1 — Low risk activity maps to MONITOR or NO_ACTION urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'ignition_on', severity: 'LOW', vehicle: { plate: 'LOW-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:LOWVEH', score: 5, level: 'LOW' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle);
  assert.strictEqual(res.vehicle.riskLevel, 'LOW');
  assert.ok(VALID_URGENCIES.has(res.vehicle.recommendedAction.urgency));
  assert.ok(res.vehicle.recommendedAction.urgency === 'MONITOR' || res.vehicle.recommendedAction.urgency === 'NO_ACTION');
});

// ── 2. Medium Risk Recommendation ────────────────────────────────────────────
runTest('2 — Medium risk activity maps to FOLLOW_UP urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'harsh_acceleration', severity: 'MEDIUM', vehicle: { plate: 'MED-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:MEDVEH', score: 28, level: 'MEDIUM' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.riskLevel, 'MEDIUM');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'FOLLOW_UP');
  assert.strictEqual(res.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
});

// ── 3. High Risk Recommendation ──────────────────────────────────────────────
runTest('3 — High risk activity maps to HIGH_PRIORITY urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'HIGH-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:HIGHVEH', score: 72, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.riskLevel, 'HIGH');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'HIGH_PRIORITY');
});

// ── 4. Critical Risk Recommendation ──────────────────────────────────────────
runTest('4 — Critical risk activity maps to IMMEDIATE_ACTION urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'accident', severity: 'CRITICAL', vehicle: { plate: 'CRIT-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:CRITVEH', score: 95, level: 'CRITICAL' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.riskLevel, 'CRITICAL');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
  assert.strictEqual(res.vehicle.recommendedAction.category, 'SAFETY_REVIEW_REQUIRED');
});

// ── 5. Rising Risk Escalates Urgency ─────────────────────────────────────────
runTest('5 — HIGH risk + RISING trend escalates urgency to IMMEDIATE_ACTION', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'RISE-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:RISEVEH', score: 75, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 6. Stable Risk Recommendation ────────────────────────────────────────────
runTest('6 — Stable risk maintains level-appropriate urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'STB-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:STBVEH', score: 72, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'HIGH_PRIORITY');
});

// ── 7. Improving Risk Recommendation ─────────────────────────────────────────
runTest('7 — Improving risk trajectory generates appropriate directive', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'IMP-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:IMPVEH', score: 48, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'IMPROVING' } };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle.operationalMeaning);
});

// ── 8. Repeated Speeding Recommendation ──────────────────────────────────────
runTest('8 — Speeding generates speed-specific directive', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH', vehicle: { plate: 'SPD-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:SPDVEH', score: 55, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING', repeatedBehaviors: [{ alertType: 'speeding', alertLabel: 'Over Speed', count: 3, repeated: true }] } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
  assert.ok(res.vehicle.recommendedAction.directive.includes('speed limits'));
});

// ── 9. Repeated Harsh Braking ────────────────────────────────────────────────
runTest('9 — Harsh braking maps to smooth driving handling directive (not speed limits)', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'harsh_braking', severity: 'MEDIUM', vehicle: { plate: 'BRK-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:BRKVEH', score: 30, level: 'MEDIUM' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
  assert.ok(res.vehicle.recommendedAction.directive.includes('smooth driving standards'));
  assert.ok(!res.vehicle.recommendedAction.directive.includes('enforce speed limits'));
});

// ── 10. Distraction ──────────────────────────────────────────────────────────
runTest('10 — Driver distraction maps to cabin distraction policy directive (not speed limits)', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'distraction', severity: 'HIGH', vehicle: { plate: 'DST-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:DSTVEH', score: 50, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
  assert.ok(res.vehicle.recommendedAction.directive.includes('cabin distraction policy'));
});

// ── 11. Fatigue ──────────────────────────────────────────────────────────────
runTest('11 — Fatigue driving maps to IMMEDIATE_DRIVER_CONTACT', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'fatigue', severity: 'HIGH', vehicle: { plate: 'FAT-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:FATVEH', score: 60, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'IMMEDIATE_DRIVER_CONTACT');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 12. Drinking While Driving ───────────────────────────────────────────────
runTest('12 — Drinking while driving maps to IMMEDIATE_DRIVER_CONTACT & IMMEDIATE_ACTION', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'drinking', severity: 'HIGH', vehicle: { plate: 'DRK-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:DRKVEH', score: 65, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'IMMEDIATE_DRIVER_CONTACT');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 13. Seatbelt ─────────────────────────────────────────────────────────────
runTest('13 — Seatbelt alert maps to mandatory seatbelt usage directive', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'seatbelt', severity: 'HIGH', vehicle: { plate: 'SBLT-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:SBLTVEH', score: 40, level: 'MEDIUM' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
  assert.ok(res.vehicle.recommendedAction.directive.includes('mandatory seatbelt usage policy'));
});

// ── 14. Accident ─────────────────────────────────────────────────────────────
runTest('14 — Accident alert maps to SAFETY_REVIEW_REQUIRED and IMMEDIATE_ACTION', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'accident', severity: 'CRITICAL', vehicle: { plate: 'ACC-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:ACCVEH', score: 90, level: 'CRITICAL' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'SAFETY_REVIEW_REQUIRED');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 15. SOS Emergency ────────────────────────────────────────────────────────
runTest('15 — SOS panic alert maps to IMMEDIATE_DRIVER_CONTACT and IMMEDIATE_ACTION', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'sos', severity: 'CRITICAL', vehicle: { plate: 'SOS-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:SOSVEH', score: 90, level: 'CRITICAL' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'IMMEDIATE_DRIVER_CONTACT');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 16. Engine Failure ───────────────────────────────────────────────────────
runTest('16 — Engine failure alert maps to VEHICLE_INSPECTION_REQUIRED and IMMEDIATE_ACTION', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'engine_failure', severity: 'CRITICAL', vehicle: { plate: 'ENG-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:ENGVEH', score: 85, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'VEHICLE_INSPECTION_REQUIRED');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 17. Device Tampering ─────────────────────────────────────────────────────
runTest('17 — Tampering alert maps to SECURITY_REVIEW_REQUIRED', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'tampering', severity: 'HIGH', vehicle: { plate: 'TMP-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:TMPVEH', score: 50, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'SECURITY_REVIEW_REQUIRED');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'HIGH_PRIORITY');
});

// ── 18. GPS / LTE Connectivity ───────────────────────────────────────────────
runTest('18 — GPS lost alert maps to CONNECTIVITY_CHECK_REQUIRED', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'gps_lost', severity: 'HIGH', vehicle: { plate: 'GPS-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:GPSVEH', score: 40, level: 'MEDIUM' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'CONNECTIVITY_CHECK_REQUIRED');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'FOLLOW_UP');
});

// ── 19. Fuel Drop ────────────────────────────────────────────────────────────
runTest('19 — Fuel drop alert maps to FUEL_INVESTIGATION_REQUIRED', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'fuel_drop', severity: 'HIGH', vehicle: { plate: 'FUEL-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:FUELVEH', score: 55, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'FUEL_INVESTIGATION_REQUIRED');
});

// ── 20. Geofence Exit ────────────────────────────────────────────────────────
runTest('20 — Geofence exit alert maps to ROUTE_REVIEW_REQUIRED', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'geofence_exit', severity: 'HIGH', vehicle: { plate: 'GEO-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:GEOVEH', score: 35, level: 'MEDIUM' } };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'ROUTE_REVIEW_REQUIRED');
});

// ── 21. Signal Recovery Alert ────────────────────────────────────────────────
runTest('21 — GPS restored alert maps to MONITOR_ONLY category and MONITOR urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'gps_restored', severity: 'LOW', vehicle: { plate: 'REC-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:RECVEH', score: 10, level: 'LOW' } };
  ctx.riskTrend = { vehicle: { trend: 'IMPROVING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.category, 'MONITOR_ONLY');
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'MONITOR');
});

// ── 22. Feature #2 Correlated Incident Pattern ────────────────────────────────
runTest('22 — Feature #2 correlated incident influences operational meaning', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = {
    alertType: 'speeding',
    severity: 'HIGH',
    vehicle: { plate: 'CORR-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      incident: { isIncident: true, label: 'Aggressive Driving' }
    }
  };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:CORRVEH', score: 65, level: 'ELEVATED' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle.operationalMeaning);
});

// ── 23. Feature #3.2 Escalated Incident ──────────────────────────────────────
runTest('23 — Escalated incident forces IMMEDIATE_ACTION urgency', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = {
    alertType: 'accident',
    severity: 'CRITICAL',
    vehicle: { plate: 'ESC-VEH' },
    alertCorrelation: {
      isCorrelated: true,
      incident: {
        isIncident: true,
        intelligence: { escalation: { detected: true } }
      }
    }
  };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:ESCVEH', score: 85, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

// ── 24. Vehicle-Only Recommendation ──────────────────────────────────────────
runTest('24 — Device tampering produces vehicle recommendation but not driver recommendation', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'tampering', severity: 'HIGH', vehicle: { plate: 'VONLY-VEH', driver: null } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:VONLYVEH', score: 40, level: 'MEDIUM' }, driverRisk: null };
  ctx.riskTrend = { vehicle: { trend: 'STABLE' }, driver: null };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle);
  assert.strictEqual(res.driver, null);
});

// ── 25. Driver Recommendation ────────────────────────────────────────────────
runTest('25 — Named driver receives separate driver recommendation object', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'DRV-VEH', driver: 'Khalid' } };
  ctx.risk = {
    vehicleRisk: { entityKey: 'PLATE:DRVVEH', score: 40, level: 'MEDIUM' },
    driverRisk: { entityKey: 'DRIVER:KHALID', score: 40, level: 'MEDIUM' }
  };
  ctx.riskTrend = {
    vehicle: { trend: 'STABLE' },
    driver: { trend: 'STABLE' }
  };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle);
  assert.ok(res.driver);
  assert.strictEqual(res.driver.entityKey, 'DRIVER:KHALID');
  assert.strictEqual(res.driver.recommendedAction.category, 'DRIVER_COACHING_REQUIRED');
});

// ── 26. Missing Driver Handling ──────────────────────────────────────────────
runTest('26 — Driver recommendation is null when driver identity is missing', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'NODRV-VEH', driver: null } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:NODRVVEH', score: 40, level: 'MEDIUM' }, driverRisk: null };

  const res = engine.generate(ctx);
  assert.strictEqual(res.driver, null);
});

// ── 27. Unknown Alert Type Fallback ──────────────────────────────────────────
runTest('27 — Unknown alert type returns safe default category and directive', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'unknown_custom_alert', severity: 'MEDIUM', vehicle: { plate: 'UNK-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:UNKVEH', score: 25, level: 'MEDIUM' } };

  const res = engine.generate(ctx);
  assert.ok(res.vehicle);
  assert.ok(VALID_CATEGORIES.has(res.vehicle.recommendedAction.category));
  assert.ok(VALID_URGENCIES.has(res.vehicle.recommendedAction.urgency));
});

// ── 28. Null / Malformed Context Fallback ────────────────────────────────────
runTest('28 — Null or malformed context returns safe default without crash', () => {
  const engine = new OperationalRecommendationEngine();
  let r1, r2;
  assert.doesNotThrow(() => { r1 = engine.generate(null); });
  assert.doesNotThrow(() => { r2 = engine.generate({}); });

  assert.strictEqual(r1.vehicle, null);
  assert.strictEqual(r2.driver, null);
});

// ── 29. Determinism ──────────────────────────────────────────────────────────
runTest('29 — Identical input context produces identical riskRecommendation', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'DET-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:DETVEH', score: 70, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const r1 = engine.generate(ctx);
  const r2 = engine.generate(ctx);

  assert.strictEqual(r1.vehicle.recommendedAction.urgency, r2.vehicle.recommendedAction.urgency);
  assert.strictEqual(r1.vehicle.recommendedAction.category, r2.vehicle.recommendedAction.category);
  assert.strictEqual(r1.vehicle.operationalMeaning, r2.vehicle.operationalMeaning);
});

// ── 30. JSON Serialization Safety ────────────────────────────────────────────
runTest('30 — riskRecommendation serializes cleanly to JSON (no NaN, undefined)', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'JSON-REC-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '1001' },
  });

  let serialized;
  assert.doesNotThrow(() => { serialized = JSON.stringify(ctx.riskRecommendation); });
  assert.ok(!serialized.includes(':undefined'));
  assert.ok(!serialized.includes(':NaN'));
});

// ── 31. Phase 1 Contract Preservation Guard ──────────────────────────────────
runTest('31 — Phase 1 scores and levels remain 100% preserved', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'P1-GUARD-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '1002' },
  });

  assert.strictEqual(ctx.risk.vehicleRisk.score, 18);
  assert.strictEqual(ctx.risk.vehicleRisk.level, 'LOW');
});

// ── 32. Phase 2 Contract Preservation Guard ──────────────────────────────────
runTest('32 — Phase 2 trends and explanations remain 100% preserved', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'P2-GUARD-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '1003' },
  });

  assert.ok(ctx.riskTrend.vehicle);
  assert.strictEqual(ctx.riskTrend.vehicle.trend, 'RISING');
  assert.strictEqual(ctx.riskTrend.vehicle.explanation.primaryReason, 'NEW_HIGH_SEVERITY_EVENT');
});

// ── 33. All 32 Alert Types Coverage ──────────────────────────────────────────
runTest('33 — All 32 defined alert types pass through OperationalRecommendationEngine without crash', () => {
  const engine = new OperationalRecommendationEngine();
  const riskEngine = new RiskEngine({ persist: false });
  const trendEngine = new RiskTrendEngine();

  for (const alertDef of alertTypesRaw) {
    const ctx = {
      eventId: `E-33-${alertDef.type}`,
      alertType: alertDef.type,
      alertLabel: alertDef.label,
      severity: alertDef.severity,
      timestamp: '2026-09-02T10:00:00.000Z',
      vehicle: { plate: 'ALL32-REC-VEH', driver: 'Driver32' },
    };
    ctx.risk = riskEngine.evaluate(ctx);
    ctx.riskTrend = trendEngine.analyze(ctx);

    let res;
    assert.doesNotThrow(() => { res = engine.generate(ctx); }, `Engine must not crash for ${alertDef.type}`);
    assert.ok(res.vehicle, `vehicle recommendation must exist for ${alertDef.type}`);
    assert.ok(VALID_URGENCIES.has(res.vehicle.recommendedAction.urgency), `valid urgency for ${alertDef.type}`);
    assert.ok(VALID_CATEGORIES.has(res.vehicle.recommendedAction.category), `valid category for ${alertDef.type}`);
  }
});

// ── 34. Complete Backward Compatibility ──────────────────────────────────────
runTest('34 — EventContextBuilder attaches risk, riskTrend, and riskRecommendation additively', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'COMPAT-ALL-VEH', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '1004' },
  });

  assert.ok(ctx.eventId);
  assert.ok(ctx.recentActivity);
  assert.ok(ctx.contextIntelligence);
  assert.ok(ctx.alertCorrelation);
  assert.ok(ctx.risk);
  assert.ok(ctx.riskTrend);
  assert.ok(ctx.riskRecommendation);
});

// ── 35. Category Validity Guard ──────────────────────────────────────────────
runTest('35 — All generated recommendation categories are within defined valid set', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'fuel_drop', severity: 'HIGH', vehicle: { plate: 'CAT-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:CATVEH', score: 50, level: 'ELEVATED' } };

  const res = engine.generate(ctx);
  assert.ok(VALID_CATEGORIES.has(res.vehicle.recommendedAction.category));
});

// ── 36. Urgency Validity Guard ───────────────────────────────────────────────
runTest('36 — All generated recommendation urgencies are within defined valid set', () => {
  const engine = new OperationalRecommendationEngine();
  const ctx = { alertType: 'speeding', severity: 'HIGH', vehicle: { plate: 'URG-VEH' } };
  ctx.risk = { vehicleRisk: { entityKey: 'PLATE:URGVEH', score: 80, level: 'HIGH' } };
  ctx.riskTrend = { vehicle: { trend: 'RISING' } };

  const res = engine.generate(ctx);
  assert.ok(VALID_URGENCIES.has(res.vehicle.recommendedAction.urgency));
  assert.strictEqual(res.vehicle.recommendedAction.urgency, 'IMMEDIATE_ACTION');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 RISK RECOMMENDATIONS TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) process.exit(1);

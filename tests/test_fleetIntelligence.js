/**
 * tests/test_fleetIntelligence.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * Validates deterministic fleet aggregation, vehicle grouping, metric totals,
 * repeated behavior detection, and priority rank ordering.
 */

'use strict';

const assert = require('assert');
const FleetIntelligenceEngine = require('../services/fleetIntelligenceEngine');
const AIFleetGroundTruthBuilder = require('../services/aiFleetGroundTruthBuilder');
const EventContextBuilder = require('../services/eventContext');

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
  console.log('🧪 FEATURE #4 PHASE 3 — FLEET INTELLIGENCE & PRIORITY TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const engine = new FleetIntelligenceEngine();
  const builder = new AIFleetGroundTruthBuilder({ fleetEngine: engine });

  // ── 1. Empty Fleet Handling ────────────────────────────────────────────────
  runTest('1 — Empty record array yields clean zeroed fleet intelligence', () => {
    const res = engine.evaluateFleet(24, []);
    assert.strictEqual(res.fleetMetrics.vehicleCount, 0);
    assert.strictEqual(res.fleetMetrics.alertCount, 0);
    assert.strictEqual(res.vehicles.length, 0);
    assert.strictEqual(res.priorities.length, 0);
  });

  // ── 2. Single Vehicle Aggregation ──────────────────────────────────────────
  runTest('2 — Single vehicle alert is grouped and assigned priority rank 1', () => {
    const records = [
      { plate: 'VEH-001', alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH', vehicleModel: 'Ford Transit', receivedAt: new Date().toISOString() }
    ];
    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.fleetMetrics.vehicleCount, 1);
    assert.strictEqual(res.fleetMetrics.alertCount, 1);
    assert.strictEqual(res.vehicles[0].plate, 'VEH-001');
    assert.strictEqual(res.priorities[0].priorityRank, 1);
  });

  // ── 3. Multi-Vehicle Priority Sorting ──────────────────────────────────────
  runTest('3 — Deterministic priority sorting places CRITICAL vehicle above LOW vehicle', () => {
    const records = [
      { plate: 'LOW-VEH', alertType: 'ignition_on', alertLabel: 'Ignition ON', severity: 'LOW', receivedAt: new Date().toISOString() },
      { plate: 'CRIT-VEH', alertType: 'accident', alertLabel: 'Accident Detected', severity: 'CRITICAL', receivedAt: new Date().toISOString() }
    ];
    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.priorities[0].plate, 'CRIT-VEH');
    assert.strictEqual(res.priorities[1].plate, 'LOW-VEH');
  });

  // ── 4. RISING Trend Prioritization ─────────────────────────────────────────
  runTest('4 — Vehicle with RISING trend gets higher priority weight than STABLE vehicle', () => {
    const ctxBuilder = new EventContextBuilder();
    const ctxStable = ctxBuilder.build({ alertDef: { type: 'ignition_on', severity: 'LOW' }, fields: { plate: 'STABLE-VEH' } });
    const ctxRising = ctxBuilder.build({ alertDef: { type: 'speeding', severity: 'HIGH' }, fields: { plate: 'RISING-VEH', speed: 120, speedLimit: 80 } });

    const records = [
      { plate: 'STABLE-VEH', alertType: 'ignition_on', severity: 'LOW', context: ctxStable },
      { plate: 'RISING-VEH', alertType: 'speeding', severity: 'HIGH', context: ctxRising }
    ];
    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.priorities[0].plate, 'RISING-VEH');
  });

  // ── 5. Repeated Behavior Detection ─────────────────────────────────────────
  runTest('5 — Identifies repeated behavior patterns across multiple alerts for same vehicle', () => {
    const records = [
      { plate: 'REP-VEH', alertType: 'speeding', severity: 'HIGH', receivedAt: new Date().toISOString() },
      { plate: 'REP-VEH', alertType: 'speeding', severity: 'HIGH', receivedAt: new Date().toISOString() }
    ];
    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.vehicles[0].repeatedBehaviors.length, 1);
    assert.strictEqual(res.vehicles[0].repeatedBehaviors[0].alertType, 'speeding');
    assert.strictEqual(res.vehicles[0].repeatedBehaviors[0].count, 2);
  });

  // ── 6. Dominant Patterns Extraction ────────────────────────────────────────
  runTest('6 — Dominant fleet patterns are extracted and sorted by frequency', () => {
    const records = [
      { plate: 'V1', alertType: 'speeding', severity: 'HIGH' },
      { plate: 'V2', alertType: 'speeding', severity: 'HIGH' },
      { plate: 'V3', alertType: 'idle', severity: 'LOW' }
    ];
    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.patterns[0].type, 'speeding');
    assert.strictEqual(res.patterns[0].count, 2);
    assert.strictEqual(res.patterns[0].affectedVehicles, 2);
  });

  // ── 7. Bounded Output Caps ──────────────────────────────────────────────────
  runTest('7 — Vehicles and priorities are capped to performance bounds', () => {
    const records = [];
    for (let i = 0; i < 30; i++) {
      records.push({ plate: `CAP-VEH-${i}`, alertType: 'speeding', severity: 'HIGH' });
    }
    const res = engine.evaluateFleet(24, records);
    assert.ok(res.vehicles.length <= 20, 'Vehicles must be capped at 20');
    assert.ok(res.priorities.length <= 5, 'Priorities must be capped at 5');
  });

  // ── 8. AIFleetGroundTruthBuilder Contract Schema ───────────────────────────
  runTest('8 — AIFleetGroundTruthBuilder produces valid schemaVersion 1.0 contract', () => {
    const records = [{ plate: 'GT-01', alertType: 'speeding', severity: 'HIGH' }];
    const gt = builder.build(records);

    assert.strictEqual(gt.schemaVersion, '1.0');
    assert.strictEqual(gt.grounding.mode, 'FLEET_STRUCTURED_GROUND_TRUTH');
    assert.strictEqual(gt.grounding.authoritative, true);
    assert.ok(gt.fleet);
    assert.ok(Array.isArray(gt.vehicles));
    assert.ok(Array.isArray(gt.priorities));
  });

  // ── 9. Missing Driver Handling ─────────────────────────────────────────────
  runTest('9 — Null driver identity is preserved cleanly in ground truth contract', () => {
    const records = [{ plate: 'NODRIVER-1', alertType: 'tampering', severity: 'HIGH', driver: null }];
    const gt = builder.build(records);
    assert.strictEqual(gt.vehicles[0].driver, null);
    assert.strictEqual(gt.priorities[0].driver, null);
  });

  // ── 10. All 32 Alert Types Compatibility ────────────────────────────────────
  runTest('10 — All 32 alert types pass through FleetIntelligenceEngine cleanly', () => {
    const alertTypes = [
      'speeding', 'harsh_braking', 'harsh_acceleration', 'harsh_cornering', 'fatigue',
      'distraction', 'phone_use', 'smoking', 'seatbelt', 'yawning',
      'accident', 'sos', 'tampering', 'geofence_exit', 'geofence_entry',
      'idle', 'low_battery', 'power_cut', 'offline', 'towing',
      'vibration', 'door_open', 'temperature_high', 'fuel_drop', 'fuel_leak',
      'engine_failure', 'maintenance_due', 'inspection_overdue', 'camera_blocked', 'gps_lost',
      'gps_restored', 'ignition_on'
    ];

    const records = alertTypes.map((type, i) => ({
      plate: `ALL-${i}`, alertType: type, severity: 'MEDIUM', receivedAt: new Date().toISOString()
    }));

    const res = engine.evaluateFleet(24, records);
    assert.strictEqual(res.fleetMetrics.alertCount, 32);
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 FLEET INTELLIGENCE TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests();

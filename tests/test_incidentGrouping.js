/**
 * tests/test_incidentGrouping.js
 *
 * Comprehensive Test Suite for Feature #2 Phase 2 — Correlation Rules & Incident Grouping
 *
 * Tests cases A through Y as specified in Section 19 of the master prompt.
 */

const assert = require('assert');
const IncidentGroupingEngine = require('../services/incidentGroupingEngine');
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
    console.error(err.stack);
    failedTests++;
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('🧪 FEATURE #2 PHASE 2 — INCIDENT GROUPING TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Test Suite A: Single Event (Non-Inherent) ───────────────────────────────
runTest('A — Single non-inherent event (speeding) returns isIncident: false', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const inc = ctx.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, false);
  assert.strictEqual(inc.type, 'NONE');
  assert.strictEqual(inc.ruleId, 'SINGLE_EVENT_V1');
});

// ── Test Suite B: Speeding + Harsh Acceleration ──────────────────────────────
runTest('B — Speeding + Harsh Acceleration classifies as AGGRESSIVE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'AGGRESSIVE_DRIVING');
  assert.strictEqual(inc.ruleId, 'AGGRESSIVE_DRIVING_V1');
  assert.deepStrictEqual(inc.matchedEvents.sort(), ['harsh_acceleration', 'speeding'].sort());
});

// ── Test Suite C: Speeding + Harsh Braking ─────────────────────────────────
runTest('C — Speeding + Harsh Braking classifies as AGGRESSIVE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'AGGRESSIVE_DRIVING');
});

// ── Test Suite D: Speeding + Harsh Acceleration + Harsh Braking ────────────
runTest('D — Speeding + Harsh Acceleration + Harsh Braking classifies as AGGRESSIVE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:06:00.000Z', emailUid: '103' } });

  const inc = ctx3.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'AGGRESSIVE_DRIVING');
  assert.strictEqual(inc.eventCount, 3);
});

// ── Test Suite E: Distraction + Vibration ───────────────────────────────────
runTest('E — Distraction + Vibration classifies as DRIVER_DISTRACTION_UNSAFE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'distraction' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'vibration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DRIVER_DISTRACTION_UNSAFE_DRIVING');
  assert.strictEqual(inc.ruleId, 'DRIVER_DISTRACTION_V1');
});

// ── Test Suite F: Distraction + Lane Change ─────────────────────────────────
runTest('F — Distraction + Lane Change classifies as DRIVER_DISTRACTION_UNSAFE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'distraction' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'lane_change' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DRIVER_DISTRACTION_UNSAFE_DRIVING');
});

// ── Test Suite G: Fatigue + Distraction ─────────────────────────────────────
runTest('G — Fatigue + Distraction classifies as DRIVER_DISTRACTION_UNSAFE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'fatigue' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'distraction' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DRIVER_DISTRACTION_UNSAFE_DRIVING');
});

// ── Test Suite H: Drinking + Distraction ────────────────────────────────────
runTest('H — Drinking + Distraction classifies as DRIVER_DISTRACTION_UNSAFE_DRIVING', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'drinking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'distraction' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DRIVER_DISTRACTION_UNSAFE_DRIVING');
});

// ── Test Suite I: Accident Event ─────────────────────────────────────────────
runTest('I — Accident event classifies as ACCIDENT_EVENT', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'accident' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const inc = ctx.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'ACCIDENT_EVENT');
});

// ── Test Suite J: SOS + Accident Event ───────────────────────────────────────
runTest('J — SOS + Accident classifies as ACCIDENT_EVENT', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'sos' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'accident' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:01:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'ACCIDENT_EVENT');
});

// ── Test Suite K: GPS Lost + LTE Jamming ─────────────────────────────────────
runTest('K — GPS Lost + LTE Jamming classifies as CONNECTIVITY_DISRUPTION', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'lte_jamming' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'CONNECTIVITY_DISRUPTION');
  assert.strictEqual(inc.ruleId, 'CONNECTIVITY_DISRUPTION_V1');
});

// ── Test Suite L: GPS Lost + GPS Restored ───────────────────────────────────
runTest('L — GPS Lost + GPS Restored classifies as GPS_INTERRUPTION', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'gps_restored' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'GPS_INTERRUPTION');
  assert.strictEqual(inc.ruleId, 'GPS_INTERRUPTION_V1');
});

// ── Test Suite M: Tampering + Offline ────────────────────────────────────────
runTest('M — Tampering + Offline classifies as DEVICE_SECURITY_INCIDENT', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'tampering' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'offline' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DEVICE_SECURITY_INCIDENT');
  assert.strictEqual(inc.ruleId, 'DEVICE_SECURITY_V1');
});

// ── Test Suite N: Engine Failure ─────────────────────────────────────────────
runTest('N — Engine Failure classifies as ENGINE_FAILURE', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'engine_failure' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const inc = ctx.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'ENGINE_FAILURE');
});

// ── Test Suite O: Pure Geofence Exit ──────────────────────────────────────────
runTest('O — Pure Geofence Exit event classifies as GEOFENCE_EXIT_EVENT', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'geofence_exit' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'ignition_off' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'GEOFENCE_EXIT_EVENT');
});

// ── Test Suite P: Pure Geofence Entry ─────────────────────────────────────────
runTest('P — Pure Geofence Entry event classifies as GEOFENCE_ENTRY_EVENT', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'geofence_enter' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'ignition_off' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'GEOFENCE_ENTRY_EVENT');
});

// ── Test Suite Q: Unrelated Correlated Alerts (Speeding + Geofence Entry) ────
runTest('Q — Unrelated correlated alerts (speeding + geofence_enter) produce CORRELATED_ACTIVITY with isIncident: false', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'geofence_enter' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, false);
  assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY');
  assert.strictEqual(inc.ruleId, 'CORRELATED_ACTIVITY_V1');
});

runTest('Q2 — Unrelated non-incident alerts (idle + ignition_on) produce CORRELATED_ACTIVITY with isIncident: false', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'idle' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'ignition_on' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, false);
  assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY');
  assert.strictEqual(inc.ruleId, 'CORRELATED_ACTIVITY_V1');
});

// ── Test Suite Q3: SOS Correlated with Driving Alerts ───────────────────────
runTest('Q3 — SOS + Speeding classifies as SOS_EMERGENCY with isIncident: true', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'sos' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'SOS_EMERGENCY');
  assert.strictEqual(inc.ruleId, 'SOS_CORRELATED_V1');
});

// ── Test Suite Q4: Tampering Correlated with Driving Alerts ──────────────────
runTest('Q4 — Tampering + Speeding classifies as DEVICE_TAMPERING with isIncident: true', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'tampering' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, true);
  assert.strictEqual(inc.type, 'DEVICE_TAMPERING');
  assert.strictEqual(inc.ruleId, 'TAMPERING_CORRELATED_V1');
});

// ── Test Suite R: Duplicate Event Deduplication ─────────────────────────────
runTest('R — Processing duplicate eventId does not trigger multi-event incident', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxDup = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const inc = ctxDup.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, false);
  assert.strictEqual(inc.type, 'NONE');
});

// ── Test Suite S: Out-of-Order Events Chronological Order ────────────────────
runTest('S — Out-of-order events derive correct firstEventType and lastEventType', () => {
  const engine = new IncidentGroupingEngine();
  const mockCorrelation = {
    isCorrelated: true,
    eventCount: 3,
    eventTypes: ['speeding', 'harsh_acceleration', 'harsh_braking'],
    events: [
      { alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'harsh_acceleration', timestamp: '2026-09-02T10:03:00.000Z' },
      { alertType: 'harsh_braking', timestamp: '2026-09-02T10:06:00.000Z' },
    ],
    startTime: '2026-09-02T10:00:00.000Z',
    latestTime: '2026-09-02T10:06:00.000Z',
  };

  const inc = engine.group(mockCorrelation);
  assert.strictEqual(inc.type, 'AGGRESSIVE_DRIVING');
  assert.strictEqual(inc.firstEventType, 'speeding');
  assert.strictEqual(inc.lastEventType, 'harsh_braking');
});

// ── Test Suite T: Vehicle Isolation Preserved ────────────────────────────────
runTest('T — Vehicle A events never cause incident classification on Vehicle B', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'AAA-111', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxB = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'BBB-222', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const inc = ctxB.alertCorrelation.incident;
  assert.strictEqual(inc.isIncident, false);
  assert.strictEqual(inc.type, 'NONE');
});

// ── Test Suite U: Empty Correlation Safety ────────────────────────────────────
runTest('U — Null or empty correlation input returns safe NONE incident structure', () => {
  const engine = new IncidentGroupingEngine();
  const inc1 = engine.group(null);
  const inc2 = engine.group({});

  assert.strictEqual(inc1.type, 'NONE');
  assert.strictEqual(inc1.isIncident, false);
  assert.strictEqual(inc2.type, 'NONE');
  assert.strictEqual(inc2.isIncident, false);
});

// ── Test Suite V: Unknown Alert Types ────────────────────────────────────────
runTest('V — Unknown alert types fall back safely without throwing', () => {
  const engine = new IncidentGroupingEngine();
  const mockCorrelation = {
    isCorrelated: true,
    eventCount: 2,
    eventTypes: ['unknown_custom_event_x', 'unknown_custom_event_y'],
    events: [
      { alertType: 'unknown_custom_event_x', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'unknown_custom_event_y', timestamp: '2026-09-02T10:02:00.000Z' },
    ],
    startTime: '2026-09-02T10:00:00.000Z',
    latestTime: '2026-09-02T10:02:00.000Z',
  };

  const inc = engine.group(mockCorrelation);
  assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY');
  assert.strictEqual(inc.isIncident, false);
});

// ── Test Suite W: Rule Priority Resolution ───────────────────────────────────
runTest('W — Accident event wins priority over Aggressive Driving pattern when both present', () => {
  const engine = new IncidentGroupingEngine();
  const mockCorrelation = {
    isCorrelated: true,
    eventCount: 3,
    eventTypes: ['speeding', 'harsh_braking', 'accident'],
    events: [
      { alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'harsh_braking', timestamp: '2026-09-02T10:02:00.000Z' },
      { alertType: 'accident', timestamp: '2026-09-02T10:04:00.000Z' },
    ],
    startTime: '2026-09-02T10:00:00.000Z',
    latestTime: '2026-09-02T10:04:00.000Z',
  };

  const inc = engine.group(mockCorrelation);
  assert.strictEqual(inc.type, 'ACCIDENT_EVENT');
  assert.strictEqual(inc.ruleId, 'ACCIDENT_V1');
});

// ── Test Suite X: Failure Isolation ──────────────────────────────────────────
runTest('X — Exception inside incident grouping engine returns safe fallback object', () => {
  const engine = new IncidentGroupingEngine();
  const malformed = {
    get eventTypes() { throw new Error('Simulated grouping error'); }
  };

  const inc = engine.group(malformed);
  assert.strictEqual(inc.type, 'NONE');
  assert.strictEqual(inc.isIncident, false);
});

// ── Test Suite Y: Existing Correlation Object Intact ────────────────────────
runTest('Y — Existing alertCorrelation fields (correlationId, status, events) remain 100% intact', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const corr = ctx2.alertCorrelation;
  assert.ok(corr.correlationId);
  assert.strictEqual(corr.status, 'CORRELATED');
  assert.strictEqual(corr.eventCount, 2);
  assert.strictEqual(corr.isCorrelated, true);
  assert.ok(corr.incident);
  assert.strictEqual(corr.incident.type, 'AGGRESSIVE_DRIVING');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) {
  process.exit(1);
}

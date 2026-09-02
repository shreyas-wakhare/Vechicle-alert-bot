/**
 * tests/test_incidentLifecycle.js
 *
 * Comprehensive Test Suite for Feature #2 Phase 3.2 — Continuation, Escalation & Incident Lifecycle
 *
 * Tests cases A through AH as specified in Phase 13 of the Phase 3.2 master prompt.
 */

const assert = require('assert');
const IncidentLifecycleEngine = require('../services/incidentLifecycleEngine');
const IncidentIntelligenceEngine = require('../services/incidentIntelligenceEngine');
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
console.log('🧪 FEATURE #2 PHASE 3.2 — INCIDENT LIFECYCLE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── A. New Incident ─────────────────────────────────────────────────────────
runTest('A — New single event is not a continuation (isContinuation: false)', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, false);
  assert.strictEqual(intel.continuation.previousIncidentId, null);
});

// ── B. Valid Continuation ───────────────────────────────────────────────────
runTest('B — Valid multi-event stream sets isContinuation: true and previousIncidentId', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, true);
  assert.ok(intel.continuation.previousIncidentId);
  assert.strictEqual(intel.continuation.mergedEventCount, 2);
});

// ── C. Continuation Same Vehicle ────────────────────────────────────────────
runTest('C — Continuation is locked to same vehicle identity', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, true);
  assert.strictEqual(ctx2.alertCorrelation.vehicleKey, 'PLATE:D31498');
});

// ── D. Continuation Different Vehicle Rejected ──────────────────────────────
runTest('D — Continuation is rejected across different vehicles', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'AAA-111', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxB = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'BBB-222', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const intel = ctxB.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, false);
});

// ── E. Continuation Outside Window Rejected ─────────────────────────────────
runTest('E — Continuation outside 15m window boundary is excluded', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:28:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, false);
});

// ── F. Unrelated Event Rejection ─────────────────────────────────────────────
runTest('F — Unrelated non-correlated event is not treated as a continuation', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'idle' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, false);
});

// ── G. Repeated Continuation ────────────────────────────────────────────────
runTest('G — Repeated related alerts in sequence extend continuation count', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:06:00.000Z', emailUid: '103' } });

  const intel = ctx3.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, true);
  assert.strictEqual(intel.continuation.mergedEventCount, 3);
});

// ── H. Duplicate Event Rejection ─────────────────────────────────────────────
runTest('H — Duplicate eventId does not artificially increase merged event count', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxDup = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const intel = ctxDup.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.continuation.isContinuation, false);
  assert.strictEqual(intel.continuation.mergedEventCount, 1);
});

// ── I & J. Latest Time & Duration Extension ───────────────────────────────────
runTest('I/J — Latest time and duration extend as events arrive in window', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.lifecycle.startedAt, '2026-09-02T10:00:00.000Z');
  assert.strictEqual(intel.lifecycle.latestAt, '2026-09-02T10:05:00.000Z');
  assert.strictEqual(intel.lifecycle.durationSeconds, 300);
});

// ── K. Sequence Extension ───────────────────────────────────────────────────
runTest('K — Sequence extends with newly correlated events', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.deepStrictEqual(intel.sequence, ['speeding', 'harsh_braking']);
});

// ── L. Initiating Event Preservation ─────────────────────────────────────────
runTest('L — Initiating event remains preserved as sequence extends', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:06:00.000Z', emailUid: '103' } });

  const intel = ctx3.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.initiatingEvent, 'speeding');
});

// ── M. Primary Trigger Preservation ──────────────────────────────────────────
runTest('M — Primary trigger remains preserved during incident continuation', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.primaryTrigger, 'speeding');
});

// ── N. Supporting Events Updated ────────────────────────────────────────────
runTest('N — Supporting events array updates dynamically as new alerts arrive', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:06:00.000Z', emailUid: '103' } });

  const intel = ctx3.alertCorrelation.incident.intelligence;
  assert.deepStrictEqual(intel.supportingEvents, ['harsh_acceleration', 'harsh_braking']);
});

// ── O. Incident Identity Preservation ────────────────────────────────────────
runTest('O — Stable correlationId identity preserved throughout continuation', () => {
  const builder = new EventContextBuilder();
  const ctx1 = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const corrId = ctx2.alertCorrelation.correlationId;
  assert.ok(corrId.startsWith('CORR-'));
  assert.strictEqual(ctx2.alertCorrelation.incident.intelligence.continuation.previousIncidentId, corrId);
});

// ── P. No Escalation For Same Severity ───────────────────────────────────────
runTest('P — Repeated events of same severity do not trigger escalation', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'geofence_exit', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.escalation.detected, false);
});

// ── Q. Valid Severity Escalation ─────────────────────────────────────────────
runTest('Q — Severity escalation (LOW/MEDIUM -> CRITICAL) triggers escalation.detected: true', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'harsh_acceleration', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'accident', severity: 'CRITICAL' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.escalation.detected, true);
  assert.ok(intel.escalation.reason);
});

// ── R. Pattern Escalation (Aggressive -> Accident) ───────────────────────────
runTest('R — Driving pattern followed by accident triggers pattern escalation', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'accident' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.escalation.detected, true);
  assert.strictEqual(intel.escalation.previousIncidentType, 'AGGRESSIVE_DRIVING');
});

// ── S. Pattern Escalation (Connectivity -> Device Security) ──────────────────
runTest('S — Connectivity disruption followed by tampering triggers security escalation', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'tampering' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.escalation.detected, true);
  assert.strictEqual(intel.escalation.previousIncidentType, 'CONNECTIVITY_DISRUPTION');
});

// ── T. Severity Increase Without Rule Escalation ──────────────────────────────
runTest('T — Handles severity increase without crashing or corrupting schema', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING' };
  const corr = {
    isCorrelated: true,
    events: [
      { alertType: 'harsh_acceleration', severity: 'MEDIUM', eventId: '101' },
      { alertType: 'speeding', severity: 'HIGH', eventId: '102' },
    ]
  };

  const res = engine.evaluate(incident, corr);
  assert.strictEqual(res.escalation.detected, true);
  assert.strictEqual(res.status, 'ACTIVE');
});

// ── U. Duplicate Event Does Not Escalate ─────────────────────────────────────
runTest('U — Processing duplicate event twice does not trigger false escalation', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING' };
  const corr = {
    isCorrelated: true,
    events: [
      { alertType: 'speeding', severity: 'HIGH', eventId: '101' },
      { alertType: 'speeding', severity: 'HIGH', eventId: '101' },
    ]
  };

  const res = engine.evaluate(incident, corr);
  assert.strictEqual(res.escalation.detected, false);
});

// ── V. Vehicle Isolation For Escalation ──────────────────────────────────────
runTest('V — Escalation on Vehicle A does not affect Vehicle B', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'AAA-111', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxB = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'BBB-222', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const intel = ctxB.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.escalation.detected, false);
});

// ── W. Explicit Recovery Event (GPS Restored) ────────────────────────────────
runTest('W — Explicit recovery event gps_restored sets lifecycle status RESOLVED', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'gps_restored' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.status, 'RESOLVED');
  assert.strictEqual(intel.lifecycle.status, 'RESOLVED');
  assert.ok(intel.lifecycle.resolutionReason);
});

// ── X. Explicit Recovery Event (LTE Restored) ────────────────────────────────
runTest('X — Explicit recovery event lte_restored sets lifecycle status RESOLVED', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'lte_jamming' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'lte_restored' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.status, 'RESOLVED');
  assert.strictEqual(intel.lifecycle.status, 'RESOLVED');
});

// ── Y. Explicit Recovery Event (Ignition OFF) ────────────────────────────────
runTest('Y — Explicit recovery event ignition_off sets lifecycle status RESOLVED', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'ignition_off' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:10:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.status, 'RESOLVED');
  assert.strictEqual(intel.lifecycle.status, 'RESOLVED');
});

// ── Z. Unrelated Event Does Not Resolve ──────────────────────────────────────
runTest('Z — Unrelated non-recovery alert does not set RESOLVED status', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.status, 'ACTIVE');
});

// ── AA. No-Event Timeout Does Not Falsely Resolve ───────────────────────────
runTest('AA — Lack of events in window does not fake RESOLVED status', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING' };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'speeding' }, { alertType: 'harsh_braking' }] };

  const res = engine.evaluate(incident, corr);
  assert.strictEqual(res.status, 'ACTIVE');
  assert.strictEqual(res.resolutionReason, null);
});

// ── AB. Repeated Recovery Event Safety ───────────────────────────────────────
runTest('AB — Processing recovery event cleanly handles lifecycle output', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: true, type: 'CONNECTIVITY_DISRUPTION' };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'gps_lost' }, { alertType: 'gps_restored' }] };

  const res = engine.evaluate(incident, corr);
  assert.strictEqual(res.status, 'RESOLVED');
});

// ── AC. Missing Timestamp Safety ──────────────────────────────────────────────
runTest('AC — Handles missing timestamps without throwing', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: false };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'vibration' }, { alertType: 'vibration' }] };

  const res = engine.evaluate(incident, corr);
  assert.ok(res);
});

// ── AD. Invalid Timestamp Safety ──────────────────────────────────────────────
runTest('AD — Handles invalid timestamp strings safely', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: false };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'vibration', timestamp: 'invalid-date' }] };

  const res = engine.evaluate(incident, corr);
  assert.ok(res);
});

// ── AE. Duplicate Timestamp Handling ─────────────────────────────────────────
runTest('AE — Handles duplicate event timestamps safely', () => {
  const engine = new IncidentLifecycleEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING' };
  const corr = {
    isCorrelated: true,
    eventCount: 2,
    events: [
      { alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'harsh_braking', timestamp: '2026-09-02T10:00:00.000Z' },
    ]
  };

  const res = engine.evaluate(incident, corr);
  assert.strictEqual(res.status, 'ACTIVE');
});

// ── AF. Out-of-Order Event Handling ──────────────────────────────────────────
runTest('AF — Out-of-order events do not break lifecycle continuation evaluation', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING', matchedEvents: ['speeding', 'harsh_acceleration'] };
  const correlationResult = {
    isCorrelated: true,
    eventCount: 2,
    events: [
      { alertType: 'speeding', timestamp: '2026-09-02T10:05:00.000Z' },
      { alertType: 'harsh_acceleration', timestamp: '2026-09-02T10:00:00.000Z' },
    ],
  };

  const intel = engine.analyze(incident, correlationResult);
  assert.strictEqual(intel.status, 'ACTIVE');
  assert.strictEqual(intel.sequence[0], 'harsh_acceleration');
  assert.strictEqual(intel.sequence[1], 'speeding');
});

// ── AG. Malformed Incident Safety ────────────────────────────────────────────
runTest('AG — Malformed incident input returns safe default lifecycle object', () => {
  const engine = new IncidentLifecycleEngine();
  const res = engine.evaluate("invalid", null);
  assert.strictEqual(res.status, 'NONE');
});

// ── AH. Null Correlation & JSON Serialization Safety ──────────────────────────
runTest('AH — Null correlation and JSON serialization pass safely', () => {
  const engine = new IncidentLifecycleEngine();
  const res = engine.evaluate(null, null);
  assert.strictEqual(res.status, 'NONE');

  const jsonStr = JSON.stringify(res);
  assert.ok(jsonStr);
});

// ── AI. Emergency Incident Ignition OFF Non-Resolution Audit ─────────────────
runTest('AI — Ignition OFF does not falsely resolve critical ACCIDENT_EVENT or TAMPERING', () => {
  const engine = new IncidentLifecycleEngine();
  const accidentInc = { isIncident: true, type: 'ACCIDENT_EVENT' };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'accident' }, { alertType: 'ignition_off' }] };

  const res = engine.evaluate(accidentInc, corr);
  assert.strictEqual(res.status, 'ACTIVE');
  assert.strictEqual(res.resolutionReason, null);
});

// ── AJ. Driving Session Ignition OFF Resolution ──────────────────────────────
runTest('AJ — Ignition OFF correctly resolves driving session incident', () => {
  const engine = new IncidentLifecycleEngine();
  const drivingInc = { isIncident: true, type: 'AGGRESSIVE_DRIVING' };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'speeding' }, { alertType: 'ignition_off' }] };

  const res = engine.evaluate(drivingInc, corr);
  assert.strictEqual(res.status, 'RESOLVED');
  assert.ok(res.resolutionReason.includes('ignition_off'));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 LIFECYCLE TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) {
  process.exit(1);
}

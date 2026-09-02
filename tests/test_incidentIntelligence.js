/**
 * tests/test_incidentIntelligence.js
 *
 * Comprehensive Test Suite for Feature #2 Phase 3.1 — Correlation Intelligence (Intelligence Foundation)
 *
 * Tests cases A through V as specified in the Phase 3.1 master prompt.
 */

const assert = require('assert');
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
console.log('🧪 FEATURE #2 PHASE 3.1 — CORRELATION INTELLIGENCE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Test Suite A: Single Non-Incident Event ──────────────────────────────────
runTest('A — Single non-incident event sets status DETECTED and correct trigger', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.ok(intel);
  assert.strictEqual(intel.status, 'DETECTED');
  assert.strictEqual(intel.primaryTrigger, 'speeding');
  assert.deepStrictEqual(intel.supportingEvents, []);
  assert.deepStrictEqual(intel.sequence, ['speeding']);
});

// ── Test Suite B: Standalone Inherent Incident ──────────────────────────────
runTest('B — Standalone inherent incident (accident) derives correct primary trigger and status DETECTED', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'accident', label: 'Collision Alert', severity: 'CRITICAL' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.ok(intel);
  assert.strictEqual(intel.status, 'DETECTED');
  assert.strictEqual(intel.initiatingEvent, 'accident');
  assert.strictEqual(intel.primaryTrigger, 'accident');
  assert.deepStrictEqual(intel.sequence, ['accident']);
});

// ── Test Suite C: Correlated Incident ─────────────────────────────────────────
runTest('C — Multi-event correlated incident sets status ACTIVE', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.ok(intel);
  assert.strictEqual(intel.status, 'ACTIVE');
  assert.strictEqual(intel.lifecycle.status, 'ACTIVE');
});

// ── Test Suite D: Chronological Sequence ─────────────────────────────────────
runTest('D — Sequence preserves chronological order of events', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '103' } });

  const intel = ctx3.alertCorrelation.incident.intelligence;
  assert.deepStrictEqual(intel.sequence, ['speeding', 'harsh_acceleration', 'harsh_braking']);
});

// ── Test Suite E: Primary Trigger Identification ─────────────────────────────
runTest('E — Primary trigger correctly identifies the initiating matched alert type', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const intel = ctx2.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.primaryTrigger, 'speeding');
});

// ── Test Suite F: Supporting Events Separation ───────────────────────────────
runTest('F — Supporting events excludes primary trigger and retains subsequent events', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '103' } });

  const intel = ctx3.alertCorrelation.incident.intelligence;
  assert.strictEqual(intel.primaryTrigger, 'speeding');
  assert.deepStrictEqual(intel.supportingEvents, ['harsh_acceleration', 'harsh_braking']);
});

// ── Test Suite G: Lifecycle DETECTED Behavior ───────────────────────────────
runTest('G — Lifecycle status is DETECTED for single-event correlations', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: false, type: 'NONE', startTime: '2026-09-02T10:00:00.000Z', latestTime: '2026-09-02T10:00:00.000Z' };
  const corr = { isCorrelated: false, eventCount: 1, events: [{ alertType: 'vibration', timestamp: '2026-09-02T10:00:00.000Z' }] };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.lifecycle.status, 'DETECTED');
});

// ── Test Suite H: Lifecycle ACTIVE Behavior ─────────────────────────────────
runTest('H — Lifecycle status is ACTIVE for multi-event correlations', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING', startTime: '2026-09-02T10:00:00.000Z', latestTime: '2026-09-02T10:05:00.000Z' };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'speeding' }, { alertType: 'harsh_braking' }] };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.lifecycle.status, 'ACTIVE');
});

// ── Test Suite I: Duration Calculation ──────────────────────────────────────
runTest('I — Duration calculation derives correct durationSeconds', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = {
    isIncident: true,
    startTime: '2026-09-02T10:00:00.000Z',
    latestTime: '2026-09-02T10:06:00.000Z',
  };
  const corr = {
    isCorrelated: true,
    startTime: '2026-09-02T10:00:00.000Z',
    latestTime: '2026-09-02T10:06:00.000Z',
    events: [{ alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z' }, { alertType: 'harsh_braking', timestamp: '2026-09-02T10:06:00.000Z' }],
  };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.lifecycle.durationSeconds, 360);
});

// ── Test Suite J: Missing Timestamp Safety ────────────────────────────────────
runTest('J — Missing timestamp falls back safely without throwing', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: true, matchedEvents: ['speeding'] };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'speeding' }, { alertType: 'harsh_braking' }] };

  const intel = engine.analyze(incident, corr);
  assert.ok(intel);
  assert.strictEqual(intel.primaryTrigger, 'speeding');
});

// ── Test Suite K: Missing Event Safety ────────────────────────────────────────
runTest('K — Empty events array handled gracefully', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: false, type: 'NONE', matchedEvents: [] };
  const corr = { isCorrelated: false, eventCount: 0, events: [] };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.primaryTrigger, null);
  assert.deepStrictEqual(intel.supportingEvents, []);
});

// ── Test Suite L: Unknown Alert Type Handling ───────────────────────────────
runTest('L — Unknown alert type preserved in sequence without error', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: false, type: 'CORRELATED_ACTIVITY', matchedEvents: ['unknown_custom'] };
  const corr = { isCorrelated: true, eventCount: 2, events: [{ alertType: 'unknown_custom' }, { alertType: 'idle' }] };

  const intel = engine.analyze(incident, corr);
  assert.deepStrictEqual(intel.sequence, ['unknown_custom', 'idle']);
  assert.strictEqual(intel.primaryTrigger, 'unknown_custom');
});

// ── Test Suite M: Duplicate Alert Type Handling ──────────────────────────────
runTest('M — Duplicate alert types in sequence correctly populate supportingEvents', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: true, type: 'DRIVER_DISTRACTION_UNSAFE_DRIVING', matchedEvents: ['distraction'] };
  const corr = {
    isCorrelated: true,
    eventCount: 3,
    events: [{ alertType: 'distraction' }, { alertType: 'distraction' }, { alertType: 'vibration' }],
  };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.primaryTrigger, 'distraction');
  assert.deepStrictEqual(intel.supportingEvents, ['distraction', 'vibration']);
});

// ── Test Suite N: Out-of-Order Events Sequence Preserved ─────────────────────
runTest('N — Chronologically sorted events from correlation produce ordered sequence', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = { isIncident: true, type: 'AGGRESSIVE_DRIVING', matchedEvents: ['speeding', 'harsh_acceleration'] };
  const corr = {
    isCorrelated: true,
    eventCount: 2,
    events: [
      { alertType: 'speeding', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'harsh_acceleration', timestamp: '2026-09-02T10:03:00.000Z' },
    ],
  };

  const intel = engine.analyze(incident, corr);
  assert.strictEqual(intel.sequence[0], 'speeding');
  assert.strictEqual(intel.sequence[1], 'harsh_acceleration');
});

// ── Test Suite O: Vehicle Isolation Preservation ─────────────────────────────
runTest('O — Vehicle A events do not leak into Vehicle B intelligence sequence', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'AAA-111', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxB = builder.build({ alertDef: { type: 'vibration' }, fields: { plate: 'BBB-222', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const intel = ctxB.alertCorrelation.incident.intelligence;
  assert.deepStrictEqual(intel.sequence, ['vibration']);
});

// ── Test Suite P: Null Correlation Input Safety ──────────────────────────────
runTest('P — Null correlationResult input returns safe fallback intelligence', () => {
  const engine = new IncidentIntelligenceEngine();
  const intel = engine.analyze({ isIncident: false }, null);
  assert.ok(intel);
  assert.strictEqual(intel.status, 'DETECTED');
});

// ── Test Suite Q: Empty Correlation Input Safety ─────────────────────────────
runTest('Q — Empty correlation object returns safe NONE/DETECTED status', () => {
  const engine = new IncidentIntelligenceEngine();
  const intel = engine.analyze(null, null);
  assert.strictEqual(intel.status, 'NONE');
  assert.strictEqual(intel.primaryTrigger, null);
});

// ── Test Suite R: Malformed Input Safety ─────────────────────────────────────
runTest('R — Malformed incident input returns safe fallback intelligence object', () => {
  const engine = new IncidentIntelligenceEngine();
  const intel = engine.analyze("not_an_object", {});
  assert.strictEqual(intel.status, 'NONE');
});

// ── Test Suite S: Exception Fallback Safety ─────────────────────────────────
runTest('S — Internal exception returns fallback intelligence object without throwing', () => {
  const engine = new IncidentIntelligenceEngine();
  const malformed = {
    get matchedEvents() { throw new Error('Simulated intelligence error'); }
  };

  const intel = engine.analyze(malformed, {});
  assert.strictEqual(intel.status, 'NONE');
});

// ── Test Suite T: Preserved correlationId ────────────────────────────────────
runTest('T — Existing correlationId remains 100% intact', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  assert.ok(ctx.alertCorrelation.correlationId);
  assert.ok(ctx.alertCorrelation.incident.intelligence);
});

// ── Test Suite U: Preserved Phase 2 Incident Fields ─────────────────────────
runTest('U — Phase 2 incident fields (type, label, isIncident, ruleId) remain intact', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const inc = ctx2.alertCorrelation.incident;
  assert.strictEqual(inc.type, 'AGGRESSIVE_DRIVING');
  assert.strictEqual(inc.label, 'Aggressive Driving');
  assert.strictEqual(inc.isIncident, true);
  assert.ok(inc.intelligence);
});

// ── Test Suite V: JSON Serialization Safety ──────────────────────────────────
runTest('V — Intelligence object serializes cleanly to JSON', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const jsonStr = JSON.stringify(ctx.alertCorrelation.incident.intelligence);
  assert.ok(jsonStr);
  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.primaryTrigger, 'speeding');
  assert.strictEqual(parsed.initiatingEvent, 'speeding');
});

// ── Test Suite W: Initiating Event vs Primary Trigger Distinction ────────────
runTest('W — Initiating event is chronological first event, primaryTrigger is rule trigger', () => {
  const engine = new IncidentIntelligenceEngine();
  const incident = {
    isIncident: true,
    type: 'AGGRESSIVE_DRIVING',
    matchedEvents: ['speeding'],
  };
  const correlationResult = {
    isCorrelated: true,
    eventCount: 3,
    events: [
      { alertType: 'harsh_acceleration', timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'speeding', timestamp: '2026-09-02T10:02:00.000Z' },
      { alertType: 'harsh_braking', timestamp: '2026-09-02T10:05:00.000Z' },
    ],
  };

  const intel = engine.analyze(incident, correlationResult);
  assert.strictEqual(intel.initiatingEvent, 'harsh_acceleration');
  assert.strictEqual(intel.primaryTrigger, 'speeding');
  assert.deepStrictEqual(intel.supportingEvents, ['speeding', 'harsh_braking']);
});

// ── Test Suite X: State Persistence Schema Audit ────────────────────────────
runTest('X — state.json contains valid production schema fields', () => {
  const statePath = require('path').join(__dirname, '../data/state.json');
  const stateData = require(statePath);
  assert.ok(stateData, 'state.json must exist');
  assert.strictEqual(typeof stateData.lastIgnitionOn, 'object', 'lastIgnitionOn must be object');
  assert.strictEqual(typeof stateData.lastIgnitionOff, 'object', 'lastIgnitionOff must be object');
  assert.strictEqual(typeof stateData.lastProcessedUID, 'number', 'lastProcessedUID must be number');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 INTELLIGENCE TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) {
  process.exit(1);
}

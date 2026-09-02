/**
 * tests/test_incidentInterpretation.js
 *
 * Comprehensive Test Suite for Feature #2 Phase 3.3 — Operational Interpretation & Incident Narrative Intelligence
 *
 * Tests cases A through X as specified in Phase 17 of the Phase 3.3 master prompt.
 */

const assert = require('assert');
const IncidentInterpretationEngine = require('../services/incidentInterpretationEngine');
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
console.log('🧪 FEATURE #2 PHASE 3.3 — OPERATIONAL INTERPRETATION TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── A. Single Speeding Interpretation ────────────────────────────────────────
runTest('A — Single speeding interpretation derives speed context and category', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp);
  assert.strictEqual(interp.operationalCategory, 'DRIVER_BEHAVIOR');
  assert.ok(interp.whatHappened.includes('92 km/h'));
  assert.ok(interp.whatHappened.includes('70 km/h'));
});

// ── B. Single Vibration Interpretation ───────────────────────────────────────
runTest('B — Single vibration interpretation maps to routine attention', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'LOW' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION');
  assert.ok(interp.whatHappened.includes('vibration'));
});

// ── C. Repeated Aggressive Driving ───────────────────────────────────────────
runTest('C — Repeated aggressive driving narrative contains sequence and HIGH_ATTENTION', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.operationalCategory, 'DRIVER_BEHAVIOR');
  assert.strictEqual(interp.recommendedAttention, 'HIGH_ATTENTION');
  assert.ok(interp.progression.includes('speeding → harsh_acceleration'));
});

// ── D. Aggressive Driving -> Accident Narrative ──────────────────────────────
runTest('D — Driving sequence followed by accident triggers IMMEDIATE_ATTENTION and SAFETY_INCIDENT', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'accident' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.operationalCategory, 'SAFETY_INCIDENT');
  assert.strictEqual(interp.recommendedAttention, 'IMMEDIATE_ATTENTION');
  assert.ok(interp.progression.includes('Escalated from AGGRESSIVE_DRIVING'));
});

// ── E. Connectivity -> Tampering Narrative ───────────────────────────────────
runTest('E — Connectivity disruption followed by tampering maps to DEVICE_SECURITY', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'tampering' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.operationalCategory, 'DEVICE_SECURITY');
  assert.strictEqual(interp.recommendedAttention, 'IMMEDIATE_ATTENTION');
});

// ── F. GPS Lost -> Restored Narrative ────────────────────────────────────────
runTest('F — GPS lost followed by gps_restored maps to CONNECTIVITY and RESOLVED status', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'gps_lost' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'gps_restored' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.operationalCategory, 'CONNECTIVITY');
  assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION');
  assert.ok(interp.whyItMatters.includes('GPS signal restored'));
});

// ── G. LTE Jamming -> Restored Narrative ─────────────────────────────────────
runTest('G — LTE jamming followed by lte_restored narrative reflects recovery', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'lte_jamming' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'lte_restored' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION');
  assert.ok(interp.whyItMatters.includes('LTE signal restored'));
});

// ── H. Driving Sequence -> Ignition OFF Narrative ───────────────────────────
runTest('H — Driving sequence followed by ignition_off narrative reflects session resolution', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'ignition_off' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:10:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION');
  assert.ok(interp.whyItMatters.includes('Driving session ended'));
});

// ── I. Emergency Incident Criticality ────────────────────────────────────────
runTest('I — SOS emergency retains IMMEDIATE_ATTENTION and SAFETY_INCIDENT category', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'sos', severity: 'CRITICAL' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(interp.operationalCategory, 'SAFETY_INCIDENT');
  assert.strictEqual(interp.recommendedAttention, 'IMMEDIATE_ATTENTION');
});

// ── J. Single Event Is Not Described As Pattern ──────────────────────────────
runTest('J — Single alert is described as single event, not pattern', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp.whatHappened.includes('Single speeding alert detected'));
  assert.strictEqual(interp.progression, 'Single alert event.');
});

// ── K. Escalation Narrative ──────────────────────────────────────────────────
runTest('K — Escalated stream includes escalation reason in narrative', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'accident' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:04:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp.narrative.includes('Escalated from AGGRESSIVE_DRIVING'));
});

// ── L. No Escalation Narrative ───────────────────────────────────────────────
runTest('L — Non-escalated stream narrative does not claim false escalation', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(!interp.narrative.includes('Escalated from'));
});

// ── M. Continuation Narrative ────────────────────────────────────────────────
runTest('M — Continued stream narrative includes sequence progression', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });

  const interp = ctx2.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp.whatHappened.includes('2 correlated alerts'));
});

// ── N & O. Lifecycle Status Narrative ────────────────────────────────────────
runTest('N/O — Narrative reflects active vs resolved status accurately', () => {
  const builder = new EventContextBuilder();
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });
  const ctxActive = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:05:00.000Z', emailUid: '102' } });
  assert.ok(ctxActive.alertCorrelation.incident.intelligence.interpretation.narrative.includes('Status: ACTIVE'));

  const ctxResolved = builder.build({ alertDef: { type: 'ignition_off' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:10:00.000Z', emailUid: '103' } });
  assert.ok(ctxResolved.alertCorrelation.incident.intelligence.interpretation.narrative.includes('Status: RESOLVED'));
});

// ── P. Missing Vehicle Data ──────────────────────────────────────────────────
runTest('P — Missing speed/speedLimit falls back cleanly without crashing', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp);
  assert.ok(interp.whatHappened.includes('Single speeding alert detected'));
});

// ── Q. Missing Timestamps ────────────────────────────────────────────────────
runTest('Q — Missing alert timestamp handled gracefully', () => {
  const engine = new IncidentInterpretationEngine();
  const res = engine.interpret({ type: 'speeding' }, { isCorrelated: false }, { sequence: ['speeding'] });
  assert.ok(res);
  assert.strictEqual(res.recommendedAttention, 'ROUTINE_ATTENTION');
});

// ── R. Out-of-Order Events ───────────────────────────────────────────────────
runTest('R — Out-of-order events produce valid sequence narrative', () => {
  const engine = new IncidentInterpretationEngine();
  const intel = {
    status: 'ACTIVE',
    sequence: ['harsh_acceleration', 'speeding'],
    initiatingEvent: 'harsh_acceleration',
  };
  const res = engine.interpret({ type: 'AGGRESSIVE_DRIVING' }, { isCorrelated: true, eventCount: 2 }, intel);
  assert.ok(res.progression.includes('harsh_acceleration → speeding'));
});

// ── S. Duplicate Event Safety ────────────────────────────────────────────────
runTest('S — Duplicate processing produces consistent narrative', () => {
  const engine = new IncidentInterpretationEngine();
  const intel = { status: 'DETECTED', sequence: ['speeding'], initiatingEvent: 'speeding' };
  const res1 = engine.interpret({ type: 'NONE' }, { eventCount: 1 }, intel);
  const res2 = engine.interpret({ type: 'NONE' }, { eventCount: 1 }, intel);

  assert.strictEqual(res1.narrative, res2.narrative);
});

// ── T. Unknown Alert Handling ────────────────────────────────────────────────
runTest('T — Unknown alert type falls back to UNKNOWN category safely', () => {
  const engine = new IncidentInterpretationEngine();
  const res = engine.interpret({ type: 'UNKNOWN_ALERT' }, { isCorrelated: false }, { sequence: ['unknown_alert'] });
  assert.strictEqual(res.operationalCategory, 'UNKNOWN');
});

// ── U. Malformed Intelligence Safety ──────────────────────────────────────────
runTest('U — Malformed intelligence object returns safe default interpretation', () => {
  const engine = new IncidentInterpretationEngine();
  const res = engine.interpret("invalid", null, null);
  assert.strictEqual(res.operationalCategory, 'UNKNOWN');
});

// ── V. JSON Serialization Safety ──────────────────────────────────────────────
runTest('V — Interpretation object serializes cleanly to JSON', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const jsonStr = JSON.stringify(ctx.alertCorrelation.incident.intelligence.interpretation);
  assert.ok(jsonStr);
  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.operationalCategory, 'DRIVER_BEHAVIOR');
});

// ── W. Backward Compatibility (Phase 3.1) ────────────────────────────────────
runTest('W — Phase 3.1 fields (sequence, initiatingEvent, primaryTrigger) remain intact', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.ok(intel.sequence);
  assert.ok(intel.initiatingEvent);
  assert.ok(intel.primaryTrigger);
});

// ── X. Backward Compatibility (Phase 3.2) ────────────────────────────────────
runTest('X — Phase 3.2 lifecycle fields (continuation, escalation, resolutionReason) remain intact', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' } });

  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.ok(intel.continuation);
  assert.ok(intel.escalation);
  assert.strictEqual(intel.lifecycle.status, 'DETECTED');
});

// ── Y. All 32 Alert Types Taxonomy Audit ─────────────────────────────────────
runTest('Y — All 32 alert types map to valid non-UNKNOWN operational categories', () => {
  const alertTypes = require('../data/alertTypes.json');
  const engine = new IncidentInterpretationEngine();

  for (const def of alertTypes) {
    if (def.type === 'unknown') continue;
    const res = engine.interpret({ type: def.type }, { eventCount: 1 }, { sequence: [def.type] });
    assert.notStrictEqual(res.operationalCategory, 'UNKNOWN', `Alert type ${def.type} mapped to UNKNOWN`);
  }
});

// ── Z. CRITICAL Severity Attention Audit ─────────────────────────────────────
runTest('Z — CRITICAL severity event forces IMMEDIATE_ATTENTION', () => {
  const engine = new IncidentInterpretationEngine();
  const res = engine.interpret(
    { type: 'ENGINE_FAILURE' },
    { eventCount: 1, events: [{ alertType: 'engine_failure', severity: 'CRITICAL' }] },
    { sequence: ['engine_failure'] },
    { severity: 'CRITICAL' }
  );

  assert.strictEqual(res.recommendedAttention, 'IMMEDIATE_ATTENTION');
});

// ── AA. Initiating Event Telemetry Alignment Audit ───────────────────────────
runTest('AA — Telemetry is extracted from chronological initiatingEvent object', () => {
  const engine = new IncidentInterpretationEngine();
  const corr = {
    eventCount: 2,
    events: [
      { alertType: 'speeding', speed: 110, speedLimit: 80, timestamp: '2026-09-02T10:00:00.000Z' },
      { alertType: 'harsh_braking', timestamp: '2026-09-02T10:02:00.000Z' },
    ],
  };
  const intel = {
    status: 'ACTIVE',
    sequence: ['speeding', 'harsh_braking'],
    initiatingEvent: 'speeding',
  };

  const res = engine.interpret({ type: 'AGGRESSIVE_DRIVING' }, corr, intel);
  assert.ok(res.whatHappened.includes('110 km/h'));
  assert.ok(res.whatHappened.includes('80 km/h'));
});

// ── AB. Single-Event vs Incident Narrative Wording Audit ─────────────────────
runTest('AB — Single events use alert wording while correlated streams use incident pattern wording', () => {
  const builder = new EventContextBuilder();
  const singleCtx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '101' },
  });

  const singleInterp = singleCtx.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(singleInterp.operationalMeaning, 'Over Speed alert (DETECTED).');
  assert.ok(singleInterp.narrative.startsWith('Over Speed alert detected.'));
  assert.ok(!singleInterp.narrative.includes('pattern detected'));

  const multiCtx = builder.build({
    alertDef: { type: 'harsh_acceleration', label: 'Harsh Acceleration', severity: 'MEDIUM' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:03:00.000Z', emailUid: '102' },
  });

  const multiInterp = multiCtx.alertCorrelation.incident.intelligence.interpretation;
  assert.strictEqual(multiInterp.operationalMeaning, 'Aggressive Driving incident (ACTIVE).');
  assert.ok(multiInterp.narrative.startsWith('Aggressive Driving pattern detected.'));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 INTERPRETATION TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) {
  process.exit(1);
}

/**
 * tests/test_phase34_hardening.js
 *
 * Feature #2 Phase 3.4 — Final Validation, Hardening & Production Readiness
 *
 * This suite validates the complete Feature #2 pipeline end-to-end,
 * covering all data contracts, edge cases, determinism, JSON safety,
 * 32-alert type coverage, backward compatibility, and state cleanliness.
 *
 * All frozen Phase 1–3.3 contracts are verified to remain intact.
 * Baseline: 202/202 tests passing before this suite.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const AlertCorrelationEngine      = require('../services/alertCorrelationEngine');
const IncidentGroupingEngine      = require('../services/incidentGroupingEngine');
const IncidentIntelligenceEngine  = require('../services/incidentIntelligenceEngine');
const IncidentLifecycleEngine     = require('../services/incidentLifecycleEngine');
const IncidentInterpretationEngine = require('../services/incidentInterpretationEngine');
const EventContextBuilder         = require('../services/eventContext');

const alertTypesRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/alertTypes.json'), 'utf8'));

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function mkContext(alertType, overrides = {}) {
  return {
    eventId: overrides.eventId || `UID-${alertType}-1`,
    alertType,
    alertLabel: overrides.alertLabel || alertType,
    severity: overrides.severity || 'MEDIUM',
    timestamp: overrides.timestamp || '2026-09-02T10:00:00.000Z',
    source: 'test',
    vehicle: {
      plate: overrides.plate !== undefined ? overrides.plate : 'PLATE-TEST',
      model: null,
      imei: overrides.imei !== undefined ? overrides.imei : null,
      driver: null,
    },
    telemetry: {
      speed: overrides.speed !== undefined ? overrides.speed : null,
      speedLimit: overrides.speedLimit !== undefined ? overrides.speedLimit : null,
      excessSpeed: null,
      idleTime: null,
      idleLimit: null,
      overIdleTime: null,
    },
    location: { address: null, latitude: null, longitude: null, mapsUrl: null, trackUrl: null },
    trip: { active: null, ignitionState: 'UNKNOWN', lastIgnitionOnTime: null, lastIgnitionOffTime: null },
    metadata: { emailUid: overrides.emailUid || null, receivedAt: new Date().toISOString(), emailSubject: null, rawSource: 'test' },
    recentActivity: overrides.recentActivity || null,
    contextIntelligence: { generatedAt: new Date().toISOString(), signals: [], summary: { signalCount: 0, highestLevel: 'NONE', hasEscalation: false, hasRepeatedViolation: false, hasSequence: false, hasCombination: false, hasCluster: false, hasContextualRisk: false } },
  };
}

function mkCorr(events = [], overrides = {}) {
  const isCorrelated = events.length > 1;
  const sorted = [...events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const startTime = sorted[0]?.timestamp || new Date().toISOString();
  const latestTime = sorted[sorted.length - 1]?.timestamp || startTime;
  return {
    correlationId: overrides.correlationId || `CORR-TEST-${events[0]?.eventId || 'X'}`,
    vehicleKey: overrides.vehicleKey || 'PLATE:PLATETEST',
    vehicle: { plate: 'PLATE-TEST', model: null, imei: null, driver: null },
    status: isCorrelated ? 'CORRELATED' : 'SINGLE_EVENT',
    isCorrelated,
    eventCount: events.length,
    eventIds: events.map(e => e.eventId),
    eventTypes: [...new Set(events.map(e => e.alertType))],
    events: events.map(e => ({ ...e })),
    startTime,
    latestTime,
    durationMs: Math.max(0, new Date(latestTime).getTime() - new Date(startTime).getTime()),
    windowMinutes: 15,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('🔒 FEATURE #2 PHASE 3.4 — FINAL VALIDATION & HARDENING TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — PIPELINE AUDIT (data contract presence end-to-end)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part 1: Pipeline Data Contract Audit ────────────────────────────');

runTest('P1-A — alertCorrelation top-level fields are all present for a single event', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '201' },
  });
  const corr = ctx.alertCorrelation;
  assert.ok(corr, 'alertCorrelation missing');
  assert.ok(typeof corr.correlationId === 'string', 'correlationId must be string');
  assert.ok(typeof corr.vehicleKey === 'string', 'vehicleKey must be string');
  assert.ok(typeof corr.isCorrelated === 'boolean', 'isCorrelated must be boolean');
  assert.ok(typeof corr.eventCount === 'number', 'eventCount must be number');
  assert.ok(Array.isArray(corr.events), 'events must be array');
  assert.ok(typeof corr.startTime === 'string', 'startTime must be string');
  assert.ok(typeof corr.latestTime === 'string', 'latestTime must be string');
  assert.ok(typeof corr.durationMs === 'number', 'durationMs must be number');
});

runTest('P1-B — incident fields are all present', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '202' },
  });
  const inc = ctx.alertCorrelation.incident;
  assert.ok(inc, 'incident missing');
  assert.ok(typeof inc.type === 'string', 'incident.type must be string');
  assert.ok(typeof inc.label === 'string', 'incident.label must be string');
  assert.ok(typeof inc.isIncident === 'boolean', 'incident.isIncident must be boolean');
  assert.ok(Array.isArray(inc.matchedEvents), 'incident.matchedEvents must be array');
  assert.ok(inc.intelligence, 'incident.intelligence must be present');
});

runTest('P1-C — intelligence fields are all present', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '203' },
  });
  const intel = ctx.alertCorrelation.incident.intelligence;
  assert.ok(intel.hasOwnProperty('status'), 'intelligence.status missing');
  assert.ok(intel.hasOwnProperty('lifecycle'), 'intelligence.lifecycle missing');
  assert.ok(Array.isArray(intel.sequence), 'intelligence.sequence must be array');
  assert.ok(intel.hasOwnProperty('initiatingEvent'), 'intelligence.initiatingEvent missing');
  assert.ok(intel.hasOwnProperty('primaryTrigger'), 'intelligence.primaryTrigger missing');
  assert.ok(Array.isArray(intel.supportingEvents), 'intelligence.supportingEvents must be array');
  assert.ok(intel.hasOwnProperty('continuation'), 'intelligence.continuation missing');
  assert.ok(intel.hasOwnProperty('escalation'), 'intelligence.escalation missing');
  assert.ok(intel.summary?.hasOwnProperty('explanation'), 'intelligence.summary.explanation missing');
  assert.ok(intel.hasOwnProperty('interpretation'), 'intelligence.interpretation missing');
});

runTest('P1-D — interpretation fields are all present', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '204' },
  });
  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(interp.hasOwnProperty('operationalMeaning'), 'operationalMeaning missing');
  assert.ok(interp.hasOwnProperty('whatHappened'), 'whatHappened missing');
  assert.ok(interp.hasOwnProperty('progression'), 'progression missing');
  assert.ok(interp.hasOwnProperty('whyItMatters'), 'whyItMatters missing');
  assert.ok(interp.hasOwnProperty('recommendedAttention'), 'recommendedAttention missing');
  assert.ok(interp.hasOwnProperty('operationalCategory'), 'operationalCategory missing');
  assert.ok(interp.hasOwnProperty('narrative'), 'narrative missing');
});

runTest('P1-E — narrative field is a non-empty string for both single and correlated events', () => {
  const builder = new EventContextBuilder();
  const ctx1 = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '205' },
  });
  const ctx2 = builder.build({
    alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' },
    fields: { plate: 'D/31498', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '206' },
  });
  const n1 = ctx1.alertCorrelation.incident.intelligence.interpretation.narrative;
  const n2 = ctx2.alertCorrelation.incident.intelligence.interpretation.narrative;
  assert.ok(typeof n1 === 'string' && n1.length > 0, 'narrative 1 must be non-empty string');
  assert.ok(typeof n2 === 'string' && n2.length > 0, 'narrative 2 must be non-empty string');
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — EDGE CASE HARDENING
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 2: Edge Case Hardening ─────────────────────────────────────');

runTest('EC-A — Single event: no false correlation, no incident wording, valid category', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
    fields: { plate: 'TEST-EC-A', alertTime: '2026-09-02T08:00:00.000Z', emailUid: '301' },
  });
  const corr = ctx.alertCorrelation;
  assert.strictEqual(corr.isCorrelated, false, 'single event must not be correlated');
  assert.strictEqual(corr.eventCount, 1, 'single event count must be 1');
  const interp = corr.incident.intelligence.interpretation;
  assert.ok(!interp.operationalMeaning.includes('incident'), 'single event must not say "incident"');
  assert.ok(!interp.narrative.includes('pattern detected'), 'single event narrative must not say "pattern detected"');
  assert.ok(interp.operationalCategory !== 'UNKNOWN' || ctx.alertType === 'unknown', 'vibration must map to non-UNKNOWN category');
});

runTest('EC-B — Two related events form a correlated incident with correct sequence', () => {
  const engine = new AlertCorrelationEngine();

  const ctx1 = mkContext('speeding', { eventId: 'UID-EC-B-1', timestamp: '2026-09-02T09:00:00.000Z', plate: 'TEST-EC-B' });
  ctx1.recentActivity = { windows: { '15m': { events: [] } } };
  const corr1 = engine.correlate(ctx1);
  assert.strictEqual(corr1.isCorrelated, false);

  const ctx2 = mkContext('harsh_braking', { eventId: 'UID-EC-B-2', timestamp: '2026-09-02T09:03:00.000Z', plate: 'TEST-EC-B' });
  ctx2.recentActivity = { windows: { '15m': { events: [{ ...corr1.events[0] }] } } };
  const corr2 = engine.correlate(ctx2);
  assert.strictEqual(corr2.isCorrelated, true, 'second event must be correlated');
  assert.strictEqual(corr2.eventCount, 2);
  const seq = corr2.incident?.intelligence?.sequence;
  assert.ok(Array.isArray(seq) && seq.length >= 2, 'sequence must contain both events');
  assert.strictEqual(seq[0], 'speeding', 'first in sequence must be speeding (chronological)');
});

runTest('EC-C — Duplicate event is not counted twice', () => {
  const engine = new AlertCorrelationEngine();
  const eventSummary = { eventId: 'UID-DUP', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' };

  const ctx = mkContext('speeding', { eventId: 'UID-DUP', timestamp: '2026-09-02T09:01:00.000Z', plate: 'TEST-EC-C' });
  // Provide the same event in recentActivity window
  ctx.recentActivity = { windows: { '15m': { events: [{ ...eventSummary }] } } };
  const corr = engine.correlate(ctx);

  // Since eventId is same, deduplication must yield eventCount <= 1 (single event)
  assert.ok(corr.eventCount <= 1 || corr.eventIds.filter(id => id === 'UID-DUP').length === 1, 'duplicate eventId must appear exactly once');
});

runTest('EC-D — Out-of-order events produce chronological sequence', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-OOO-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:05:00.000Z' },
    { eventId: 'UID-OOO-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
  ]);
  const incident = grouping.group(corrResult);
  const seq = incident.intelligence?.sequence;
  assert.ok(Array.isArray(seq) && seq.length === 2, 'sequence must have 2 items');
  assert.strictEqual(seq[0], 'speeding', 'chronological first is speeding');
  assert.strictEqual(seq[1], 'harsh_braking', 'chronological second is harsh_braking');
});

runTest('EC-E — Missing timestamp does not crash correlation engine', () => {
  const engine = new AlertCorrelationEngine();
  const ctx = mkContext('speeding', { eventId: 'UID-MISS-TS', timestamp: undefined, plate: 'TEST-EC-E' });
  delete ctx.timestamp;
  ctx.recentActivity = { windows: { '15m': { events: [] } } };
  let result;
  assert.doesNotThrow(() => { result = engine.correlate(ctx); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.correlationId === 'string', 'correlationId must be string even with missing timestamp');
});

runTest('EC-F — Invalid timestamp string does not crash and produces valid output', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-INV-1', alertType: 'speeding', severity: 'HIGH', timestamp: 'NOT-A-DATE' },
    { eventId: 'UID-INV-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: 'ALSO-INVALID' },
  ]);
  let incident;
  assert.doesNotThrow(() => { incident = grouping.group(corrResult); });
  assert.ok(incident, 'incident must not be null');
  assert.ok(typeof incident.type === 'string', 'incident.type must be string');
});

runTest('EC-G — Missing speed/speedLimit does not crash interpretation, falls back gracefully', () => {
  const engine = new IncidentInterpretationEngine();
  const corr = mkCorr([
    { eventId: 'UID-NOSPD-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z', speed: null },
  ]);
  const incident = { type: 'NONE', label: 'Single Event', isIncident: false, matchedEvents: ['speeding'] };
  const intel = { status: 'DETECTED', sequence: ['speeding'], initiatingEvent: 'speeding', lifecycle: { durationSeconds: 0 } };
  let result;
  assert.doesNotThrow(() => { result = engine.interpret(incident, corr, intel, null); });
  assert.ok(result.whatHappened, 'whatHappened must be non-empty');
  assert.ok(!result.whatHappened.includes('null'), 'whatHappened must not contain "null"');
  assert.ok(!result.whatHappened.includes('undefined'), 'whatHappened must not contain "undefined"');
});

runTest('EC-H — Unknown alert type produces UNKNOWN category and does not crash', () => {
  const engine = new IncidentInterpretationEngine();
  const corr = mkCorr([
    { eventId: 'UID-UNK-1', alertType: 'unknown', severity: 'MEDIUM', timestamp: '2026-09-02T09:00:00.000Z' },
  ]);
  const incident = { type: 'NONE', label: 'Single Event', isIncident: false, matchedEvents: ['unknown'] };
  const intel = { status: 'DETECTED', sequence: ['unknown'], initiatingEvent: 'unknown', lifecycle: { durationSeconds: 0 } };
  let result;
  assert.doesNotThrow(() => { result = engine.interpret(incident, corr, intel, null); });
  assert.strictEqual(result.operationalCategory, 'UNKNOWN', 'unknown alert must produce UNKNOWN category');
});

runTest('EC-I — CRITICAL severity event forces IMMEDIATE_ATTENTION (regression guard)', () => {
  const engine = new IncidentInterpretationEngine();
  const corr = mkCorr([
    { eventId: 'UID-CRIT-1', alertType: 'engine_failure', severity: 'CRITICAL', timestamp: '2026-09-02T09:00:00.000Z' },
  ]);
  const incident = { type: 'ENGINE_FAILURE', label: 'Engine Failure', isIncident: true, matchedEvents: ['engine_failure'] };
  const intel = { status: 'ACTIVE', sequence: ['engine_failure'], initiatingEvent: 'engine_failure', lifecycle: { durationSeconds: 0 }, escalation: { detected: false } };
  const ctx = { severity: 'CRITICAL' };
  const result = engine.interpret(incident, corr, intel, ctx);
  assert.strictEqual(result.recommendedAttention, 'IMMEDIATE_ATTENTION');
});

runTest('EC-J — Emergency incident (ACCIDENT_EVENT) is NOT resolved by ignition_off', () => {
  const lifecycle = new IncidentLifecycleEngine();
  const incident = { type: 'ACCIDENT_EVENT', label: 'Accident', isIncident: true, matchedEvents: ['accident'] };
  const corrResult = mkCorr([
    { eventId: 'UID-ACC-1', alertType: 'accident', severity: 'CRITICAL', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-IGN-1', alertType: 'ignition_off', severity: 'LOW', timestamp: '2026-09-02T09:05:00.000Z' },
  ]);
  const result = lifecycle.evaluate(incident, corrResult);
  assert.notStrictEqual(result.status, 'RESOLVED', 'ACCIDENT_EVENT must not be resolved by ignition_off');
});

runTest('EC-K — GPS recovery event sets lifecycle RESOLVED', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-GPS-1', alertType: 'gps_lost', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-GPS-2', alertType: 'gps_restored', severity: 'LOW', timestamp: '2026-09-02T09:05:00.000Z' },
  ]);
  const incident = grouping.group(corrResult);
  assert.strictEqual(incident.intelligence.lifecycle.status, 'RESOLVED', 'GPS recovery must produce RESOLVED');
});

runTest('EC-L — Ignition OFF resolves a driving session incident (speeding/braking)', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-DRV-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-DRV-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:03:00.000Z' },
    { eventId: 'UID-DRV-3', alertType: 'ignition_off', severity: 'LOW', timestamp: '2026-09-02T09:10:00.000Z' },
  ]);
  const incident = grouping.group(corrResult);
  assert.strictEqual(incident.intelligence.lifecycle.status, 'RESOLVED', 'ignition_off must resolve driving session');
});

runTest('EC-M — Correlation boundary: event 15m01s outside window is excluded', () => {
  const engine = new AlertCorrelationEngine({ windowMinutes: 15 });
  const baseTime = '2026-09-02T10:00:00.000Z';
  const oldTime  = '2026-09-02T09:44:50.000Z'; // 15m10s before => outside window

  const ctx = mkContext('harsh_braking', { eventId: 'UID-BOUND-2', timestamp: baseTime, plate: 'TEST-EC-M' });
  ctx.recentActivity = {
    windows: {
      '15m': {
        events: [
          { eventId: 'UID-BOUND-1', alertType: 'speeding', severity: 'HIGH', timestamp: oldTime }
        ]
      }
    }
  };
  const corr = engine.correlate(ctx);
  // The event at oldTime is outside the 15min window from baseTime
  assert.strictEqual(corr.eventCount, 1, 'event more than 15m outside window must not be included');
  assert.strictEqual(corr.isCorrelated, false, 'event more than 15m outside window must not be correlated');
});

runTest('EC-N — Future timestamp within 5s grace is included', () => {
  const engine = new AlertCorrelationEngine();
  const baseTime  = '2026-09-02T10:00:00.000Z';
  const futureTs  = '2026-09-02T10:00:04.000Z'; // 4s in the future → within 5s grace

  const ctx = mkContext('harsh_braking', { eventId: 'UID-FUTURE-2', timestamp: baseTime, plate: 'TEST-EC-N' });
  ctx.recentActivity = {
    windows: {
      '15m': {
        events: [
          { eventId: 'UID-FUTURE-1', alertType: 'speeding', severity: 'HIGH', timestamp: futureTs }
        ]
      }
    }
  };
  const corr = engine.correlate(ctx);
  // Both events are within the 5s grace → must be included
  assert.strictEqual(corr.eventCount, 2, '5s grace future event must be included');
});

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — DETERMINISM AUDIT
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 3: Determinism Audit ────────────────────────────────────────');

runTest('DET-M — Same input produces same incident type on repeated calls', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-DET-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-DET-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:03:00.000Z' },
  ]);
  const r1 = grouping.group(corrResult);
  const r2 = grouping.group(corrResult);
  assert.strictEqual(r1.type, r2.type, 'incident type must be deterministic');
  assert.deepStrictEqual(r1.intelligence.sequence, r2.intelligence.sequence, 'sequence must be deterministic');
  assert.deepStrictEqual(r1.intelligence.interpretation.operationalCategory, r2.intelligence.interpretation.operationalCategory, 'operationalCategory must be deterministic');
});

runTest('DET-M2 — Same input produces same narrative on repeated calls', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-DET2-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-DET2-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:03:00.000Z' },
  ]);
  const r1 = grouping.group(corrResult);
  const r2 = grouping.group(corrResult);
  // Narrative may differ in Duration/generatedAt but core content must match
  const stripGenerated = n => n.replace(/ Status: [A-Z]+\./, '').trim();
  assert.strictEqual(
    stripGenerated(r1.intelligence.interpretation.narrative),
    stripGenerated(r2.intelligence.interpretation.narrative),
    'narrative core content must be deterministic'
  );
});

runTest('DET-M3 — correlationId for same vehicle+earliest event is stable across calls', () => {
  const engine = new AlertCorrelationEngine();
  const earliestEventId = 'UID-STABLE-1';
  const vehicleKey = 'PLATE:TESTSTABLE';

  const ctx1 = mkContext('speeding', { eventId: earliestEventId, timestamp: '2026-09-02T09:00:00.000Z', plate: 'TEST-STABLE' });
  ctx1.recentActivity = { windows: { '15m': { events: [] } } };
  const corr1 = engine.correlate(ctx1);

  const ctx2 = mkContext('harsh_braking', { eventId: 'UID-STABLE-2', timestamp: '2026-09-02T09:03:00.000Z', plate: 'TEST-STABLE' });
  ctx2.recentActivity = { windows: { '15m': { events: [{ ...corr1.events[0] }] } } };
  const corr2 = engine.correlate(ctx2);

  // correlationId = CORR-{vehicleKey}-{earliestEventId}
  assert.ok(corr2.correlationId.includes(earliestEventId), 'correlationId must be based on earliest event');
});

// ════════════════════════════════════════════════════════════════════════════
// PART 4 — JSON / PERSISTENCE SAFETY
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 4: JSON / Persistence Safety ───────────────────────────────');

runTest('JSON-N — alertCorrelation serializes cleanly to JSON (no NaN, undefined, circular)', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', speed: 92, speedLimit: 70, alertTime: '2026-09-02T10:00:00.000Z', emailUid: '401' },
  });
  let serialized;
  assert.doesNotThrow(() => { serialized = JSON.stringify(ctx.alertCorrelation); });
  assert.ok(typeof serialized === 'string' && serialized.length > 0, 'JSON.stringify must succeed');
  assert.ok(!serialized.includes(':undefined'), 'no undefined values in JSON');
  // NaN serializes to null in JSON, verify no raw "NaN" text
  assert.ok(!serialized.includes(':NaN'), 'no NaN values in JSON');
});

runTest('JSON-N2 — correlated incident serializes cleanly to JSON', () => {
  const builder = new EventContextBuilder();
  builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'JSON-TEST', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '402' },
  });
  const ctx = builder.build({
    alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' },
    fields: { plate: 'JSON-TEST', alertTime: '2026-09-02T10:02:00.000Z', emailUid: '403' },
  });
  let serialized;
  assert.doesNotThrow(() => { serialized = JSON.stringify(ctx.alertCorrelation); });
  assert.ok(!serialized.includes(':undefined'), 'no undefined values');
  assert.ok(!serialized.includes(':NaN'), 'no NaN values');
});

runTest('JSON-Q — data/state.json contains no synthetic test data', () => {
  const statePath = path.join(__dirname, '../data/state.json');
  const raw = fs.readFileSync(statePath, 'utf8');
  let state;
  assert.doesNotThrow(() => { state = JSON.parse(raw); }, 'state.json must be valid JSON');

  // Verify required production fields
  assert.ok(state.hasOwnProperty('lastIgnitionOff'), 'lastIgnitionOff must be present');
  assert.ok(state.hasOwnProperty('lastProcessedUID'), 'lastProcessedUID must be present');
  assert.ok(state.hasOwnProperty('mutedCategories'), 'mutedCategories must be present');
  assert.ok(state.hasOwnProperty('personalDMsEnabled'), 'personalDMsEnabled must be present');

  // Verify no synthetic test keys from our test suite
  const knownSyntheticKeys = ['TEST-IGN-01', 'FAKE-PLATE', 'TEST-STABLE', 'TEST-EC-A', 'TEST-EC-B', 'TEST-EC-C'];
  for (const key of knownSyntheticKeys) {
    const ignOff = state.lastIgnitionOff || {};
    const ignOn  = state.lastIgnitionOn || {};
    assert.ok(!ignOff[key], `state.json must not contain synthetic key in lastIgnitionOff: ${key}`);
    assert.ok(!ignOn[key], `state.json must not contain synthetic key in lastIgnitionOn: ${key}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART 5 — 32 ALERT TYPE VALIDATION
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 5: 32 Alert Type Coverage ──────────────────────────────────');

const VALID_CATEGORIES = new Set([
  'DRIVER_BEHAVIOR', 'SAFETY_INCIDENT', 'DEVICE_SECURITY',
  'CONNECTIVITY', 'VEHICLE_OPERATION', 'GEOLOCATION', 'CORRELATED_ACTIVITY', 'UNKNOWN'
]);

runTest('P7-O — All 32 defined alert types pass through correlation without crash', () => {
  const grouping = new IncidentGroupingEngine();
  for (const alertDef of alertTypesRaw) {
    const corrResult = mkCorr([
      { eventId: `UID-${alertDef.type}`, alertType: alertDef.type, severity: alertDef.severity || 'MEDIUM', timestamp: '2026-09-02T09:00:00.000Z' },
    ]);
    let incident;
    assert.doesNotThrow(
      () => { incident = grouping.group(corrResult); },
      `grouping must not crash for alertType: ${alertDef.type}`
    );
    assert.ok(incident && typeof incident.type === 'string', `incident.type must be string for ${alertDef.type}`);
  }
});

runTest('P7-O2 — All 32 alert types produce a valid operationalCategory (not undefined)', () => {
  const interpEngine = new IncidentInterpretationEngine();
  for (const alertDef of alertTypesRaw) {
    const corr = mkCorr([
      { eventId: `UID-CAT-${alertDef.type}`, alertType: alertDef.type, severity: alertDef.severity || 'MEDIUM', timestamp: '2026-09-02T09:00:00.000Z' },
    ]);
    const incident = { type: 'NONE', label: alertDef.label || alertDef.type, isIncident: false, matchedEvents: [alertDef.type] };
    const intel    = { status: 'DETECTED', sequence: [alertDef.type], initiatingEvent: alertDef.type, lifecycle: { durationSeconds: 0 }, escalation: { detected: false } };
    let result;
    assert.doesNotThrow(
      () => { result = interpEngine.interpret(incident, corr, intel, null); },
      `interpret must not crash for ${alertDef.type}`
    );
    assert.ok(
      VALID_CATEGORIES.has(result.operationalCategory),
      `${alertDef.type} must map to valid operationalCategory, got: ${result.operationalCategory}`
    );
    assert.ok(typeof result.narrative === 'string' && result.narrative.length > 0, `narrative must be non-empty for ${alertDef.type}`);
  }
});

runTest('P7-O3 — All 32 alert types serialize to valid JSON without NaN/undefined', () => {
  const grouping = new IncidentGroupingEngine();
  for (const alertDef of alertTypesRaw) {
    const corrResult = mkCorr([
      { eventId: `UID-SER-${alertDef.type}`, alertType: alertDef.type, severity: alertDef.severity || 'MEDIUM', timestamp: '2026-09-02T09:00:00.000Z' },
    ]);
    let incident;
    assert.doesNotThrow(() => { incident = grouping.group(corrResult); });
    let serialized;
    assert.doesNotThrow(
      () => { serialized = JSON.stringify(incident); },
      `JSON.stringify must not throw for ${alertDef.type}`
    );
    assert.ok(!serialized.includes(':undefined'), `no undefined for ${alertDef.type}`);
    assert.ok(!serialized.includes(':NaN'), `no NaN for ${alertDef.type}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART 6 — BACKWARD COMPATIBILITY & FROZEN PHASE CONTRACT PROTECTION
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 6: Frozen Phase Backward Compatibility ──────────────────────');

runTest('P-BACK — Phase 1: 15-minute window remains the default', () => {
  const engine = new AlertCorrelationEngine();
  assert.strictEqual(engine.windowMinutes, 15, 'default window must be 15 minutes');
});

runTest('P-BACK2 — Phase 1: Vehicle isolation still works (different plates)', () => {
  const engine = new AlertCorrelationEngine();
  const baseTime = '2026-09-02T09:00:00.000Z';

  const ctxA = mkContext('speeding', { eventId: 'UID-ISO-A', timestamp: baseTime, plate: 'VEHICLE-A' });
  ctxA.recentActivity = { windows: { '15m': { events: [] } } };
  engine.correlate(ctxA);

  const ctxB = mkContext('harsh_braking', { eventId: 'UID-ISO-B', timestamp: '2026-09-02T09:02:00.000Z', plate: 'VEHICLE-B' });
  ctxB.recentActivity = { windows: { '15m': { events: [] } } };
  const corrB = engine.correlate(ctxB);

  assert.strictEqual(corrB.eventCount, 1, 'Vehicle B must not see Vehicle A events');
  assert.strictEqual(corrB.isCorrelated, false, 'Vehicle B must not be falsely correlated with Vehicle A');
});

runTest('P-BACK3 — Phase 2: ACCIDENT_EVENT still takes priority over AGGRESSIVE_DRIVING', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-PRIO-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-PRIO-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:02:00.000Z' },
    { eventId: 'UID-PRIO-3', alertType: 'accident', severity: 'CRITICAL', timestamp: '2026-09-02T09:04:00.000Z' },
  ]);
  const incident = grouping.group(corrResult);
  assert.strictEqual(incident.type, 'ACCIDENT_EVENT', 'ACCIDENT_EVENT must take priority over AGGRESSIVE_DRIVING');
});

runTest('P-BACK4 — Phase 3.1: initiatingEvent is always sequence[0]', () => {
  const grouping = new IncidentGroupingEngine();
  const corrResult = mkCorr([
    { eventId: 'UID-INIT-2', alertType: 'harsh_braking', severity: 'MEDIUM', timestamp: '2026-09-02T09:05:00.000Z' },
    { eventId: 'UID-INIT-1', alertType: 'speeding', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
  ]);
  const incident = grouping.group(corrResult);
  assert.strictEqual(incident.intelligence.initiatingEvent, 'speeding', 'initiatingEvent must be chronological first event');
  assert.strictEqual(incident.intelligence.sequence[0], 'speeding', 'sequence[0] must be chronological first');
});

runTest('P-BACK5 — Phase 3.2: Emergency protection: SOS_EMERGENCY not resolved by ignition_off', () => {
  const lifecycle = new IncidentLifecycleEngine();
  const incident = { type: 'SOS_EMERGENCY', label: 'SOS', isIncident: true, matchedEvents: ['sos'] };
  const corrResult = mkCorr([
    { eventId: 'UID-SOS-1', alertType: 'sos', severity: 'CRITICAL', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-SOS-2', alertType: 'ignition_off', severity: 'LOW', timestamp: '2026-09-02T09:05:00.000Z' },
  ]);
  const result = lifecycle.evaluate(incident, corrResult);
  assert.notStrictEqual(result.status, 'RESOLVED', 'SOS_EMERGENCY must never be resolved by ignition_off');
});

runTest('P-BACK6 — Phase 3.3: Single event wording never says "incident" or "pattern detected"', () => {
  const builder = new EventContextBuilder();
  const ctx = builder.build({
    alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
    fields: { plate: 'BACK6-PLATE', alertTime: '2026-09-02T10:00:00.000Z', emailUid: '501' },
  });
  const interp = ctx.alertCorrelation.incident.intelligence.interpretation;
  assert.ok(!interp.operationalMeaning.toLowerCase().includes('incident'), 'single event operationalMeaning must not say "incident"');
  assert.ok(!interp.narrative.toLowerCase().includes('pattern detected'), 'single event narrative must not say "pattern detected"');
});

runTest('P-BACK7 — Phase 3.3: RESOLVED incident gets ROUTINE_ATTENTION', () => {
  const engine = new IncidentInterpretationEngine();
  const corr = mkCorr([
    { eventId: 'UID-RES-1', alertType: 'gps_lost', severity: 'HIGH', timestamp: '2026-09-02T09:00:00.000Z' },
    { eventId: 'UID-RES-2', alertType: 'gps_restored', severity: 'LOW', timestamp: '2026-09-02T09:05:00.000Z' },
  ]);
  const incident = { type: 'GPS_INTERRUPTION', label: 'GPS Interruption', isIncident: true, matchedEvents: ['gps_lost', 'gps_restored'] };
  const intel = { status: 'RESOLVED', sequence: ['gps_lost', 'gps_restored'], initiatingEvent: 'gps_lost', lifecycle: { durationSeconds: 300, resolutionReason: 'GPS restored.' }, escalation: { detected: false } };
  const result = engine.interpret(incident, corr, intel, null);
  assert.strictEqual(result.recommendedAttention, 'ROUTINE_ATTENTION', 'RESOLVED incident must produce ROUTINE_ATTENTION');
});

// ════════════════════════════════════════════════════════════════════════════
// PART 7 — ADDITIONAL HARDENING: NULL / MALFORMED INPUT GUARDS
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Part 7: Null / Malformed Input Guards ────────────────────────────');

runTest('NULL-A — AlertCorrelationEngine.correlate(null) returns safe empty object', () => {
  const engine = new AlertCorrelationEngine();
  let result;
  assert.doesNotThrow(() => { result = engine.correlate(null); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.correlationId === 'string', 'correlationId must be string');
});

runTest('NULL-B — IncidentGroupingEngine.group(null) returns safe empty incident', () => {
  const engine = new IncidentGroupingEngine();
  let result;
  assert.doesNotThrow(() => { result = engine.group(null); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.type === 'string', 'incident.type must be string');
});

runTest('NULL-C — IncidentIntelligenceEngine.analyze(null) returns safe empty intelligence', () => {
  const engine = new IncidentIntelligenceEngine();
  let result;
  assert.doesNotThrow(() => { result = engine.analyze(null, null, null); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.status === 'string', 'status must be string');
});

runTest('NULL-D — IncidentLifecycleEngine.evaluate(null) returns safe default lifecycle', () => {
  const engine = new IncidentLifecycleEngine();
  let result;
  assert.doesNotThrow(() => { result = engine.evaluate(null, null); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.status === 'string', 'status must be string');
});

runTest('NULL-E — IncidentInterpretationEngine.interpret(null) returns default interpretation', () => {
  const engine = new IncidentInterpretationEngine();
  let result;
  assert.doesNotThrow(() => { result = engine.interpret(null, null, null, null); });
  assert.ok(result, 'result must not be null');
  assert.ok(typeof result.narrative === 'string', 'narrative must be string');
});

runTest('NULL-F — EventContextBuilder.build(null) returns null without crash', () => {
  const builder = new EventContextBuilder();
  let result;
  assert.doesNotThrow(() => { result = builder.build(null); });
  assert.strictEqual(result, null, 'build(null) must return null');
});

runTest('NULL-G — EventContextBuilder.build({}) returns null without crash', () => {
  const builder = new EventContextBuilder();
  let result;
  assert.doesNotThrow(() => { result = builder.build({}); });
  assert.strictEqual(result, null, 'build({}) must return null (missing alertDef/fields)');
});

// ════════════════════════════════════════════════════════════════════════════
// FINAL RESULTS
// ════════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log(`📊 PHASE 3.4 HARDENING RESULTS: ${passed} Passed | ${failed} Failed`);
console.log('═══════════════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);

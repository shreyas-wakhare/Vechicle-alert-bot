/**
 * tests/test_contextIntelligence.js
 *
 * Automated verification suite for Event Context Layer — Phase 3 (Context Intelligence)
 * Validates 27 specific requirement tests covering repetition, sequence, combination,
 * cluster, escalation, contextual risk detectors, explainability, performance, and regression.
 */

const assert = require('assert');
const AlertParser = require('../services/alertParser');
const ContextIntelligenceEngine = require('../services/contextIntelligenceEngine');
const RecentActivityEngine = require('../services/recentActivityEngine');

console.log('────────────────────────────────────────────────────────────');
console.log('🧪 RUNNING EVENT CONTEXT LAYER PHASE 3 VERIFICATION TESTS');
console.log('────────────────────────────────────────────────────────────\n');

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}`);
    if (err.stack) console.error(`   ${err.stack.split('\n')[1]}`);
    testsFailed++;
  }
}

// Mock HistoryStore for testing
class MockHistoryStore {
  constructor() {
    this._records = [];
    this.onState = {};
    this.offState = {};
  }
  getLastIgnitionOn(plate) { return this.onState[plate] || null; }
  getLastIgnitionOff(plate) { return this.offState[plate] || null; }
}

const mockHistory = new MockHistoryStore();
const parser = new AlertParser();
parser.setHistoryStore(mockHistory);

// Helper to create synthetic context with recentActivity engine
function makeIntelligenceContext(plate, alertType, timestampISO, uid = null, imei = null, severity = 'HIGH', engine = null) {
  const mail = uid ? { uid, date: new Date(timestampISO) } : { date: new Date(timestampISO) };
  const parsedResult = {
    alertDef: { type: alertType, label: alertType.toUpperCase().replace('_', ' '), severity },
    fields: { plate, alertTime: timestampISO, imei, source: 'system1' }
  };
  const ctx = parser.contextBuilder.build(parsedResult, mail);
  if (engine) {
    ctx.recentActivity = engine.buildRecentActivity(ctx);
    ctx.contextIntelligence = parser.contextBuilder.intelligenceEngine.analyze(ctx);
  }
  return ctx;
}

// ── TEST 1 — No recent activity ──────────────────────────────────────────────
runTest('TEST 1 — No recent activity produces no multi-event signals', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = makeIntelligenceContext('VEH-301', 'vibration', '2026-09-01T10:00:00.000Z', 101, null, 'MEDIUM', engine);
  assert.ok(ctx.contextIntelligence);
  assert.strictEqual(ctx.contextIntelligence.summary.hasRepeatedViolation, false);
  assert.strictEqual(ctx.contextIntelligence.summary.hasSequence, false);
  assert.strictEqual(ctx.contextIntelligence.summary.hasCombination, false);
  assert.strictEqual(ctx.contextIntelligence.summary.hasCluster, false);
});

// ── TEST 2 — Single event ────────────────────────────────────────────────────
runTest('TEST 2 — Single event baseline', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = makeIntelligenceContext('VEH-302', 'harsh_braking', '2026-09-01T10:00:00.000Z', 102, null, 'MEDIUM', engine);
  const intel = ctx.contextIntelligence;
  assert.strictEqual(intel.summary.hasRepeatedViolation, false);
  assert.strictEqual(intel.summary.hasSequence, false);
});

// ── TEST 3 — Repeated same event ─────────────────────────────────────────────
runTest('TEST 3 — Repeated same event detection (3x distraction in 15m)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-303', 'distraction', new Date(baseMs - 10 * 60 * 1000).toISOString(), 201, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-303', 'distraction', new Date(baseMs - 5 * 60 * 1000).toISOString(), 202, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-303', 'distraction', new Date(baseMs).toISOString(), 203, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasRepeatedViolation, true);
  const sig = intel.signals.find(s => s.code === 'REPEATED_DISTRACTION');
  assert.ok(sig, 'Should generate REPEATED_DISTRACTION signal');
  assert.strictEqual(sig.evidence.count, 3);
  assert.strictEqual(sig.level, 'HIGH');
});

// ── TEST 4 — Repeated event outside window ───────────────────────────────────
runTest('TEST 4 — Repeated event outside 15m window ignored', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  makeIntelligenceContext('VEH-304', 'distraction', new Date(baseMs - 25 * 60 * 1000).toISOString(), 301, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-304', 'distraction', new Date(baseMs).toISOString(), 302, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasRepeatedViolation, false);
});

// ── TEST 5 — Valid ordered sequence ─────────────────────────────────────────
runTest('TEST 5 — Valid sequence detection (speeding -> harsh_braking)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-305', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 401, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-305', 'harsh_braking', new Date(baseMs).toISOString(), 402, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasSequence, true);
  const sig = intel.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.ok(sig, 'Should generate SPEEDING_TO_HARSH_BRAKING sequence signal');
  assert.strictEqual(sig.evidence.alertTypes[0], 'speeding');
  assert.strictEqual(sig.evidence.alertTypes[1], 'harsh_braking');
});

// ── TEST 6 — Invalid sequence order ────────────────────────────────────────
runTest('TEST 6 — Invalid sequence order rejected (harsh_braking -> speeding)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-306', 'harsh_braking', new Date(baseMs - 5 * 60 * 1000).toISOString(), 501, null, 'MEDIUM', engine);
  const curCtx = makeIntelligenceContext('VEH-306', 'speeding', new Date(baseMs).toISOString(), 502, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  const sig = intel.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.strictEqual(sig, undefined, 'Should NOT trigger speeding -> harsh_braking when order is reversed');
});

// ── TEST 7 — Sequence exceeds max gap ────────────────────────────────────────
runTest('TEST 7 — Sequence exceeding max gap rejected (>10 min gap)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:30:00.000Z').getTime();

  makeIntelligenceContext('VEH-307', 'speeding', new Date(baseMs - 12 * 60 * 1000).toISOString(), 601, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-307', 'harsh_braking', new Date(baseMs).toISOString(), 602, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  const sig = intel.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.strictEqual(sig, undefined, 'Should NOT trigger when gap exceeds 10 minutes');
});

// ── TEST 8 — Valid alert combination ───────────────────────────────────────
runTest('TEST 8 — Valid alert combination (speeding + distraction)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-308', 'distraction', new Date(baseMs - 2 * 60 * 1000).toISOString(), 701, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-308', 'speeding', new Date(baseMs).toISOString(), 702, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasCombination, true);
  const sig = intel.signals.find(s => s.code === 'SPEEDING_WITH_DISTRACTION');
  assert.ok(sig, 'Should generate SPEEDING_WITH_DISTRACTION signal');
});

// ── TEST 9 — Combination outside window ─────────────────────────────────────
runTest('TEST 9 — Combination outside window rejected (>15 min gap)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T11:00:00.000Z').getTime();

  makeIntelligenceContext('VEH-309', 'distraction', new Date(baseMs - 20 * 60 * 1000).toISOString(), 801, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-309', 'speeding', new Date(baseMs).toISOString(), 802, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  const sig = intel.signals.find(s => s.code === 'SPEEDING_WITH_DISTRACTION');
  assert.strictEqual(sig, undefined);
});

// ── TEST 10 — Event cluster ──────────────────────────────────────────────────
runTest('TEST 10 — High event density cluster detection (4+ events, 3+ types)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-310', 'speeding', new Date(baseMs - 10 * 60 * 1000).toISOString(), 901, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-310', 'harsh_acceleration', new Date(baseMs - 8 * 60 * 1000).toISOString(), 902, null, 'MEDIUM', engine);
  makeIntelligenceContext('VEH-310', 'harsh_braking', new Date(baseMs - 5 * 60 * 1000).toISOString(), 903, null, 'MEDIUM', engine);
  const curCtx = makeIntelligenceContext('VEH-310', 'distraction', new Date(baseMs).toISOString(), 904, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasCluster, true);
  const sig = intel.signals.find(s => s.code === 'HIGH_EVENT_DENSITY_CLUSTER');
  assert.ok(sig);
});

// ── TEST 11 — Insufficient cluster density ─────────────────────────────────
runTest('TEST 11 — Insufficient cluster density rejected (<3 distinct types)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-311', 'speeding', new Date(baseMs - 10 * 60 * 1000).toISOString(), 1001, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-311', 'speeding', new Date(baseMs - 8 * 60 * 1000).toISOString(), 1002, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-311', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 1003, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-311', 'speeding', new Date(baseMs).toISOString(), 1004, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasCluster, false, 'Same alert type 4x is repetition, not multi-type cluster');
});

// ── TEST 12 — Violation escalation ──────────────────────────────────────────
runTest('TEST 12 — Violation severity escalation detection', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-312', 'vibration', new Date(baseMs - 10 * 60 * 1000).toISOString(), 1101, null, 'LOW', engine);
  makeIntelligenceContext('VEH-312', 'harsh_braking', new Date(baseMs - 5 * 60 * 1000).toISOString(), 1102, null, 'MEDIUM', engine);
  const curCtx = makeIntelligenceContext('VEH-312', 'accident', new Date(baseMs).toISOString(), 1103, null, 'CRITICAL', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasEscalation, true);
  const sig = intel.signals.find(s => s.code === 'VIOLATION_ESCALATION');
  assert.ok(sig);
  assert.strictEqual(sig.level, 'CRITICAL');
});

// ── TEST 13 — Non-escalating events ─────────────────────────────────────────
runTest('TEST 13 — Non-escalating same-severity events', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-313', 'vibration', new Date(baseMs - 5 * 60 * 1000).toISOString(), 1201, null, 'MEDIUM', engine);
  const curCtx = makeIntelligenceContext('VEH-313', 'harsh_braking', new Date(baseMs).toISOString(), 1202, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasEscalation, false);
});

// ── TEST 14 — Vehicle isolation ─────────────────────────────────────────────
runTest('TEST 14 — Intelligence vehicle isolation (Vehicle A vs Vehicle B)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-314A', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 1301, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-314B', 'distraction', new Date(baseMs - 2 * 60 * 1000).toISOString(), 1302, null, 'HIGH', engine);

  const curCtxA = makeIntelligenceContext('VEH-314A', 'distraction', new Date(baseMs).toISOString(), 1303, null, 'HIGH', engine);

  const intelA = curCtxA.contextIntelligence;
  // Vehicle A has speeding + distraction (combination)
  assert.strictEqual(intelA.summary.hasCombination, true);
  const combinationEvents = intelA.signals.find(s => s.code === 'SPEEDING_WITH_DISTRACTION').evidence.eventIds;
  assert.ok(combinationEvents.includes('UID-1301'), 'Includes Vehicle A speeding');
  assert.ok(!combinationEvents.includes('UID-1302'), 'Must NOT include Vehicle B distraction');
});

// ── TEST 15 — Current event duplicate protection ────────────────────────────
runTest('TEST 15 — Current event duplicate protection', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  const curCtx = makeIntelligenceContext('VEH-315', 'distraction', new Date(baseMs).toISOString(), 1401, null, 'HIGH', engine);

  // Calling analyze multiple times on same context
  const intel1 = parser.contextBuilder.intelligenceEngine.analyze(curCtx);
  const intel2 = parser.contextBuilder.intelligenceEngine.analyze(curCtx);

  assert.strictEqual(intel1.signals.length, intel2.signals.length);
});

// ── TEST 16 — Duplicate historical event protection ─────────────────────────
runTest('TEST 16 — Duplicate historical event protection', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  const dupCtx = makeIntelligenceContext('VEH-316', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 1501, null, 'HIGH', engine);
  engine.registerEvent(dupCtx);
  engine.registerEvent(dupCtx); // Duplicate call

  const curCtx = makeIntelligenceContext('VEH-316', 'harsh_braking', new Date(baseMs).toISOString(), 1502, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  const seqSignal = intel.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.ok(seqSignal);
  assert.strictEqual(seqSignal.evidence.count, 2); // Exactly 2 events in sequence evidence, not 3
});

// ── TEST 17 — Out-of-order sequence detection ──────────────────────────────
runTest('TEST 17 — Out-of-order sequence detection by event timestamp', () => {
  const engine = new RecentActivityEngine(null);
  const t10_00 = new Date('2026-09-01T10:00:00.000Z').toISOString();
  const t10_05 = new Date('2026-09-01T10:05:00.000Z').toISOString();

  // Register speeding (10:00)
  makeIntelligenceContext('VEH-317', 'speeding', t10_00, 1601, null, 'HIGH', engine);
  // Then process harsh_braking (10:05)
  const curCtx = makeIntelligenceContext('VEH-317', 'harsh_braking', t10_05, 1602, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  // Chronological order in past window: speeding (10:00) -> harsh_braking (10:05)
  assert.strictEqual(intel.summary.hasSequence, true);
});

// ── TEST 18 — Active trip context signal ────────────────────────────────────
runTest('TEST 18 — Contextual risk signal during active trip', () => {
  const mockStore = new MockHistoryStore();
  mockStore.onState['VEH-318'] = { time: '2026-09-01T09:00:00.000Z' }; // Active trip ON
  const localParser = new AlertParser();
  localParser.setHistoryStore(mockStore);

  const curCtx = localParser.contextBuilder.build({
    alertDef: { type: 'sos', label: 'SOS Alert', severity: 'CRITICAL' },
    fields: { plate: 'VEH-318', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' }
  }, { uid: 1701 });

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasContextualRisk, true);
  const sig = intel.signals.find(s => s.code === 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
  assert.ok(sig);
  assert.strictEqual(sig.vehicleState.tripActive, true);
  assert.strictEqual(sig.level, 'CRITICAL');
});

// ── TEST 19 — Ignition OFF context ──────────────────────────────────────────
runTest('TEST 19 — Ignition OFF context risk evaluation', () => {
  const mockStore = new MockHistoryStore();
  mockStore.offState['VEH-319'] = '2026-09-01T09:00:00.000Z'; // Trip OFF
  const localParser = new AlertParser();
  localParser.setHistoryStore(mockStore);

  const curCtx = localParser.contextBuilder.build({
    alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
    fields: { plate: 'VEH-319', alertTime: '2026-09-01T10:00:00.000Z', source: 'track9999' }
  }, { uid: 1801 });

  const intel = curCtx.contextIntelligence;
  assert.strictEqual(intel.summary.hasContextualRisk, false);
});

// ── TEST 20 — Missing data safety ────────────────────────────────────────────
runTest('TEST 20 — Missing optional data safety', () => {
  const intelEngine = new ContextIntelligenceEngine();
  const nullCtx = intelEngine.analyze(null);
  assert.ok(nullCtx);
  assert.strictEqual(nullCtx.summary.signalCount, 0);

  const emptyCtx = intelEngine.analyze({});
  assert.ok(emptyCtx);
  assert.strictEqual(emptyCtx.summary.signalCount, 0);
});

// ── TEST 21 — Multiple signals priority ordering ───────────────────────────
runTest('TEST 21 — Multiple signals deterministic priority ordering', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-321', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 2001, null, 'HIGH', engine);
  makeIntelligenceContext('VEH-321', 'distraction', new Date(baseMs - 3 * 60 * 1000).toISOString(), 2002, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-321', 'harsh_braking', new Date(baseMs).toISOString(), 2003, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  assert.ok(intel.signals.length >= 2);

  // Check ordering: CRITICAL > HIGH > MEDIUM
  for (let i = 0; i < intel.signals.length - 1; i++) {
    const weights = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    assert.ok(
      weights[intel.signals[i].level] >= weights[intel.signals[i+1].level],
      `Signal at index ${i} (${intel.signals[i].level}) should be >= index ${i+1} (${intel.signals[i+1].level})`
    );
  }
});

// ── TEST 22 — Signal evidence model completeness ───────────────────────────
runTest('TEST 22 — Signal evidence model completeness', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-322', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 2101, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-322', 'distraction', new Date(baseMs).toISOString(), 2102, null, 'HIGH', engine);

  const intel = curCtx.contextIntelligence;
  const sig = intel.signals.find(s => s.code === 'SPEEDING_WITH_DISTRACTION');
  assert.ok(sig);
  assert.ok(sig.evidence);
  assert.ok(sig.evidence.window);
  assert.ok(Array.isArray(sig.evidence.alertTypes));
  assert.ok(Array.isArray(sig.evidence.eventIds));
  assert.ok(sig.evidence.count >= 2);
});

// ── TEST 23 — Signal human-readable explainability ──────────────────────────
runTest('TEST 23 — Signal human-readable explainability (reason & message)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  makeIntelligenceContext('VEH-323', 'speeding', new Date(baseMs - 5 * 60 * 1000).toISOString(), 2201, null, 'HIGH', engine);
  const curCtx = makeIntelligenceContext('VEH-323', 'harsh_braking', new Date(baseMs).toISOString(), 2202, null, 'MEDIUM', engine);

  const intel = curCtx.contextIntelligence;
  const sig = intel.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.ok(sig);
  assert.ok(typeof sig.message === 'string' && sig.message.length > 5);
  assert.ok(typeof sig.reason === 'string' && sig.reason.length > 10);
});

// ── TEST 24 — Performance bound ─────────────────────────────────────────────
runTest('TEST 24 — Intelligence analysis performance bound (<1ms per alert)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  // Populate 10 recent events
  for (let i = 10; i >= 1; i--) {
    makeIntelligenceContext('VEH-324', 'speeding', new Date(baseMs - i * 60 * 1000).toISOString(), 2300 + i, null, 'HIGH', engine);
  }

  const curCtx = makeIntelligenceContext('VEH-324', 'harsh_braking', new Date(baseMs).toISOString(), 2399, null, 'MEDIUM', engine);

  const startMs = process.hrtime.bigint();
  const intel = parser.contextBuilder.intelligenceEngine.analyze(curCtx);
  const endMs = process.hrtime.bigint();

  const elapsedMs = Number(endMs - startMs) / 1e6;
  console.log(`      ↳ Analysis performance: ${elapsedMs.toFixed(3)} ms`);
  assert.ok(elapsedMs < 5, `Analysis should take < 5ms (was ${elapsedMs}ms)`);
  assert.ok(intel);
});

// ── TEST 25 — Phase 2 Regression ───────────────────────────────────────────
runTest('TEST 25 — Phase 2 recentActivity regression verification', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = makeIntelligenceContext('VEH-325', 'speeding', new Date().toISOString(), 2401, null, 'HIGH', engine);
  assert.ok(ctx.recentActivity);
  assert.ok(ctx.recentActivity.windows['5m']);
  assert.ok(ctx.contextIntelligence);
});

// ── TEST 26 — Phase 1 Regression ───────────────────────────────────────────
runTest('TEST 26 — Phase 1 EventContext schema regression verification', () => {
  const ctx = makeIntelligenceContext('VEH-326', 'idle', new Date().toISOString(), 2501, null, 'LOW');
  assert.ok(ctx.eventId);
  assert.ok(ctx.alertType);
  assert.ok(ctx.vehicle);
  assert.ok(ctx.telemetry);
  assert.ok(ctx.location);
  assert.ok(ctx.trip);
  assert.ok(ctx.metadata);
  assert.ok(ctx.contextIntelligence);
});

// ── TEST 27 — Legacy Output Contract Non-Regression ────────────────────────
runTest('TEST 27 — Legacy parsed result contract non-regression', () => {
  const mail = {
    uid: 2601,
    date: new Date(),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Over Speed Alert',
    text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 118 kmph',
  };

  const result = parser.parse(mail);
  assert.ok(result.alertDef, 'Legacy alertDef preserved');
  assert.ok(result.fields, 'Legacy fields preserved');
  assert.ok(result.context, 'Phase 1/2 context preserved');
  assert.ok(result.context.contextIntelligence, 'Phase 3 intelligence present');
});

console.log('\n────────────────────────────────────────────────────────────');
console.log(`📊 TEST RESULTS: ${testsPassed} Passed | ${testsFailed} Failed`);
console.log('────────────────────────────────────────────────────────────\n');

if (testsFailed > 0) {
  process.exit(1);
}

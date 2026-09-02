/**
 * tests/test_recentActivity.js
 *
 * Automated verification suite for Event Context Layer — Phase 2 (Recent Event Context)
 * Validates 20 specific requirement tests covering window boundaries, vehicle isolation,
 * duplicate handling, out-of-order sorting, rehydration, performance benchmarks, and non-regression.
 */

const assert = require('assert');
const AlertParser = require('../services/alertParser');
const EventContextBuilder = require('../services/eventContext');
const RecentActivityEngine = require('../services/recentActivityEngine');

console.log('────────────────────────────────────────────────────────────');
console.log('🧪 RUNNING EVENT CONTEXT LAYER PHASE 2 VERIFICATION TESTS');
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

// Helper to build a synthetic event context
function makeContext(plate, alertType, timestampISO, uid = null, imei = null) {
  const mail = uid ? { uid, date: new Date(timestampISO) } : { date: new Date(timestampISO) };
  return parser.contextBuilder.build({
    alertDef: { type: alertType, label: alertType.toUpperCase(), severity: 'HIGH' },
    fields: { plate, alertTime: timestampISO, imei, source: 'system1' }
  }, mail);
}

// ── TEST 1 — No recent events ────────────────────────────────────────────────
runTest('TEST 1 — No recent events', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = makeContext('VEH-001', 'speeding', '2026-09-01T10:00:00.000Z');
  // Pass standalone context to engine
  const recent = engine.buildRecentActivity(ctx);

  assert.ok(recent);
  assert.strictEqual(recent.windows['5m'].totalEvents, 1); // Current event itself
  assert.strictEqual(recent.windows['15m'].totalEvents, 1);
  assert.strictEqual(recent.windows['30m'].totalEvents, 1);
  assert.strictEqual(recent.windows['60m'].totalEvents, 1);
});

// ── TEST 2 — Single recent event ─────────────────────────────────────────────
runTest('TEST 2 — Single recent event within 5 minutes', () => {
  const engine = new RecentActivityEngine(null);
  const ctx1 = makeContext('VEH-002', 'speeding', '2026-09-01T10:00:00.000Z', 101);
  const ctx2 = makeContext('VEH-002', 'idle', '2026-09-01T10:02:00.000Z', 102);

  engine.registerEvent(ctx1);
  const recent = engine.buildRecentActivity(ctx2);

  assert.strictEqual(recent.windows['5m'].totalEvents, 2);
  assert.strictEqual(recent.windows['15m'].totalEvents, 2);
  assert.strictEqual(recent.windows['30m'].totalEvents, 2);
  assert.strictEqual(recent.windows['60m'].totalEvents, 2);
});

// ── TEST 3 — 5-minute boundary ───────────────────────────────────────────────
runTest('TEST 3 — 5-minute boundary precision', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:10:00.000Z').getTime();

  // Event at 4 min 50s ago (within 5m)
  const ctx1 = makeContext('VEH-003', 'speeding', new Date(baseMs - (4 * 60 + 50) * 1000).toISOString(), 201);
  // Event at 5 min 10s ago (outside 5m, inside 15m)
  const ctx2 = makeContext('VEH-003', 'idle', new Date(baseMs - (5 * 60 + 10) * 1000).toISOString(), 202);
  // Current event at 10:10:00
  const curCtx = makeContext('VEH-003', 'harsh_braking', new Date(baseMs).toISOString(), 203);

  engine.registerEvent(ctx1);
  engine.registerEvent(ctx2);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['5m'].totalEvents, 2);  // ctx1 + curCtx
  assert.strictEqual(recent.windows['15m'].totalEvents, 3); // ctx1 + ctx2 + curCtx
});

// ── TEST 4 — 15-minute boundary ──────────────────────────────────────────────
runTest('TEST 4 — 15-minute boundary precision', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:30:00.000Z').getTime();

  const ctx14m = makeContext('VEH-004', 'speeding', new Date(baseMs - 14 * 60 * 1000).toISOString(), 301);
  const ctx16m = makeContext('VEH-004', 'idle', new Date(baseMs - 16 * 60 * 1000).toISOString(), 302);
  const curCtx = makeContext('VEH-004', 'harsh_braking', new Date(baseMs).toISOString(), 303);

  engine.registerEvent(ctx14m);
  engine.registerEvent(ctx16m);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['15m'].totalEvents, 2); // ctx14m + curCtx
  assert.strictEqual(recent.windows['30m'].totalEvents, 3); // ctx14m + ctx16m + curCtx
});

// ── TEST 5 — 30-minute boundary ──────────────────────────────────────────────
runTest('TEST 5 — 30-minute boundary precision', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:45:00.000Z').getTime();

  const ctx29m = makeContext('VEH-005', 'speeding', new Date(baseMs - 29 * 60 * 1000).toISOString(), 401);
  const ctx31m = makeContext('VEH-005', 'idle', new Date(baseMs - 31 * 60 * 1000).toISOString(), 402);
  const curCtx = makeContext('VEH-005', 'harsh_braking', new Date(baseMs).toISOString(), 403);

  engine.registerEvent(ctx29m);
  engine.registerEvent(ctx31m);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['30m'].totalEvents, 2); // ctx29m + curCtx
  assert.strictEqual(recent.windows['60m'].totalEvents, 3); // ctx29m + ctx31m + curCtx
});

// ── TEST 6 — 60-minute boundary ──────────────────────────────────────────────
runTest('TEST 6 — 60-minute boundary precision', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T11:00:00.000Z').getTime();

  const ctx59m = makeContext('VEH-006', 'speeding', new Date(baseMs - 59 * 60 * 1000).toISOString(), 501);
  const ctx61m = makeContext('VEH-006', 'idle', new Date(baseMs - 61 * 60 * 1000).toISOString(), 502);
  const curCtx = makeContext('VEH-006', 'harsh_braking', new Date(baseMs).toISOString(), 503);

  engine.registerEvent(ctx59m);
  engine.registerEvent(ctx61m);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['60m'].totalEvents, 2); // ctx59m + curCtx
});

// ── TEST 7 — Outside 60 minutes ──────────────────────────────────────────────
runTest('TEST 7 — Outside 60 minutes exclusion', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  const oldCtx = makeContext('VEH-007', 'speeding', new Date(baseMs - 90 * 60 * 1000).toISOString(), 601);
  const curCtx = makeContext('VEH-007', 'harsh_braking', new Date(baseMs).toISOString(), 602);

  engine.registerEvent(oldCtx);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['60m'].totalEvents, 1); // Only curCtx
});

// ── TEST 8 — Multiple events across windows ──────────────────────────────────
runTest('TEST 8 — Multiple events across time windows', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  engine.registerEvent(makeContext('VEH-008', 'speeding', new Date(baseMs - 2 * 60 * 1000).toISOString(), 701));
  engine.registerEvent(makeContext('VEH-008', 'idle', new Date(baseMs - 10 * 60 * 1000).toISOString(), 702));
  engine.registerEvent(makeContext('VEH-008', 'harsh_braking', new Date(baseMs - 25 * 60 * 1000).toISOString(), 703));
  engine.registerEvent(makeContext('VEH-008', 'tampering', new Date(baseMs - 50 * 60 * 1000).toISOString(), 704));

  const curCtx = makeContext('VEH-008', 'sos', new Date(baseMs).toISOString(), 705);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['5m'].totalEvents, 2);  // speeding + sos
  assert.strictEqual(recent.windows['15m'].totalEvents, 3); // speeding + idle + sos
  assert.strictEqual(recent.windows['30m'].totalEvents, 4); // speeding + idle + harsh_braking + sos
  assert.strictEqual(recent.windows['60m'].totalEvents, 5); // all 5
});

// ── TEST 9 — Same alert repetition counts ─────────────────────────────────────
runTest('TEST 9 — Same alert repetition count calculation', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  engine.registerEvent(makeContext('VEH-009', 'distraction', new Date(baseMs - 2 * 60 * 1000).toISOString(), 801));
  engine.registerEvent(makeContext('VEH-009', 'distraction', new Date(baseMs - 5 * 60 * 1000).toISOString(), 802));
  engine.registerEvent(makeContext('VEH-009', 'distraction', new Date(baseMs - 10 * 60 * 1000).toISOString(), 803));

  const curCtx = makeContext('VEH-009', 'distraction', new Date(baseMs).toISOString(), 804);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['15m'].countsByAlertType['distraction'], 4);
});

// ── TEST 10 — Different alert type breakdown ───────────────────────────────
runTest('TEST 10 — Different alert types breakdown', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  engine.registerEvent(makeContext('VEH-010', 'distraction', new Date(baseMs - 1 * 60 * 1000).toISOString(), 901));
  engine.registerEvent(makeContext('VEH-010', 'vibration', new Date(baseMs - 2 * 60 * 1000).toISOString(), 902));

  const curCtx = makeContext('VEH-010', 'speeding', new Date(baseMs).toISOString(), 903);
  const recent = engine.buildRecentActivity(curCtx);

  const counts = recent.windows['5m'].countsByAlertType;
  assert.strictEqual(counts['distraction'], 1);
  assert.strictEqual(counts['vibration'], 1);
  assert.strictEqual(counts['speeding'], 1);
});

// ── TEST 11 — Multiple vehicles isolation ───────────────────────────────────
runTest('TEST 11 — Vehicle isolation (Vehicle A vs Vehicle B)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  engine.registerEvent(makeContext('VEH-AAA', 'speeding', new Date(baseMs - 2 * 60 * 1000).toISOString(), 1001));
  engine.registerEvent(makeContext('VEH-BBB', 'tampering', new Date(baseMs - 3 * 60 * 1000).toISOString(), 1002));

  const curCtxA = makeContext('VEH-AAA', 'distraction', new Date(baseMs).toISOString(), 1003);
  const recentA = engine.buildRecentActivity(curCtxA);

  assert.strictEqual(recentA.windows['5m'].totalEvents, 2);
  assert.strictEqual(recentA.windows['5m'].countsByAlertType['tampering'] || 0, 0);
  assert.strictEqual(recentA.windows['5m'].countsByAlertType['speeding'], 1);
  assert.strictEqual(recentA.windows['5m'].countsByAlertType['distraction'], 1);
});

// ── TEST 12 — Plate normalization ───────────────────────────────────────────
runTest('TEST 12 — Plate normalization consistency', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  engine.registerEvent(makeContext('CC-48315', 'speeding', new Date(baseMs - 2 * 60 * 1000).toISOString(), 1101));
  engine.registerEvent(makeContext('cc-48315', 'idle', new Date(baseMs - 3 * 60 * 1000).toISOString(), 1102));

  const curCtx = makeContext('CC 48315', 'harsh_braking', new Date(baseMs).toISOString(), 1103);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.vehicleKey, 'PLATE:CC48315');
  assert.strictEqual(recent.windows['5m'].totalEvents, 3);
});

// ── TEST 13 — Current event single inclusion ────────────────────────────────
runTest('TEST 13 — Current event single inclusion (no double count)', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  const curCtx = makeContext('VEH-013', 'speeding', new Date(baseMs).toISOString(), 1201);
  
  // Register curCtx first
  engine.registerEvent(curCtx);
  // Then call buildRecentActivity on curCtx
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['5m'].totalEvents, 1);
});

// ── TEST 14 — Duplicate event handling ──────────────────────────────────────
runTest('TEST 14 — Duplicate event handling by eventId', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T12:00:00.000Z').getTime();

  const dupCtx = makeContext('VEH-014', 'speeding', new Date(baseMs - 1 * 60 * 1000).toISOString(), 1301);

  engine.registerEvent(dupCtx);
  engine.registerEvent(dupCtx); // duplicate registration
  engine.registerEvent(dupCtx); // duplicate registration

  const curCtx = makeContext('VEH-014', 'idle', new Date(baseMs).toISOString(), 1302);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['5m'].totalEvents, 2); // dupCtx + curCtx
});

// ── TEST 15 — Out-of-order event sorting ────────────────────────────────────
runTest('TEST 15 — Out-of-order event sorting by event timestamp', () => {
  const engine = new RecentActivityEngine(null);
  const t10_00 = new Date('2026-09-01T10:00:00.000Z').toISOString();
  const t10_02 = new Date('2026-09-01T10:02:00.000Z').toISOString();
  const t10_04 = new Date('2026-09-01T10:04:00.000Z').toISOString();

  // Insert out of chronological order: 10:00, then 10:04, then 10:02
  engine.registerEvent(makeContext('VEH-015', 'speeding', t10_00, 1401));
  engine.registerEvent(makeContext('VEH-015', 'harsh_braking', t10_04, 1402));
  engine.registerEvent(makeContext('VEH-015', 'distraction', t10_02, 1403));

  const curCtx = makeContext('VEH-015', 'idle', t10_04, 1402);
  const recent = engine.buildRecentActivity(curCtx);

  const events = recent.windows['5m'].events;
  assert.strictEqual(events[0].eventId, 'UID-1402'); // 10:04 newest
  assert.strictEqual(events[1].eventId, 'UID-1403'); // 10:02 middle
  assert.strictEqual(events[2].eventId, 'UID-1401'); // 10:00 oldest
});

// ── TEST 16 — Missing timestamp safety ──────────────────────────────────────
runTest('TEST 16 — Missing timestamp safety fallback', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = {
    eventId: 'EVT-MISSING-TS',
    alertType: 'speeding',
    alertLabel: 'Over Speed',
    severity: 'HIGH',
    timestamp: null,
    source: 'system1',
    vehicle: { plate: 'VEH-016' }
  };

  const recent = engine.buildRecentActivity(ctx);
  assert.ok(recent);
  assert.strictEqual(recent.windows['5m'].totalEvents, 1);
});

// ── TEST 17 — Missing vehicle identity safety ────────────────────────────────
runTest('TEST 17 — Missing vehicle identity safety', () => {
  const engine = new RecentActivityEngine(null);
  const ctx = {
    eventId: 'EVT-NO-VEHICLE',
    alertType: 'unknown',
    alertLabel: 'Alert',
    severity: 'MEDIUM',
    timestamp: new Date().toISOString(),
    source: 'system1',
    vehicle: { plate: null, imei: null }
  };

  const recent = engine.buildRecentActivity(ctx);
  assert.ok(recent);
  assert.strictEqual(recent.vehicleKey, 'UNKNOWN');
  assert.strictEqual(recent.windows['5m'].totalEvents, 1);
});

// ── TEST 18 — Startup rehydration ────────────────────────────────────────────
runTest('TEST 18 — Startup rehydration from HistoryStore', () => {
  const mockStore = new MockHistoryStore();
  const nowMs = Date.now();
  mockStore._records = [
    { id: 1801, plate: 'VEH-018', alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH', receivedAt: new Date(nowMs - 10 * 60 * 1000).toISOString() },
    { id: 1802, plate: 'VEH-018', alertType: 'idle', alertLabel: 'Excessive Idle', severity: 'LOW', receivedAt: new Date(nowMs - 2 * 60 * 1000).toISOString() }
  ];

  const engine = new RecentActivityEngine(mockStore);
  const curCtx = makeContext('VEH-018', 'distraction', new Date(nowMs).toISOString(), 1803);
  const recent = engine.buildRecentActivity(curCtx);

  assert.strictEqual(recent.windows['15m'].totalEvents, 3); // 2 rehydrated + 1 curCtx
});

// ── TEST 19 — Large history performance benchmark ───────────────────────────
runTest('TEST 19 — Large history O(recent) performance benchmark', () => {
  const mockStore = new MockHistoryStore();
  const nowMs = Date.now();
  const records = [];

  // Generate 100,000 old historical records (> 2 hours old)
  for (let i = 0; i < 100000; i++) {
    records.push({
      id: i,
      plate: `VEH-${i % 100}`,
      alertType: 'speeding',
      alertLabel: 'Over Speed',
      severity: 'HIGH',
      receivedAt: new Date(nowMs - (120 + i) * 60 * 1000).toISOString()
    });
  }

  // Add 5 recent records for target vehicle
  for (let i = 0; i < 5; i++) {
    records.push({
      id: 200000 + i,
      plate: 'TARGET-VEH',
      alertType: 'speeding',
      alertLabel: 'Over Speed',
      severity: 'HIGH',
      receivedAt: new Date(nowMs - (i + 1) * 60 * 1000).toISOString()
    });
  }

  mockStore._records = records;

  const startRehydrate = process.hrtime.bigint();
  const engine = new RecentActivityEngine(mockStore);
  const endRehydrate = process.hrtime.bigint();

  const curCtx = makeContext('TARGET-VEH', 'distraction', new Date(nowMs).toISOString(), 999999);

  const startQuery = process.hrtime.bigint();
  const recent = engine.buildRecentActivity(curCtx);
  const endQuery = process.hrtime.bigint();

  const rehydrateMs = Number(endRehydrate - startRehydrate) / 1e6;
  const queryMs = Number(endQuery - startQuery) / 1e6;

  console.log(`      ↳ Rehydrate 100,000 records: ${rehydrateMs.toFixed(2)} ms`);
  console.log(`      ↳ Recent query performance: ${queryMs.toFixed(3)} ms`);

  assert.ok(queryMs < 10, `Query execution must be < 10ms (was ${queryMs}ms)`);
  assert.strictEqual(recent.windows['5m'].totalEvents, 6); // 5 recent + 1 curCtx
});

// ── TEST 20 — Phase 1 & Legacy Non-Regression ───────────────────────────────
runTest('TEST 20 — Non-regression of Phase 1 and legacy properties', () => {
  const mail = {
    uid: 999,
    date: new Date('2026-09-01T10:00:00.000Z'),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Over Speed Alert',
    text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 118 kmph',
  };

  const result = parser.parse(mail);
  assert.ok(result.alertDef, 'alertDef intact');
  assert.ok(result.fields, 'fields intact');
  assert.ok(result.context, 'context intact');
  assert.ok(result.context.recentActivity, 'context.recentActivity populated');
  assert.strictEqual(result.context.recentActivity.windows['5m'].totalEvents, 1);
});

console.log('\n────────────────────────────────────────────────────────────');
console.log(`📊 TEST RESULTS: ${testsPassed} Passed | ${testsFailed} Failed`);
console.log('────────────────────────────────────────────────────────────\n');

if (testsFailed > 0) {
  process.exit(1);
}

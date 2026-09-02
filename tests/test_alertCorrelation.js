/**
 * tests/test_alertCorrelation.js
 *
 * Comprehensive Test Suite for Feature #2 Phase 1 — Alert Correlation Foundation
 *
 * Tests cases A through N as specified in Section 21 of the master prompt.
 */

const assert = require('assert');
const AlertCorrelationEngine = require('../services/alertCorrelationEngine');
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

function mockContext(overrides = {}) {
  const baseTime = overrides.timestamp || new Date().toISOString();
  const eventId = overrides.eventId || `UID-${Math.floor(Math.random() * 100000)}`;
  const plate = overrides.plate !== undefined ? overrides.plate : 'D/31498';
  const imei = overrides.imei !== undefined ? overrides.imei : null;

  return {
    eventId,
    alertType: overrides.alertType || 'speeding',
    alertLabel: overrides.alertLabel || 'Over Speed',
    severity: overrides.severity || 'HIGH',
    timestamp: baseTime,
    source: 'test',

    vehicle: {
      plate,
      model: 'Toyota Hilux',
      imei,
      driver: 'John Doe',
    },

    telemetry: {
      speed: 110,
      speedLimit: 90,
      excessSpeed: 20,
    },

    location: {
      address: 'Dubai, UAE',
      latitude: 25.2,
      longitude: 55.27,
    },

    recentActivity: overrides.recentActivity || null,
  };
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('🧪 FEATURE #2 PHASE 1 — ALERT CORRELATION TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Test Suite A: Single Event ──────────────────────────────────────────────
runTest('A — Single event returns status SINGLE_EVENT and eventCount 1', () => {
  const engine = new AlertCorrelationEngine({ windowMinutes: 15 });
  const ctx = mockContext({ eventId: 'UID-101' });

  const result = engine.correlate(ctx);

  assert.strictEqual(result.status, 'SINGLE_EVENT');
  assert.strictEqual(result.isCorrelated, false);
  assert.strictEqual(result.eventCount, 1);
  assert.deepStrictEqual(result.eventIds, ['UID-101']);
});

// ── Test Suite B: Two Same-Vehicle Events Inside Window ──────────────────────
runTest('B — Two same-vehicle events inside 15m window are CORRELATED', () => {
  const builder = new EventContextBuilder();
  const t0 = new Date('2026-09-02T10:00:00.000Z').toISOString();
  const t1 = new Date('2026-09-02T10:03:00.000Z').toISOString();

  const ctx1 = builder.build({
    alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
    fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' },
  });

  const ctx2 = builder.build({
    alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' },
    fields: { plate: 'D/31498', alertTime: t1, emailUid: '102' },
  });

  assert.strictEqual(ctx2.alertCorrelation.status, 'CORRELATED');
  assert.strictEqual(ctx2.alertCorrelation.isCorrelated, true);
  assert.strictEqual(ctx2.alertCorrelation.eventCount, 2);
  assert.deepStrictEqual(ctx2.alertCorrelation.eventIds, ['UID-101', 'UID-102']);
  assert.strictEqual(ctx2.alertCorrelation.durationMs, 3 * 60 * 1000);
});

// ── Test Suite C: Three Same-Vehicle Events ─────────────────────────────────
runTest('C — Three same-vehicle events in window are all included', () => {
  const builder = new EventContextBuilder();
  const t0 = new Date('2026-09-02T10:00:00.000Z').toISOString();
  const t1 = new Date('2026-09-02T10:03:00.000Z').toISOString();
  const t2 = new Date('2026-09-02T10:06:00.000Z').toISOString();

  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });
  builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: t1, emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: t2, emailUid: '103' } });

  assert.strictEqual(ctx3.alertCorrelation.status, 'CORRELATED');
  assert.strictEqual(ctx3.alertCorrelation.eventCount, 3);
  assert.deepStrictEqual(ctx3.alertCorrelation.eventIds, ['UID-101', 'UID-102', 'UID-103']);
  assert.deepStrictEqual(ctx3.alertCorrelation.eventTypes, ['speeding', 'harsh_acceleration', 'harsh_braking']);
});

// ── Test Suite D: Out-of-Window Events Excluded ──────────────────────────────
runTest('D — Event outside 15m window is NOT correlated', () => {
  const builder = new EventContextBuilder();
  const t0 = new Date('2026-09-02T10:00:00.000Z').toISOString(); // T-20m
  const t1 = new Date('2026-09-02T10:20:00.000Z').toISOString(); // T-0m

  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: t1, emailUid: '102' } });

  assert.strictEqual(ctx2.alertCorrelation.status, 'SINGLE_EVENT');
  assert.strictEqual(ctx2.alertCorrelation.eventCount, 1);
  assert.deepStrictEqual(ctx2.alertCorrelation.eventIds, ['UID-102']);
});

// ── Test Suite E: Vehicle Isolation ─────────────────────────────────────────
runTest('E — Events from Vehicle A never correlate with Vehicle B', () => {
  const builder = new EventContextBuilder();
  const t0 = new Date('2026-09-02T10:00:00.000Z').toISOString();
  const t1 = new Date('2026-09-02T10:02:00.000Z').toISOString();

  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });
  const ctxB = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'E/99999', alertTime: t1, emailUid: '102' } });

  assert.strictEqual(ctxB.alertCorrelation.status, 'SINGLE_EVENT');
  assert.strictEqual(ctxB.alertCorrelation.eventCount, 1);
  assert.strictEqual(ctxB.alertCorrelation.vehicleKey, 'PLATE:E99999');
  assert.deepStrictEqual(ctxB.alertCorrelation.eventIds, ['UID-102']);
});

// ── Test Suite F: Duplicate Event Deduplication ──────────────────────────────
runTest('F — Processing same eventId twice yields eventCount 1', () => {
  const builder = new EventContextBuilder();
  const t0 = new Date('2026-09-02T10:00:00.000Z').toISOString();

  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });
  const ctxDup = builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });

  assert.strictEqual(ctxDup.alertCorrelation.eventCount, 1);
  assert.deepStrictEqual(ctxDup.alertCorrelation.eventIds, ['UID-101']);
});

// ── Test Suite G: Out-of-Order Event Ordering ────────────────────────────────
runTest('G — Out-of-order event timestamps are ordered chronologically', () => {
  const engine = new AlertCorrelationEngine({ windowMinutes: 15 });
  const t0 = '2026-09-02T10:00:00.000Z';
  const t1 = '2026-09-02T10:05:00.000Z';
  const t2 = '2026-09-02T10:10:00.000Z';

  // Build simulated recentActivity with out-of-order events
  const mockRecentActivity = {
    windows: {
      '15m': {
        events: [
          { eventId: 'UID-103', alertType: 'harsh_braking', timestamp: t2 },
          { eventId: 'UID-101', alertType: 'speeding', timestamp: t0 },
          { eventId: 'UID-102', alertType: 'harsh_acceleration', timestamp: t1 },
        ],
      },
    },
  };

  const ctx = mockContext({
    eventId: 'UID-103',
    alertType: 'harsh_braking',
    timestamp: t2,
    recentActivity: mockRecentActivity,
  });

  const result = engine.correlate(ctx);

  assert.strictEqual(result.eventCount, 3);
  assert.deepStrictEqual(result.eventIds, ['UID-101', 'UID-102', 'UID-103']);
  assert.strictEqual(result.startTime, t0);
  assert.strictEqual(result.latestTime, t2);
  assert.strictEqual(result.durationMs, 10 * 60 * 1000);
});

// ── Test Suite H: Current Event Inclusion ────────────────────────────────────
runTest('H — Current event appears exactly once in correlation output', () => {
  const engine = new AlertCorrelationEngine({ windowMinutes: 15 });
  const t0 = '2026-09-02T10:00:00.000Z';
  const t1 = '2026-09-02T10:05:00.000Z';

  const mockRecent = {
    windows: {
      '15m': {
        events: [{ eventId: 'UID-101', alertType: 'speeding', timestamp: t0 }],
      },
    },
  };

  const ctx = mockContext({
    eventId: 'UID-102',
    alertType: 'harsh_braking',
    timestamp: t1,
    recentActivity: mockRecent,
  });

  const result = engine.correlate(ctx);

  assert.strictEqual(result.eventCount, 2);
  assert.deepStrictEqual(result.eventIds, ['UID-101', 'UID-102']);
});

// ── Test Suite I: Missing Vehicle Identity Safety ────────────────────────────
runTest('I — Missing plate and IMEI falls back safely to UNKNOWN', () => {
  const engine = new AlertCorrelationEngine();
  const ctx = mockContext({ plate: null, imei: null });

  const result = engine.correlate(ctx);

  assert.strictEqual(result.vehicleKey, 'UNKNOWN');
  assert.strictEqual(result.status, 'SINGLE_EVENT');
  assert.strictEqual(result.eventCount, 1);
});

// ── Test Suite J: Missing Timestamp Safety ────────────────────────────────────
runTest('J — Missing alert timestamp falls back without throwing', () => {
  const engine = new AlertCorrelationEngine();
  const ctx = mockContext({ timestamp: null });

  const result = engine.correlate(ctx);

  assert.strictEqual(result.status, 'SINGLE_EVENT');
  assert.ok(result.startTime);
  assert.ok(result.latestTime);
});

// ── Test Suite K: Correlation ID Stability ────────────────────────────────────
runTest('K — Ongoing correlation maintains a stable correlationId', () => {
  const builder = new EventContextBuilder();
  const t0 = '2026-09-02T10:00:00.000Z';
  const t1 = '2026-09-02T10:03:00.000Z';
  const t2 = '2026-09-02T10:06:00.000Z';

  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t0, emailUid: '101' } });
  const ctx2 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: t1, emailUid: '102' } });
  const ctx3 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: t2, emailUid: '103' } });

  assert.strictEqual(ctx2.alertCorrelation.correlationId, 'CORR-PLATE:D31498-UID-101');
  assert.strictEqual(ctx3.alertCorrelation.correlationId, 'CORR-PLATE:D31498-UID-101');
});

// ── Test Suite L: Independent Correlations Do Not Merge ─────────────────────
runTest('L — Multiple independent vehicle correlations do not merge', () => {
  const builder = new EventContextBuilder();
  const t0 = '2026-09-02T10:00:00.000Z';
  const t1 = '2026-09-02T10:02:00.000Z';

  // Vehicle A events
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'AAA-111', alertTime: t0, emailUid: '201' } });
  const ctxA2 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'AAA-111', alertTime: t1, emailUid: '202' } });

  // Vehicle B events
  builder.build({ alertDef: { type: 'fatigue' }, fields: { plate: 'BBB-222', alertTime: t0, emailUid: '301' } });
  const ctxB2 = builder.build({ alertDef: { type: 'distraction' }, fields: { plate: 'BBB-222', alertTime: t1, emailUid: '302' } });

  assert.strictEqual(ctxA2.alertCorrelation.vehicleKey, 'PLATE:AAA111');
  assert.deepStrictEqual(ctxA2.alertCorrelation.eventIds, ['UID-201', 'UID-202']);

  assert.strictEqual(ctxB2.alertCorrelation.vehicleKey, 'PLATE:BBB222');
  assert.deepStrictEqual(ctxB2.alertCorrelation.eventIds, ['UID-301', 'UID-302']);
});

// ── Test Suite M: Empty Input Safety ─────────────────────────────────────────
runTest('M — Null or empty input returns safe empty correlation context', () => {
  const engine = new AlertCorrelationEngine();
  const result1 = engine.correlate(null);
  const result2 = engine.correlate(undefined);

  assert.strictEqual(result1.status, 'NONE');
  assert.strictEqual(result1.eventCount, 0);
  assert.strictEqual(result2.status, 'NONE');
  assert.strictEqual(result2.eventCount, 0);
});

// ── Test Suite N: Engine Failure Isolation ────────────────────────────────────
runTest('N — Thrown exception inside correlation engine returns safe fallback object', () => {
  const engine = new AlertCorrelationEngine();
  // Pass malformed object that causes deriveVehicleKey to throw if unhandled
  const malformedCtx = {
    vehicle: {
      get imei() { throw new Error('Simulated engine failure'); }
    }
  };

  const result = engine.correlate(malformedCtx);

  assert.strictEqual(result.status, 'NONE');
  assert.strictEqual(result.eventCount, 0);
  assert.strictEqual(result.isCorrelated, false);
});

// ── Test Suite O: Strict Sliding Window Boundaries (10:00, 10:14, 10:28 Timeline) ──
runTest('O — Strict 15m window boundary excludes 10:00 event when 10:28 event arrives', () => {
  const builder = new EventContextBuilder();
  const t00 = '2026-09-02T10:00:00.000Z'; // 10:00
  const t14 = '2026-09-02T10:14:00.000Z'; // 10:14
  const t28 = '2026-09-02T10:28:00.000Z'; // 10:28

  // Event 1 at 10:00
  builder.build({ alertDef: { type: 'speeding' }, fields: { plate: 'D/31498', alertTime: t00, emailUid: '101' } });

  // Event 2 at 10:14 (14 mins after 10:00 -> 10:00 is inside 15m window [10:00 - 15m = 09:59])
  const ctx14 = builder.build({ alertDef: { type: 'harsh_acceleration' }, fields: { plate: 'D/31498', alertTime: t14, emailUid: '102' } });

  assert.strictEqual(ctx14.alertCorrelation.status, 'CORRELATED');
  assert.strictEqual(ctx14.alertCorrelation.eventCount, 2);
  assert.deepStrictEqual(ctx14.alertCorrelation.eventIds, ['UID-101', 'UID-102']);

  // Event 3 at 10:28 (28 mins after 10:00 -> 10:00 is OUTSIDE 15m window [10:28 - 15m = 10:13])
  const ctx28 = builder.build({ alertDef: { type: 'harsh_braking' }, fields: { plate: 'D/31498', alertTime: t28, emailUid: '103' } });

  assert.strictEqual(ctx28.alertCorrelation.status, 'CORRELATED');
  assert.strictEqual(ctx28.alertCorrelation.eventCount, 2); // UID-102 & UID-103 only!
  assert.deepStrictEqual(ctx28.alertCorrelation.eventIds, ['UID-102', 'UID-103']); // UID-101 (10:00) is excluded!
  assert.strictEqual(ctx28.alertCorrelation.correlationId, 'CORR-PLATE:D31498-UID-102'); // Anchor shifted to UID-102!
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`📊 TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (failedTests > 0) {
  process.exit(1);
}

/**
 * tests/test_phase4_validation.js
 *
 * Phase 4 — Complete Event Context Validation & Production-Readiness Suite
 *
 * Validates the full pipeline under realistic conditions using synthetic
 * replay fixtures that mirror the actual email formats sent by:
 *   - System 1 (TouchTrack / original alert sender)
 *   - Track9999
 *
 * Tests are organized into sections:
 *   SECTION A — Single-Event EventContext Validation (all alert types)
 *   SECTION B — Vehicle Identity & Isolation
 *   SECTION C — Current-Event Deduplication
 *   SECTION D — RecentActivity Window Boundaries
 *   SECTION E — Out-of-Order Event Handling
 *   SECTION F — Ignition / Trip Context Validation
 *   SECTION G — Intelligence Signal Validation
 *   SECTION H — Escalation & Contextual Risk False-Positive Audit
 *   SECTION I — Multi-Vehicle Stress Test
 *   SECTION J — Missing / Partial Data Safety
 *   SECTION K — Performance Benchmarks
 *   SECTION L — Phase 1/2/3 Regression Confirmation
 */

const assert = require('assert');
const AlertParser          = require('../services/alertParser');
const ContextIntelligenceEngine = require('../services/contextIntelligenceEngine');
const RecentActivityEngine = require('../services/recentActivityEngine');

console.log('═══════════════════════════════════════════════════════════════');
console.log('🔬 PHASE 4 — COMPLETE EVENT CONTEXT VALIDATION SUITE');
console.log('   NOTE: SYNTHETIC REPLAY VALIDATION (real emails not available)');
console.log('═══════════════════════════════════════════════════════════════\n');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     → ${err.message}`);
    if (err.stack) console.error(`     ${err.stack.split('\n')[1]?.trim()}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ─── Mock HistoryStore ─────────────────────────────────────────────────────
class MockHistoryStore {
  constructor(opts = {}) {
    this._records = opts.records || [];
    this.onState  = opts.onState  || {};
    this.offState = opts.offState || {};
  }
  getLastIgnitionOn(plate)  { return this.onState[plate]  || null; }
  getLastIgnitionOff(plate) { return this.offState[plate] || null; }
}

// ─── Synthetic Email Fixtures ──────────────────────────────────────────────

const SYSTEM1_SENDER = 'noreply@yourtrackingsystem.com';

function makeSystem1Mail(uid, subject, textBody, htmlBody = null, date = null) {
  return {
    uid,
    date: date || new Date('2026-09-01T10:00:00.000Z'),
    from: { value: [{ address: SYSTEM1_SENDER }] },
    subject,
    text: textBody,
    html: htmlBody,
  };
}

function makeTrack9999Mail(uid, subject, textBody, htmlBody = null, date = null) {
  return {
    uid,
    date: date || new Date('2026-09-01T10:00:00.000Z'),
    from: { value: [{ address: 'noreply@track9999.com' }] },
    subject,
    text: textBody,
    html: htmlBody,
  };
}

const FIXTURES = {
  speeding: makeSystem1Mail(1001, 'Over Speed Alert',
    'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 118 kmph\n lat: 25.1234 lon: 55.2345',
    '<a href="https://maps.google.com/?q=25.1234,55.2345">Al Quoz Industrial Area 3, Dubai</a>'),

  ignition_on: makeSystem1Mail(1002, 'Ignition ON Alert',
    'Your P17584-Toyota Hilux ignition was turned on at JAFZA on 2026-09-01 10:00:00'),

  ignition_off: makeSystem1Mail(1003, 'Ignition OFF Alert',
    'Your P17584-Toyota Hilux ignition was turned off at Dubai Investment Park on 2026-09-01 10:30:00'),

  idle: makeSystem1Mail(1004, 'Excessive Idle Alert',
    'Your S23401-Nissan Patrol is exceeding the idle limit 30 minutes on 2026-09-01 10:00:00\n 42'),

  harsh_braking: makeSystem1Mail(1005, 'Harsh Braking Alert',
    'Your D/31498-Toyota Hilux harsh braking on 2026-09-01 10:00:00'),

  harsh_acceleration: makeSystem1Mail(1006, 'Harsh Acceleration Alert',
    'Your D/31498-Toyota Hilux harsh acceleration on 2026-09-01 10:00:00'),

  geofence_exit: makeSystem1Mail(1007, 'Geofence Exit Alert',
    'Your D/31498-Toyota Hilux geofence exit on 2026-09-01 10:00:00'),

  geofence_enter: makeSystem1Mail(1008, 'Geofence Enter Alert',
    'Your D/31498-Toyota Hilux entered zone on 2026-09-01 10:00:00'),

  sos: makeSystem1Mail(1009, 'SOS Alert',
    'Your D/31498-Toyota Hilux SOS alert on 2026-09-01 10:00:00'),

  tampering: makeSystem1Mail(1010, 'Tampering Alert',
    'Your D/31498-Toyota Hilux tampering detected on 2026-09-01 10:00:00'),

  accident: makeSystem1Mail(1011, 'Collision Alert',
    'Your D/31498-Toyota Hilux ubi collision detected on 2026-09-01 10:00:00'),

  low_battery: makeSystem1Mail(1012, 'Low Battery Alert',
    'Your D/31498-Toyota Hilux low battery on 2026-09-01 10:00:00'),

  fuel_drop: makeSystem1Mail(1013, 'Fuel Drop Alert',
    'Your D/31498-Toyota Hilux fuel drop detected on 2026-09-01 10:00:00'),

  gps_lost: makeSystem1Mail(1014, 'GPS Lost Alert',
    'Your D/31498-Toyota Hilux gps lost on 2026-09-01 10:00:00'),

  gps_restored: makeSystem1Mail(1015, 'GPS Restored',
    'Your D/31498-Toyota Hilux gps jamming ended on 2026-09-01 10:00:00'),

  // Track9999 fixtures
  distraction: makeTrack9999Mail(1016,
    'Tracker Event Notification[Distraction Alert(70.9km/h)][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Distraction Alert(70.9km/h)\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456\nPosition: http://track9999.com/pos?id=1',
    'Position: <a href="http://track9999.com/pos?id=1">Click to View</a>'),

  vibration: makeTrack9999Mail(1017,
    'Tracker Event Notification[Vibration Alert][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Vibration Alert\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  lte_jamming: makeTrack9999Mail(1018,
    'Tracker Event Notification[LTE Jamming Detected(65km/h)][CC-48315]',
    'Tracker Name: CC-48315\nEvent: LTE Jamming Detected(65km/h)\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  lte_restored: makeTrack9999Mail(1019,
    'Tracker Event Notification[LTE Jamming Ended][CC-48315]',
    'Tracker Name: CC-48315\nEvent: LTE Jamming Ended\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  fatigue: makeTrack9999Mail(1020,
    'Tracker Event Notification[Fatigue Driving Alert][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Fatigue Driving Alert\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  offline: makeTrack9999Mail(1021,
    'Tracker Event Notification[Offline Alert][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Offline Alert\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  camera_blocked: makeTrack9999Mail(1022,
    'Tracker Event Notification[Camera Screen Blocked][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Camera Screen Blocked\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  seatbelt: makeTrack9999Mail(1023,
    'Tracker Event Notification[Not Wearing Seat Belt][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Not Wearing Seat Belt\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  smoking: makeTrack9999Mail(1024,
    'Tracker Event Notification[Smoking Alert][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Smoking Alert\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  engine_failure: makeTrack9999Mail(1025,
    'Tracker Event Notification[Engine Failure][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Engine Failure\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  drinking: makeTrack9999Mail(1026,
    'Tracker Event Notification[Drinking(55km/h)][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Drinking(55km/h)\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  lane_change: makeTrack9999Mail(1027,
    'Tracker Event Notification[Abrupt Lane Switching Alert][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Abrupt Lane Switching Alert\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),

  voice_alarm: makeTrack9999Mail(1028,
    'Tracker Event Notification[Voice Alarm][CC-48315]',
    'Tracker Name: CC-48315\nEvent: Voice Alarm\nTime: 2026-09-01 10:00:00\nIMEI: 864201040123456',
    null),
};

// ─── Setup Parser ─────────────────────────────────────────────────────────
const mockHistory = new MockHistoryStore();
const parser = new AlertParser();
parser.setHistoryStore(mockHistory);

const parseResult = (mail) => parser.parse(mail);
const ctx = (mail) => parseResult(mail)?.context;

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — Single-Event EventContext Validation
// ═══════════════════════════════════════════════════════════════════════════
section('A — Single-Event EventContext Validation (all alert types)');

test('A01 — System 1: speeding — alertType, severity, speed, speedLimit, excessSpeed', () => {
  const c = ctx(FIXTURES.speeding);
  assert.ok(c, 'context must exist');
  assert.strictEqual(c.alertType, 'speeding');
  assert.strictEqual(c.alertLabel, 'Over Speed');
  assert.strictEqual(c.severity, 'HIGH');
  assert.strictEqual(c.source, 'system1');
  assert.strictEqual(c.vehicle.plate, 'D/31498');
  assert.strictEqual(c.vehicle.model, 'Toyota Hilux');
  assert.strictEqual(c.telemetry.speed, 118);
  assert.strictEqual(c.telemetry.speedLimit, 100);
  assert.strictEqual(c.telemetry.excessSpeed, 18);
  assert.strictEqual(c.location.address, 'Al Quoz Industrial Area 3, Dubai');
  assert.ok(c.location.mapsUrl?.includes('25.1234'));
  assert.strictEqual(c.eventId, 'UID-1001');
  assert.ok(c.timestamp);
});

test('A02 — System 1: ignition_on — parsed correctly', () => {
  const c = ctx(FIXTURES.ignition_on);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'ignition_on');
  assert.strictEqual(c.severity, 'LOW');
  assert.strictEqual(c.vehicle.plate, 'P17584');
  assert.strictEqual(c.eventId, 'UID-1002');
  assert.strictEqual(c.telemetry.speed, null);
  assert.strictEqual(c.telemetry.speedLimit, null);
});

test('A03 — System 1: ignition_off — parsed correctly', () => {
  const c = ctx(FIXTURES.ignition_off);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'ignition_off');
  assert.strictEqual(c.severity, 'LOW');
  assert.strictEqual(c.vehicle.plate, 'P17584');
});

test('A04 — System 1: idle — idleTime, idleLimit, overIdleTime', () => {
  const c = ctx(FIXTURES.idle);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'idle');
  assert.strictEqual(c.severity, 'LOW');
  assert.strictEqual(c.vehicle.plate, 'S23401');
  assert.strictEqual(c.telemetry.idleTime, 42);
  assert.strictEqual(c.telemetry.idleLimit, 30);
  assert.strictEqual(c.telemetry.overIdleTime, 12);
});

test('A05 — System 1: harsh_braking — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.harsh_braking);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'harsh_braking');
  assert.strictEqual(c.severity, 'MEDIUM');
  assert.strictEqual(c.vehicle.plate, 'D/31498');
});

test('A06 — System 1: harsh_acceleration — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.harsh_acceleration);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'harsh_acceleration');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A07 — System 1: geofence_exit — alertType HIGH', () => {
  const c = ctx(FIXTURES.geofence_exit);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'geofence_exit');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A08 — System 1: geofence_enter — alertType LOW', () => {
  const c = ctx(FIXTURES.geofence_enter);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'geofence_enter');
  assert.strictEqual(c.severity, 'LOW');
});

test('A09 — System 1: sos — alertType CRITICAL', () => {
  const c = ctx(FIXTURES.sos);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'sos');
  assert.strictEqual(c.severity, 'CRITICAL');
});

test('A10 — System 1: tampering — alertType HIGH', () => {
  const c = ctx(FIXTURES.tampering);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'tampering');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A11 — System 1: accident/collision — alertType CRITICAL', () => {
  const c = ctx(FIXTURES.accident);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'accident');
  assert.strictEqual(c.severity, 'CRITICAL');
});

test('A12 — System 1: low_battery — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.low_battery);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'low_battery');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A13 — System 1: fuel_drop — alertType HIGH', () => {
  const c = ctx(FIXTURES.fuel_drop);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'fuel_drop');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A14 — System 1: gps_lost — alertType HIGH', () => {
  const c = ctx(FIXTURES.gps_lost);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'gps_lost');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A15 — System 1: gps_restored — alertType LOW', () => {
  const c = ctx(FIXTURES.gps_restored);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'gps_restored');
  assert.strictEqual(c.severity, 'LOW');
});

test('A16 — Track9999: distraction — alertType, IMEI, speed, trackUrl', () => {
  const c = ctx(FIXTURES.distraction);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'distraction');
  assert.strictEqual(c.severity, 'HIGH');
  assert.strictEqual(c.source, 'track9999');
  assert.strictEqual(c.vehicle.plate, 'CC-48315');
  assert.strictEqual(c.vehicle.imei, '864201040123456');
  assert.strictEqual(c.telemetry.speed, 70.9);
  assert.ok(c.location.trackUrl?.includes('track9999'));
  assert.strictEqual(c.eventId, 'UID-1016');
});

test('A17 — Track9999: vibration — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.vibration);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'vibration');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A18 — Track9999: lte_jamming — alertType HIGH', () => {
  const c = ctx(FIXTURES.lte_jamming);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'lte_jamming');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A19 — Track9999: lte_restored — alertType LOW', () => {
  const c = ctx(FIXTURES.lte_restored);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'lte_restored');
  assert.strictEqual(c.severity, 'LOW');
});

test('A20 — Track9999: fatigue — alertType HIGH', () => {
  const c = ctx(FIXTURES.fatigue);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'fatigue');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A21 — Track9999: offline — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.offline);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'offline');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A22 — Track9999: camera_blocked — alertType HIGH', () => {
  const c = ctx(FIXTURES.camera_blocked);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'camera_blocked');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A23 — Track9999: seatbelt — alertType HIGH', () => {
  const c = ctx(FIXTURES.seatbelt);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'seatbelt');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A24 — Track9999: smoking — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.smoking);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'smoking');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A25 — Track9999: engine_failure — alertType CRITICAL', () => {
  const c = ctx(FIXTURES.engine_failure);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'engine_failure');
  assert.strictEqual(c.severity, 'CRITICAL');
});

test('A26 — Track9999: drinking — alertType HIGH', () => {
  const c = ctx(FIXTURES.drinking);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'drinking');
  assert.strictEqual(c.severity, 'HIGH');
});

test('A27 — Track9999: lane_change — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.lane_change);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'lane_change');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A28 — Track9999: voice_alarm — alertType MEDIUM', () => {
  const c = ctx(FIXTURES.voice_alarm);
  assert.ok(c);
  assert.strictEqual(c.alertType, 'voice_alarm');
  assert.strictEqual(c.severity, 'MEDIUM');
});

test('A29 — All EventContext fields present on every parsed result', () => {
  const required = ['eventId','alertType','alertLabel','severity','timestamp','source','vehicle','telemetry','location','trip','metadata','recentActivity','contextIntelligence'];
  for (const [name, mail] of Object.entries(FIXTURES)) {
    const c = ctx(mail);
    if (!c) continue;
    for (const field of required) {
      assert.ok(field in c, `Fixture "${name}" missing field: ${field}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — Vehicle Identity & Isolation
// ═══════════════════════════════════════════════════════════════════════════
section('B — Vehicle Identity & Isolation');

const engine_B = new RecentActivityEngine(null);

test('B01 — IMEI-based vehicle key takes priority over plate', () => {
  const engine = new RecentActivityEngine(null);
  const key = engine.deriveVehicleKey({ imei: '864201040123456', plate: 'CC-48315' });
  assert.strictEqual(key, 'IMEI:864201040123456');
});

test('B02 — Plate-based vehicle key used when no IMEI', () => {
  const engine = new RecentActivityEngine(null);
  const key = engine.deriveVehicleKey({ imei: null, plate: 'D/31498' });
  assert.strictEqual(key, 'PLATE:D31498');
});

test('B03 — Plate normalization: lowercase, spaces, hyphens, slashes all same key', () => {
  const engine = new RecentActivityEngine(null);
  const variants = ['CC-48315', 'cc-48315', 'CC 48315', 'cc/48315', 'CC48315'];
  const keys = variants.map(p => engine.deriveVehicleKey({ plate: p }));
  const unique = [...new Set(keys)];
  assert.strictEqual(unique.length, 1, `Expected all plate variants to normalize to same key, got: ${keys.join(', ')}`);
});

test('B04 — Vehicle A events never in Vehicle B recentActivity', () => {
  const engine = new RecentActivityEngine(null);
  const baseMs = new Date('2026-09-01T10:00:00.000Z').getTime();

  // Simulate 3 events for Vehicle A
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  function buildCtx(plate, type, uid, offsetMs) {
    const mail = { uid, date: new Date(baseMs + offsetMs), from: { value: [{ address: SYSTEM1_SENDER }] }, subject: type };
    const c = localParser.contextBuilder.build({ alertDef: { type, label: type, severity: 'HIGH' }, fields: { plate, alertTime: new Date(baseMs + offsetMs).toISOString(), source: 'system1' } }, mail);
    engine.registerEvent(c);
    return c;
  }

  buildCtx('VEH-A', 'speeding', 2001, -300000);
  buildCtx('VEH-A', 'harsh_braking', 2002, -200000);

  const curCtxB = buildCtx('VEH-B', 'distraction', 2003, 0);
  const recentB = engine.buildRecentActivity(curCtxB);

  const eventIds60m = recentB.windows['60m'].events.map(e => e.eventId);
  assert.ok(!eventIds60m.includes('UID-2001'), 'Vehicle A speeding must NOT appear in Vehicle B context');
  assert.ok(!eventIds60m.includes('UID-2002'), 'Vehicle A harsh_braking must NOT appear in Vehicle B context');
  assert.ok(eventIds60m.includes('UID-2003'), 'Vehicle B distraction must appear in its own context');
});

test('B05 — No IMEI, no plate → UNKNOWN key, no cross-contamination', () => {
  const engine = new RecentActivityEngine(null);
  const key = engine.deriveVehicleKey({ imei: null, plate: null });
  assert.strictEqual(key, 'UNKNOWN');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — Current-Event Deduplication
// ═══════════════════════════════════════════════════════════════════════════
section('C — Current-Event Deduplication');

test('C01 — Current event appears exactly once in each window', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const mail = makeSystem1Mail(3001, 'Over Speed Alert', 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 118 kmph');
  const c = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, mail);

  engine.registerEvent(c);
  engine.registerEvent(c); // duplicate

  const recent = engine.buildRecentActivity(c);
  const ids5m = recent.windows['5m'].events.map(e => e.eventId);
  const uniqueIds = [...new Set(ids5m)];
  assert.strictEqual(ids5m.length, uniqueIds.length, `Duplicate event found in 5m window: ${ids5m}`);
});

test('C02 — Same UID processed twice: only appears once in recentActivity', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const mail = makeSystem1Mail(3002, 'Over Speed Alert', 'Your P17584-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:05:00\n 110 kmph');
  const c1 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'P17584', alertTime: '2026-09-01T10:05:00.000Z', source: 'system1' } }, mail);
  const c2 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'P17584', alertTime: '2026-09-01T10:05:00.000Z', source: 'system1' } }, mail);

  engine.registerEvent(c1);
  engine.registerEvent(c2);

  const recent = engine.buildRecentActivity(c1);
  const speedingCount = recent.windows['60m'].countsByAlertType['speeding'] || 0;
  assert.strictEqual(speedingCount, 1, `Expected 1 speeding event, got ${speedingCount}`);
});

test('C03 — Two different UIDs for same alert type: both appear', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const mail1 = makeSystem1Mail(4001, 'Over Speed Alert', 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 115 kmph');
  const mail2 = makeSystem1Mail(4002, 'Over Speed Alert', 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:04:00\n 120 kmph', null, new Date('2026-09-01T10:04:00.000Z'));

  const c1 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, mail1);
  const c2 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:04:00.000Z', source: 'system1' } }, mail2);

  engine.registerEvent(c1);
  const recent = engine.buildRecentActivity(c2);
  const speedingCount = recent.windows['5m'].countsByAlertType['speeding'] || 0;
  assert.strictEqual(speedingCount, 2, `Expected 2 distinct speeding events, got ${speedingCount}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION D — RecentActivity Window Boundaries
// ═══════════════════════════════════════════════════════════════════════════
section('D — RecentActivity Window Boundaries');

test('D01 — Event at T-4m50s: inside 5m window', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const curMs = new Date('2026-09-01T10:10:00.000Z').getTime();
  const pastMs = curMs - (4 * 60 + 50) * 1000;

  const past = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(pastMs).toISOString(), source: 'system1' } }, { uid: 5001 });
  engine.registerEvent(past);

  const cur = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(curMs).toISOString(), source: 'system1' } }, { uid: 5002 });
  const recent = engine.buildRecentActivity(cur);
  assert.strictEqual(recent.windows['5m'].totalEvents, 2);
});

test('D02 — Event at T-5m10s: outside 5m window, inside 15m', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const curMs = new Date('2026-09-01T10:15:00.000Z').getTime();
  const pastMs = curMs - (5 * 60 + 10) * 1000;

  const past = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(pastMs).toISOString(), source: 'system1' } }, { uid: 5003 });
  engine.registerEvent(past);

  const cur = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(curMs).toISOString(), source: 'system1' } }, { uid: 5004 });
  const recent = engine.buildRecentActivity(cur);
  assert.strictEqual(recent.windows['5m'].totalEvents, 1);  // only cur
  assert.strictEqual(recent.windows['15m'].totalEvents, 2); // cur + past
});

test('D03 — Event at T-30m: inside 30m and 60m windows only', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const curMs = new Date('2026-09-01T11:00:00.000Z').getTime();
  const pastMs = curMs - 30 * 60 * 1000;

  const past = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(pastMs).toISOString(), source: 'system1' } }, { uid: 5005 });
  engine.registerEvent(past);

  const cur = localParser.contextBuilder.build({ alertDef: { type: 'idle', label: 'Idle', severity: 'LOW' }, fields: { plate: 'D/31498', alertTime: new Date(curMs).toISOString(), source: 'system1' } }, { uid: 5006 });
  const recent = engine.buildRecentActivity(cur);
  assert.strictEqual(recent.windows['5m'].totalEvents, 1);
  assert.strictEqual(recent.windows['15m'].totalEvents, 1);
  assert.strictEqual(recent.windows['30m'].totalEvents, 2);
  assert.strictEqual(recent.windows['60m'].totalEvents, 2);
});

test('D04 — Event at T-61m: outside all windows', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const curMs = new Date('2026-09-01T12:00:00.000Z').getTime();
  const pastMs = curMs - 61 * 60 * 1000;

  const past = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(pastMs).toISOString(), source: 'system1' } }, { uid: 5007 });
  engine.registerEvent(past);

  const cur = localParser.contextBuilder.build({ alertDef: { type: 'idle', label: 'Idle', severity: 'LOW' }, fields: { plate: 'D/31498', alertTime: new Date(curMs).toISOString(), source: 'system1' } }, { uid: 5008 });
  const recent = engine.buildRecentActivity(cur);
  assert.strictEqual(recent.windows['60m'].totalEvents, 1); // only cur
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — Out-of-Order Event Handling
// ═══════════════════════════════════════════════════════════════════════════
section('E — Out-of-Order Event Handling');

test('E01 — Events registered out of order sorted newest-first in windows', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const t1 = '2026-09-01T10:00:00.000Z';
  const t2 = '2026-09-01T10:02:00.000Z';
  const t3 = '2026-09-01T10:04:00.000Z';

  // Register in order: t3, t1, t2
  const e3 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speed', severity: 'HIGH' }, fields: { plate: 'VEH-OOO', alertTime: t3, source: 'system1' } }, { uid: 6001 });
  const e1 = localParser.contextBuilder.build({ alertDef: { type: 'idle', label: 'Idle', severity: 'LOW' }, fields: { plate: 'VEH-OOO', alertTime: t1, source: 'system1' } }, { uid: 6002 });
  const e2 = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'HB', severity: 'MEDIUM' }, fields: { plate: 'VEH-OOO', alertTime: t2, source: 'system1' } }, { uid: 6003 });

  engine.registerEvent(e3);
  engine.registerEvent(e1);
  engine.registerEvent(e2);

  const recent = engine.buildRecentActivity(e3);
  const events = recent.windows['5m'].events;
  assert.ok(events.length >= 3);
  // Verify newest first: UID-6001 (t3) should be index 0
  assert.strictEqual(events[0].eventId, 'UID-6001');
  assert.strictEqual(events[1].eventId, 'UID-6003'); // t2 second
  assert.strictEqual(events[2].eventId, 'UID-6002'); // t1 last
});

test('E02 — Sequence detection uses event timestamps, not registration order', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const t1 = '2026-09-01T10:00:00.000Z';
  const t2 = '2026-09-01T10:05:00.000Z';

  // Register harsh_braking (t2) FIRST, then speeding (t1)
  const e2 = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'HB', severity: 'MEDIUM' }, fields: { plate: 'VEH-OOO2', alertTime: t2, source: 'system1' } }, { uid: 7001 });
  engine.registerEvent(e2);

  const e1 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speed', severity: 'HIGH' }, fields: { plate: 'VEH-OOO2', alertTime: t1, source: 'system1' } }, { uid: 7002 });
  engine.registerEvent(e1);

  // Evaluate context for a NEW event at t2
  const curCtx = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'HB', severity: 'MEDIUM' }, fields: { plate: 'VEH-OOO2', alertTime: t2, source: 'system1' } }, { uid: 7001 });
  curCtx.recentActivity = engine.buildRecentActivity(curCtx);
  curCtx.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(curCtx);

  assert.strictEqual(curCtx.contextIntelligence.summary.hasSequence, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION F — Ignition / Trip Context Validation
// ═══════════════════════════════════════════════════════════════════════════
section('F — Ignition / Trip Context Validation');

test('F01 — Active ignition ON → trip.active=true, ignitionState=ON', () => {
  const store = new MockHistoryStore({ onState: { 'P17584': { time: '2026-09-01T09:00:00.000Z' } } });
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'P17584', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 8001 });
  assert.strictEqual(c.trip.ignitionState, 'ON');
  assert.strictEqual(c.trip.active, true);
  assert.strictEqual(c.trip.lastIgnitionOnTime, '2026-09-01T09:00:00.000Z');
});

test('F02 — Ignition OFF more recent → ignitionState=OFF, active=false', () => {
  const store = new MockHistoryStore({
    onState:  { 'P17584': { time: '2026-09-01T08:00:00.000Z' } },
    offState: { 'P17584': '2026-09-01T09:30:00.000Z' },
  });
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'geofence_exit', label: 'Geofence Exit', severity: 'HIGH' }, fields: { plate: 'P17584', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 8002 });
  assert.strictEqual(c.trip.ignitionState, 'OFF');
  assert.strictEqual(c.trip.active, false);
});

test('F03 — No ignition history → UNKNOWN, active=null', () => {
  const store = new MockHistoryStore();
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'tampering', label: 'Tampering', severity: 'HIGH' }, fields: { plate: 'NEWVEH', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 8003 });
  assert.strictEqual(c.trip.ignitionState, 'UNKNOWN');
  assert.strictEqual(c.trip.active, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION G — Intelligence Signal Validation (Core Paths)
// ═══════════════════════════════════════════════════════════════════════════
section('G — Intelligence Signal Validation');

test('G01 — 3x distraction in 15m → REPEATED_DISTRACTION HIGH', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();
  const mkCtx = (uid, offset, eng) => {
    const c = localParser.contextBuilder.build({ alertDef: { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' }, fields: { plate: 'CC-48315', alertTime: new Date(baseMs + offset).toISOString(), imei: '864201040123456', source: 'track9999' } }, { uid });
    eng.registerEvent(c);
    return c;
  };
  mkCtx(9001, -10 * 60 * 1000, engine);
  mkCtx(9002, -5 * 60 * 1000, engine);
  const cur = mkCtx(9003, 0, engine);
  cur.recentActivity = engine.buildRecentActivity(cur);
  cur.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(cur);

  const sig = cur.contextIntelligence.signals.find(s => s.code === 'REPEATED_DISTRACTION');
  assert.ok(sig, 'REPEATED_DISTRACTION signal must exist');
  assert.strictEqual(sig.level, 'HIGH');
  assert.strictEqual(sig.evidence.count, 3);
  assert.ok(Array.isArray(sig.evidence.eventIds));
  assert.ok(sig.evidence.eventIds.every(id => typeof id === 'string' && id.startsWith('UID-')));
});

test('G02 — speeding → harsh_braking within 10m → SPEEDING_TO_HARSH_BRAKING', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:10:00.000Z').getTime();

  const sp = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 5 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 9101 });
  engine.registerEvent(sp);

  const hb = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 9102 });
  hb.recentActivity = engine.buildRecentActivity(hb);
  hb.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(hb);

  const sig = hb.contextIntelligence.signals.find(s => s.code === 'SPEEDING_TO_HARSH_BRAKING');
  assert.ok(sig, 'SPEEDING_TO_HARSH_BRAKING must be generated');
  assert.ok(sig.evidence.eventIds.includes('UID-9101'));
  assert.ok(sig.evidence.eventIds.includes('UID-9102'));
});

test('G03 — speeding + distraction in 15m → SPEEDING_WITH_DISTRACTION', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:10:00.000Z').getTime();

  const sp = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 3 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 9201 });
  engine.registerEvent(sp);

  const di = localParser.contextBuilder.build({ alertDef: { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 9202 });
  di.recentActivity = engine.buildRecentActivity(di);
  di.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(di);

  assert.ok(di.contextIntelligence.signals.some(s => s.code === 'SPEEDING_WITH_DISTRACTION'));
});

test('G04 — All evidence event IDs exist in recentActivity (no phantom IDs)', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:10:00.000Z').getTime();

  const sp = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 3 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 9301 });
  engine.registerEvent(sp);

  const hb = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'HB', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 9302 });
  hb.recentActivity = engine.buildRecentActivity(hb);
  hb.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(hb);

  const allRecentIds = hb.recentActivity.windows['60m'].events.map(e => e.eventId);
  for (const sig of hb.contextIntelligence.signals) {
    for (const eid of (sig.evidence.eventIds || [])) {
      if (eid.startsWith('UID-')) {
        assert.ok(allRecentIds.includes(eid) || eid === hb.eventId, `Phantom event ID in signal "${sig.code}": ${eid}`);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION H — Escalation & Contextual Risk False-Positive Audit
// ═══════════════════════════════════════════════════════════════════════════
section('H — Escalation & Contextual Risk False-Positive Audit');

test('H01 — [FALSE POSITIVE AUDIT] LOW idle → MEDIUM harsh_braking: should NOT trigger escalation', () => {
  // BUG: Pre-fix the escalation detector fires on ANY severity increase.
  // An idle followed by a harsh_braking is not an "escalation" pattern in any meaningful business sense.
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  const idle = localParser.contextBuilder.build({ alertDef: { type: 'idle', label: 'Excessive Idle', severity: 'LOW' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 10 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 10001 });
  engine.registerEvent(idle);

  const hb = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'Harsh Braking', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 10002 });
  hb.recentActivity = engine.buildRecentActivity(hb);
  hb.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(hb);

  const escalation = hb.contextIntelligence.signals.find(s => s.category === 'ESCALATION');
  assert.strictEqual(escalation, undefined, 'Idle→HarshBraking must NOT trigger VIOLATION_ESCALATION');
});

test('H02 — [FALSE POSITIVE AUDIT] geofence_exit (HIGH) during active trip → should NOT produce ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION', () => {
  // BUG: geofence_exit is HIGH severity but is not a "driver safety" event.
  // Routine zone exits should not fire the contextual risk signal.
  const store = new MockHistoryStore({ onState: { 'D/31498': { time: '2026-09-01T09:00:00.000Z' } } });
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'geofence_exit', label: 'Geofence Exit', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 10003 });
  const sig = c.contextIntelligence.signals.find(s => s.code === 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
  assert.strictEqual(sig, undefined, 'geofence_exit during active trip should NOT trigger ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
});

test('H03 — [FALSE POSITIVE AUDIT] fuel_drop (HIGH) during active trip → should NOT produce ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION', () => {
  const store = new MockHistoryStore({ onState: { 'D/31498': { time: '2026-09-01T09:00:00.000Z' } } });
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'fuel_drop', label: 'Fuel Drop', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 10004 });
  const sig = c.contextIntelligence.signals.find(s => s.code === 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
  assert.strictEqual(sig, undefined, 'fuel_drop during active trip should NOT trigger ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
});

test('H04 — [VALID CASE] distraction (HIGH) during active trip → ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION is correct', () => {
  const store = new MockHistoryStore({ onState: { 'CC-48315': { time: '2026-09-01T09:00:00.000Z' } } });
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const c = localParser.contextBuilder.build({ alertDef: { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' }, fields: { plate: 'CC-48315', alertTime: '2026-09-01T10:00:00.000Z', source: 'track9999' } }, { uid: 10005 });
  const sig = c.contextIntelligence.signals.find(s => s.code === 'ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
  assert.ok(sig, 'distraction (HIGH) during active trip SHOULD produce ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION');
});

test('H05 — [VALID CASE] Genuine severity escalation: LOW→MEDIUM→CRITICAL fires correctly', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  const e1 = localParser.contextBuilder.build({ alertDef: { type: 'vibration', label: 'Vibration', severity: 'LOW' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 10 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 10006 });
  engine.registerEvent(e1);
  const e2 = localParser.contextBuilder.build({ alertDef: { type: 'harsh_braking', label: 'HB', severity: 'MEDIUM' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 5 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 10007 });
  engine.registerEvent(e2);
  const e3 = localParser.contextBuilder.build({ alertDef: { type: 'accident', label: 'Collision', severity: 'CRITICAL' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 10008 });
  e3.recentActivity = engine.buildRecentActivity(e3);
  e3.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(e3);

  assert.strictEqual(e3.contextIntelligence.summary.hasEscalation, true, 'Genuine LOW→MEDIUM→CRITICAL escalation must fire');
});

test('H06 — [VALID CASE] REPEATED_ACTIVE_TRIP_RISK: 3 safety alerts during active trip', () => {
  const store = new MockHistoryStore({ onState: { 'CC-48315': { time: '2026-09-01T09:00:00.000Z' } } });
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(store);

  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();
  const mkCtx = (uid, type, severity, offset) => {
    const c = localParser.contextBuilder.build({ alertDef: { type, label: type, severity }, fields: { plate: 'CC-48315', alertTime: new Date(baseMs + offset).toISOString(), source: 'system1' } }, { uid });
    engine.registerEvent(c);
    return c;
  };

  mkCtx(10101, 'speeding', 'HIGH', -10 * 60 * 1000);
  mkCtx(10102, 'distraction', 'HIGH', -5 * 60 * 1000);
  const cur = mkCtx(10103, 'harsh_braking', 'MEDIUM', 0);
  cur.recentActivity = engine.buildRecentActivity(cur);
  cur.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(cur);

  assert.ok(cur.contextIntelligence.signals.some(s => s.code === 'REPEATED_ACTIVE_TRIP_RISK'));
});

test('H07 — [FALSE POSITIVE AUDIT] Same severity repeated events should NOT cause escalation', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const baseMs = new Date('2026-09-01T10:15:00.000Z').getTime();

  const e1 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speeding', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 10 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 10201 });
  engine.registerEvent(e1);
  const e2 = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speeding', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs - 5 * 60 * 1000).toISOString(), source: 'system1' } }, { uid: 10202 });
  engine.registerEvent(e2);
  const cur = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speeding', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: new Date(baseMs).toISOString(), source: 'system1' } }, { uid: 10203 });
  cur.recentActivity = engine.buildRecentActivity(cur);
  cur.contextIntelligence = localParser.contextBuilder.intelligenceEngine.analyze(cur);

  assert.strictEqual(cur.contextIntelligence.summary.hasEscalation, false, 'Repeated same-severity events must NOT trigger escalation');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION I — Multi-Vehicle Stress Test
// ═══════════════════════════════════════════════════════════════════════════
section('I — Multi-Vehicle Stress Test');

test('I01 — 10 vehicles, 100+ events: no crashes, no cross-contamination', () => {
  const engine = new RecentActivityEngine(null);
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());

  const alertTypesList = ['speeding','harsh_braking','distraction','vibration','seatbelt','fatigue','idle','tampering','gps_lost','sos'];
  const severities = { speeding:'HIGH', harsh_braking:'MEDIUM', distraction:'HIGH', vibration:'MEDIUM', seatbelt:'HIGH', fatigue:'HIGH', idle:'LOW', tampering:'HIGH', gps_lost:'HIGH', sos:'CRITICAL' };
  const plates = Array.from({ length: 10 }, (_, i) => `STRESS-VEH-${String(i+1).padStart(2,'0')}`);
  const baseMs = new Date('2026-09-01T10:00:00.000Z').getTime();

  let uid = 20000;
  const vehicleContexts = {};

  for (let v = 0; v < plates.length; v++) {
    const plate = plates[v];
    vehicleContexts[plate] = [];
    for (let e = 0; e < 10; e++) {
      const type = alertTypesList[e % alertTypesList.length];
      const c = localParser.contextBuilder.build({
        alertDef: { type, label: type, severity: severities[type] || 'MEDIUM' },
        fields: { plate, alertTime: new Date(baseMs + e * 60 * 1000).toISOString(), source: 'system1' }
      }, { uid: uid++ });
      assert.ok(c, `Context build failed for plate ${plate}, event type ${type}`);
      engine.registerEvent(c);
      vehicleContexts[plate].push(c);
    }
  }

  // Verify isolation: last event for VEH-01 should not have VEH-10 events
  const lastForV1 = vehicleContexts[plates[0]][9];
  const recentV1 = engine.buildRecentActivity(lastForV1);
  const ids = recentV1.windows['60m'].events.map(e => e.eventId);
  const anyForeignUids = ids.filter(id => {
    const uidNum = parseInt(id.replace('UID-', ''));
    return uidNum >= 20100; // UIDs for VEH-10 started at 20090..20099
  });
  assert.strictEqual(anyForeignUids.length, 0, `VEH-01 context contains foreign vehicle events: ${anyForeignUids.join(',')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION J — Missing / Partial Data Safety
// ═══════════════════════════════════════════════════════════════════════════
section('J — Missing / Partial Data Safety');

test('J01 — No plate: context builds without crash', () => {
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const c = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speed', severity: 'HIGH' }, fields: { alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 30001 });
  assert.ok(c);
  assert.strictEqual(c.vehicle.plate, null);
  assert.ok(c.recentActivity);
  assert.ok(c.contextIntelligence);
});

test('J02 — No timestamp: falls back without crash', () => {
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const c = localParser.contextBuilder.build({ alertDef: { type: 'speeding', label: 'Speed', severity: 'HIGH' }, fields: { plate: 'D/31498', source: 'system1' } }, { uid: 30002 });
  assert.ok(c);
  assert.ok(c.timestamp); // fallback should provide a timestamp
});

test('J03 — No speed/speedLimit: excessSpeed is null', () => {
  const localParser = new AlertParser();
  localParser.setHistoryStore(new MockHistoryStore());
  const c = localParser.contextBuilder.build({ alertDef: { type: 'tampering', label: 'Tampering', severity: 'HIGH' }, fields: { plate: 'D/31498', alertTime: '2026-09-01T10:00:00.000Z', source: 'system1' } }, { uid: 30003 });
  assert.ok(c);
  assert.strictEqual(c.telemetry.speed, null);
  assert.strictEqual(c.telemetry.speedLimit, null);
  assert.strictEqual(c.telemetry.excessSpeed, null);
});

test('J04 — Intelligence engine on null context: safe empty result', () => {
  const intel = new ContextIntelligenceEngine();
  const result = intel.analyze(null);
  assert.ok(result);
  assert.strictEqual(result.summary.signalCount, 0);
});

test('J05 — Intelligence engine on context with missing recentActivity: safe empty result', () => {
  const intel = new ContextIntelligenceEngine();
  const result = intel.analyze({ alertType: 'speeding', vehicle: { plate: 'D/31498' }, trip: {} });
  assert.ok(result);
  assert.strictEqual(result.summary.signalCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION K — Performance Benchmarks
// ═══════════════════════════════════════════════════════════════════════════
section('K — Performance Benchmarks');

console.log('\n  [BENCHMARK SETUP: generating synthetic history...]');
const HISTORY_SIZES = [1000, 10000, 50000, 100000];

for (const size of HISTORY_SIZES) {
  test(`K-PERF — Startup rehydration + single query: ${size.toLocaleString()} records`, () => {
    const store = new MockHistoryStore();
    const nowMs = Date.now();
    store._records = Array.from({ length: size }, (_, i) => ({
      id: i,
      plate: `VEH-BENCH-${i % 20}`,
      alertType: 'speeding',
      alertLabel: 'Over Speed',
      severity: 'HIGH',
      receivedAt: new Date(nowMs - (120 + i) * 60 * 1000).toISOString(), // all > 2 hours old
    }));
    // 5 recent events for our target vehicle
    for (let j = 0; j < 5; j++) {
      store._records.push({
        id: size + j,
        plate: 'TARGET',
        alertType: 'distraction',
        alertLabel: 'Distraction',
        severity: 'HIGH',
        receivedAt: new Date(nowMs - (j + 1) * 60 * 1000).toISOString(),
      });
    }

    const tRehydrate = process.hrtime.bigint();
    const eng = new RecentActivityEngine(store);
    const rehydrateMs = Number(process.hrtime.bigint() - tRehydrate) / 1e6;

    const localParser = new AlertParser();
    localParser.setHistoryStore(store);
    const curCtx = localParser.contextBuilder.build({ alertDef: { type: 'distraction', label: 'Distraction', severity: 'HIGH' }, fields: { plate: 'TARGET', alertTime: new Date(nowMs).toISOString(), source: 'system1' } }, { uid: 99999 });

    const tQuery = process.hrtime.bigint();
    const recent = eng.buildRecentActivity(curCtx);
    const queryMs = Number(process.hrtime.bigint() - tQuery) / 1e6;

    const tIntel = process.hrtime.bigint();
    curCtx.recentActivity = recent;
    const intel = new ContextIntelligenceEngine().analyze(curCtx);
    const intelMs = Number(process.hrtime.bigint() - tIntel) / 1e6;

    console.log(`     ├ Rehydrate: ${rehydrateMs.toFixed(2)}ms  |  Query: ${queryMs.toFixed(3)}ms  |  Intelligence: ${intelMs.toFixed(3)}ms`);
    assert.ok(queryMs < 10, `Query must be < 10ms (was ${queryMs.toFixed(3)}ms)`);
    assert.ok(intelMs < 10, `Intelligence must be < 10ms (was ${intelMs.toFixed(3)}ms)`);
    assert.strictEqual(recent.windows['5m'].totalEvents, 6); // 5 rehydrated + 1 curCtx
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION L — Phase 1/2/3 Regression
// ═══════════════════════════════════════════════════════════════════════════
section('L — Phase 1/2/3 Regression');

test('L01 — Phase 1: EventContext schema fields all present', () => {
  const c = ctx(FIXTURES.speeding);
  ['eventId','alertType','alertLabel','severity','timestamp','source','vehicle','telemetry','location','trip','metadata'].forEach(f => {
    assert.ok(f in c, `Phase 1 field missing: ${f}`);
  });
});

test('L02 — Phase 2: recentActivity windows all present', () => {
  const c = ctx(FIXTURES.speeding);
  assert.ok(c.recentActivity);
  ['5m','15m','30m','60m'].forEach(w => {
    assert.ok(w in c.recentActivity.windows, `Window missing: ${w}`);
    assert.ok('totalEvents' in c.recentActivity.windows[w]);
    assert.ok('countsByAlertType' in c.recentActivity.windows[w]);
    assert.ok(Array.isArray(c.recentActivity.windows[w].events));
  });
});

test('L03 — Phase 3: contextIntelligence present with summary', () => {
  const c = ctx(FIXTURES.speeding);
  assert.ok(c.contextIntelligence);
  assert.ok(c.contextIntelligence.summary);
  assert.ok('signalCount' in c.contextIntelligence.summary);
  assert.ok('highestLevel' in c.contextIntelligence.summary);
  assert.ok(Array.isArray(c.contextIntelligence.signals));
});

test('L04 — Legacy { alertDef, fields } contract preserved', () => {
  const result = parseResult(FIXTURES.speeding);
  assert.ok(result.alertDef);
  assert.ok(result.fields);
  assert.strictEqual(result.alertDef.type, 'speeding');
  assert.ok(result.fields.plate);
});

// ─── Final Report ─────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('📊 PHASE 4 VALIDATION RESULTS');
console.log(`   ✅ Passed: ${passed}   ❌ Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\n   FAILURES:');
  failures.forEach((f, i) => console.log(`   ${i+1}. ${f.name}\n      → ${f.error}`));
}
console.log('═══════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);

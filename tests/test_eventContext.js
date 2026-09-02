/**
 * tests/test_eventContext.js
 *
 * Automated verification suite for Event Context Layer — Phase 1 (Context Foundation)
 */

const assert = require('assert');
const AlertParser = require('../services/alertParser');
const EventContextBuilder = require('../services/eventContext');

console.log('────────────────────────────────────────────────────────────');
console.log('🧪 RUNNING EVENT CONTEXT LAYER PHASE 1 VERIFICATION TESTS');
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

// Dummy Mock HistoryStore for testing
class MockHistoryStore {
  constructor() {
    this.onState = {};
    this.offState = {};
  }
  getLastIgnitionOn(plate) { return this.onState[plate] || null; }
  getLastIgnitionOff(plate) { return this.offState[plate] || null; }
}

const parser = new AlertParser();
const mockHistory = new MockHistoryStore();
parser.setHistoryStore(mockHistory);

// ── Test 1: System 1 Alert Parsing & EventContext ───────────────────────────
runTest('Test 1 — System 1 Alert EventContext Generation', () => {
  const mail = {
    uid: 101,
    date: new Date('2026-09-01T10:00:00.000Z'),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Over Speed Alert',
    text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 10:00:00\n 118 kmph\n lat: 25.1234 lon: 55.2345',
    html: '<a href="https://maps.google.com/?q=25.1234,55.2345">Al Quoz Industrial Area 3, Dubai</a>',
  };

  const result = parser.parse(mail);
  assert.ok(result, 'Result should not be null');
  assert.ok(result.alertDef, 'Should contain alertDef');
  assert.ok(result.fields, 'Should contain fields');
  assert.ok(result.context, 'Should contain context');

  const ctx = result.context;
  assert.strictEqual(ctx.eventId, 'UID-101');
  assert.strictEqual(ctx.alertType, 'speeding');
  assert.strictEqual(ctx.alertLabel, 'Over Speed');
  assert.strictEqual(ctx.severity, 'HIGH');
  assert.strictEqual(ctx.source, 'system1');
  assert.strictEqual(ctx.vehicle.plate, 'D/31498');
  assert.strictEqual(ctx.vehicle.model, 'Toyota Hilux');
  assert.strictEqual(ctx.telemetry.speed, 118);
  assert.strictEqual(ctx.telemetry.speedLimit, 100);
  assert.strictEqual(ctx.telemetry.excessSpeed, 18);
  assert.strictEqual(ctx.location.address, 'Al Quoz Industrial Area 3, Dubai');
  assert.strictEqual(ctx.location.mapsUrl, 'https://maps.google.com/?q=25.1234,55.2345');
});

// ── Test 2: Track9999 Alert Parsing & EventContext ─────────────────────────
runTest('Test 2 — Track9999 Alert EventContext Generation', () => {
  const mail = {
    uid: 202,
    date: new Date('2026-09-01T12:00:00.000Z'),
    from: { value: [{ address: 'noreply@track9999.com' }] },
    subject: 'Tracker Event Notification[Distraction Alert(70.9km/h)][CC-48315]',
    text: 'Tracker Name: CC-48315\nEvent: Distraction Alert(70.9km/h)\nTime: 2026-09-01 12:00:00\nIMEI: 864201040123456\nPosition: http://track9999.com/pos?id=99',
    html: 'Position: <a href="http://track9999.com/pos?id=99">Click to View</a>',
  };

  const result = parser.parse(mail);
  assert.ok(result, 'Result should not be null');
  assert.ok(result.context, 'Should contain context');

  const ctx = result.context;
  assert.strictEqual(ctx.eventId, 'UID-202');
  assert.strictEqual(ctx.alertType, 'distraction');
  assert.strictEqual(ctx.source, 'track9999');
  assert.strictEqual(ctx.vehicle.plate, 'CC-48315');
  assert.strictEqual(ctx.vehicle.model, null);
  assert.strictEqual(ctx.vehicle.imei, '864201040123456');
  assert.strictEqual(ctx.telemetry.speed, 70.9);
  assert.strictEqual(ctx.telemetry.speedLimit, null);
  assert.strictEqual(ctx.location.trackUrl, 'http://track9999.com/pos?id=99');
});

// ── Test 3: Null Safety for Missing Optional Fields ─────────────────────────
runTest('Test 3 — Null Safety across Missing Fields', () => {
  const builder = new EventContextBuilder(null);
  const sparseResult = {
    alertDef: { type: 'unknown', label: 'Alert', severity: 'MEDIUM' },
    fields: { plate: 'XYZ-100', source: 'system1' },
  };

  const ctx = builder.build(sparseResult, null);
  assert.ok(ctx, 'Context should build without throwing');
  assert.strictEqual(ctx.vehicle.plate, 'XYZ-100');
  assert.strictEqual(ctx.vehicle.model, null);
  assert.strictEqual(ctx.vehicle.imei, null);
  assert.strictEqual(ctx.telemetry.speed, null);
  assert.strictEqual(ctx.telemetry.speedLimit, null);
  assert.strictEqual(ctx.telemetry.excessSpeed, null);
  assert.strictEqual(ctx.telemetry.idleTime, null);
  assert.strictEqual(ctx.location.address, null);
  assert.strictEqual(ctx.location.mapsUrl, null);
  assert.strictEqual(ctx.trip.ignitionState, 'UNKNOWN');
  assert.strictEqual(ctx.trip.active, null);
});

// ── Test 4: Ignition ON Context ──────────────────────────────────────────────
runTest('Test 4 — Ignition ON EventContext Representation', () => {
  const mail = {
    uid: 303,
    date: new Date('2026-09-01T14:00:00.000Z'),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Ignition ON Alert',
    text: 'Your P17584-Toyota Hilux ignition was turned on at JAFZA on 2026-09-01 14:00:00',
  };

  const result = parser.parse(mail);
  assert.ok(result);
  const ctx = result.context;
  assert.strictEqual(ctx.alertType, 'ignition_on');
  assert.strictEqual(ctx.vehicle.plate, 'P17584');
});

// ── Test 5: Ignition / Trip State Derivation ────────────────────────────────
runTest('Test 5 — Ignition & Trip State Derivation from HistoryStore', () => {
  mockHistory.onState['P17584'] = {
    time: '2026-09-01T14:00:00.000Z',
    address: 'JAFZA',
    mapsUrl: 'https://maps.google.com/...',
  };
  mockHistory.offState['P17584'] = '2026-09-01T10:00:00.000Z'; // Earlier than ON

  const mail = {
    uid: 404,
    date: new Date('2026-09-01T14:15:00.000Z'),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Over Speed Alert',
    text: 'Your P17584-Toyota Hilux is exceeding the speed limit 100 kmph on 2026-09-01 14:15:00\n 110 kmph',
  };

  const result = parser.parse(mail);
  const ctx = result.context;
  assert.strictEqual(ctx.trip.ignitionState, 'ON');
  assert.strictEqual(ctx.trip.active, true);
  assert.strictEqual(ctx.trip.lastIgnitionOnTime, '2026-09-01T14:00:00.000Z');
});

// ── Test 6: Non-Regression of Output Structure ──────────────────────────────
runTest('Test 6 — Non-Regression of Legacy alertDef and fields Contract', () => {
  const mail = {
    uid: 505,
    date: new Date(),
    from: { value: [{ address: 'alerts@yourtrackingsystem.com' }] },
    subject: 'Harsh Braking Alert',
    text: 'Your S23401-Toyota Hilux harsh braking on 2026-09-01 15:00:00',
  };

  const result = parser.parse(mail);
  assert.ok(result.alertDef, 'Legacy alertDef preserved');
  assert.ok(result.fields, 'Legacy fields preserved');
  assert.strictEqual(result.alertDef.type, 'harsh_braking');
  assert.strictEqual(result.fields.plate, 'S23401');
});

console.log('\n────────────────────────────────────────────────────────────');
console.log(`📊 TEST RESULTS: ${testsPassed} Passed | ${testsFailed} Failed`);
console.log('────────────────────────────────────────────────────────────\n');

if (testsFailed > 0) {
  process.exit(1);
}

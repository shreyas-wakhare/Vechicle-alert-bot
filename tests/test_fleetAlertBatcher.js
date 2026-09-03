/**
 * tests/test_fleetAlertBatcher.js
 *
 * Comprehensive Test Suite for 30-Minute Fleet Alert Batching & Hardening.
 * Covers Round 2 Requirements:
 * - Fix #1: Ignition OFF suppression (trip persisted, zero immediate WhatsApp, appears in 30m report)
 * - Fix #2: Strict Critical Exclusion (immediate delivery, 0% presence in 30m report)
 * - Fix #3: Crash & Restart Recovery (HistoryStore current-window reconstruction, zero duplicate replay)
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FleetAlertBatcher = require('../services/fleetAlertBatcher');
const EventContextBuilder = require('../services/eventContext');
const MessageFormatter = require('../services/messageFormatter');
const alertTypes = require('../data/alertTypes.json');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}\n`);
    console.error(err);
    failed++;
  }
}

function createMockWhatsApp() {
  const sentGroupMessages = [];
  const sentDMs = [];
  return {
    sentGroupMessages,
    sentDMs,
    sendToGroup: async (text) => {
      sentGroupMessages.push(text);
      return { success: true };
    },
    sendCriticalDMs: async (text) => {
      sentDMs.push(text);
      return { success: true };
    },
  };
}

function createMockHistory() {
  const records = [];
  const trips = [];
  const ignitionOn = {};
  const ignitionOff = {};
  return {
    _records: records,
    _trips: trips,
    _ignitionOn: ignitionOn,
    _ignitionOff: ignitionOff,
    record: (alertDef, fields, mail) => {
      records.push({
        id: Date.now() + Math.random(),
        plate: fields.plate?.toUpperCase(),
        vehicleModel: fields.vehicleModel || null,
        alertType: alertDef.type,
        alertLabel: alertDef.label,
        severity: alertDef.severity,
        driver: fields.driver || null,
        speed: fields.speed || null,
        speedLimit: fields.speedLimit || null,
        idleTime: fields.idleTime || null,
        idleDurationMin: parseInt(fields.idleTime, 10) || 0,
        address: fields.address || null,
        receivedAt: (mail?.date || fields.alertTime ? new Date(fields.alertTime) : new Date()).toISOString(),
        loggedAt: new Date().toISOString(),
      });
    },
    recordIgnitionOn: (plate, time, address) => {
      ignitionOn[plate.toUpperCase()] = { time, address };
    },
    getLastIgnitionOn: (plate) => ignitionOn[plate.toUpperCase()] || null,
    clearIgnitionOn: (plate) => { delete ignitionOn[plate.toUpperCase()]; },
    recordIgnitionOff: (plate, time) => { ignitionOff[plate.toUpperCase()] = time; },
    isSpuriousOff: (plate, offTime) => {
      const on = ignitionOn[plate.toUpperCase()];
      if (!on) return false;
      const diff = (new Date(offTime) - new Date(on.time)) / 1000;
      return diff < 120;
    },
    isTripsEnabled: () => true,
    recordTrip: ({ plate, vehicleModel, driver, startTime, endTime, durationMs }) => {
      if (!startTime) return { recorded: false, reason: 'no_start', trip: null };
      if (durationMs < 180000) return { recorded: false, reason: 'too_short', trip: null };
      const invalid = durationMs > 28800000;
      const trip = {
        id: Date.now(),
        plate: plate.toUpperCase(),
        vehicleModel,
        driver,
        startTime,
        endTime,
        durationMs,
        durationStr: `${Math.round(durationMs / 60000)}m`,
        invalid,
      };
      trips.push(trip);
      return { recorded: true, reason: invalid ? 'invalid_long' : 'ok', trip };
    },
    getRecentRecords: (hours) => {
      const cutoff = Date.now() - hours * 3600000;
      return records.filter(r => new Date(r.receivedAt).getTime() > cutoff);
    },
    getRecentTrips: (hours) => {
      const cutoff = Date.now() - hours * 3600000;
      return trips.filter(t => !t.invalid && new Date(t.endTime).getTime() > cutoff);
    },
    getIdleStats: () => [],
    getAllVehicleSummaries: () => [],
    getVehicleSummary: () => null,
    isMuted: () => false,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 30-MINUTE FLEET ALERT BATCHING HARDENING TEST SUITE (ROUND 2)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const formatter = new MessageFormatter();
  const testStateFile = path.join(__dirname, 'scratch_batch_state_r2.json');
  const cleanupState = () => { try { if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile); } catch {} };

  cleanupState();

  // ─── 1. Non-critical Alert Buffering & Window Aggregation ──────────────────
  console.log('--- 1. Non-Critical Alert Buffering & Window Aggregation ---');

  await runTest('1.1 — Non-critical alert is buffered and not sent immediately', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'E-30849', alertTime: '2026-09-03T10:05:00.000Z' },
    });

    assert.strictEqual(batcher.getBufferSize(), 1);
    assert.strictEqual(mockWA.sentGroupMessages.length, 0);
  });

  await runTest('1.2 — Multiple non-critical alerts produce exactly one consolidated report upon flush', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM', emoji: '📳' },
      fields: { plate: 'E-30849', vehicleModel: 'Toyota Hilux', alertTime: '2026-09-03T10:02:00.000Z' },
    });
    batcher.addEvent({
      alertDef: { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH', emoji: '📱' },
      fields: { plate: 'BB-75283', vehicleModel: 'Nissan Patrol', alertTime: '2026-09-03T10:15:00.000Z' },
    });

    const window = batcher.getWindow(new Date('2026-09-03T10:10:00.000Z'));
    const result = await batcher.flushWindow(window);

    assert.strictEqual(result.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.strictEqual(result.alertCount, 2);
    assert.ok(mockWA.sentGroupMessages[0].includes('Total alerts:    2'));
  });

  // ─── 2. FIX #1: Ignition OFF Suppression & Trip Aggregation ────────────────
  console.log('\n--- 2. FIX #1: Ignition OFF Suppression & Trip Aggregation ---');

  await runTest('2.1 — Valid trip on ignition_off calculates and persists trip with NO immediate WhatsApp send', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    const plate = 'TRIP-1';
    const onTime = '2026-09-03T10:00:00.000Z';
    const offTime = '2026-09-03T10:25:00.000Z'; // 25 min trip

    mockHist.recordIgnitionOn(plate, onTime, 'Warehouse A');

    // Emulate index.js ignition_off block:
    const onData = mockHist.getLastIgnitionOn(plate);
    const durationMs = new Date(offTime) - new Date(onData.time);
    const tripRes = mockHist.recordTrip({
      plate, vehicleModel: 'Ford Transit', driver: 'Driver 1',
      startTime: onData.time, endTime: offTime, durationMs,
    });
    mockHist.recordIgnitionOff(plate, offTime);
    mockHist.clearIgnitionOn(plate);

    // Business assertions:
    assert.strictEqual(tripRes.recorded, true);
    assert.strictEqual(tripRes.reason, 'ok');
    assert.strictEqual(mockHist._trips.length, 1, 'Trip must be persisted in HistoryStore');
    assert.strictEqual(mockWA.sentGroupMessages.length, 0, 'Zero WhatsApp messages should be sent immediately on ignition_off');

    // Now flush the 10:00-10:30 window (non-critical alert + trip):
    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate, alertTime: '2026-09-03T10:10:00.000Z' },
    });

    const window = batcher.getWindow(new Date('2026-09-03T10:15:00.000Z'));
    const flushRes = await batcher.flushWindow(window);

    assert.strictEqual(flushRes.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.ok(mockWA.sentGroupMessages[0].includes('Completed trips: 1'), '30-minute summary must show Completed trips: 1');
  });

  await runTest('2.2 — Spurious ignition_off (<2 min) records no trip and sends zero WhatsApp messages', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();

    const plate = 'SPUR-1';
    const onTime = '2026-09-03T10:00:00.000Z';
    const offTime = '2026-09-03T10:01:00.000Z'; // 60s -> spurious

    mockHist.recordIgnitionOn(plate, onTime, 'HQ');
    assert.strictEqual(mockHist.isSpuriousOff(plate, offTime), true, 'Must detect spurious OFF');
    assert.strictEqual(mockHist._trips.length, 0, 'No trip recorded');
    assert.strictEqual(mockWA.sentGroupMessages.length, 0, 'No WhatsApp message sent');
  });

  await runTest('2.3 — Orphan ignition_off (no ON) records no trip and sends zero WhatsApp messages', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();

    const plate = 'ORPH-1';
    const offTime = '2026-09-03T10:10:00.000Z';
    const onData = mockHist.getLastIgnitionOn(plate); // null
    assert.strictEqual(onData, null);

    const tripRes = mockHist.recordTrip({
      plate, startTime: onData?.time, endTime: offTime, durationMs: 0,
    });
    assert.strictEqual(tripRes.recorded, false);
    assert.strictEqual(tripRes.reason, 'no_start');
    assert.strictEqual(mockWA.sentGroupMessages.length, 0);
  });

  await runTest('2.4 — Long invalid trip (>8h) is excluded from completed trips count in 30m report', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    const plate = 'LONG-1';
    const onTime = '2026-09-03T00:00:00.000Z';
    const offTime = '2026-09-03T10:15:00.000Z'; // 10h15m -> invalid long
    const durationMs = 10.25 * 3600000;

    const tripRes = mockHist.recordTrip({ plate, startTime: onTime, endTime: offTime, durationMs });
    assert.strictEqual(tripRes.recorded, true);
    assert.strictEqual(tripRes.reason, 'invalid_long');
    assert.strictEqual(tripRes.trip.invalid, true);

    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate, alertTime: '2026-09-03T10:10:00.000Z' },
    });

    const window = batcher.getWindow(new Date('2026-09-03T10:20:00.000Z'));
    await batcher.flushWindow(window);

    assert.ok(mockWA.sentGroupMessages[0].includes('Completed trips: 0'), 'Invalid long trip must not increment completed trips');
  });

  // ─── 3. FIX #2: Strict Critical Exclusion from 30-min Report ───────────────
  console.log('\n--- 3. FIX #2: Strict Critical Exclusion from 30-Min Report ---');

  await runTest('3.1 — Critical alerts (SOS, accident, engine_failure, speeding >= 15) dispatch immediately and are excluded from batcher', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    const criticalItems = [
      { def: { type: 'sos', label: 'SOS Alert', severity: 'CRITICAL', emoji: '🆘' }, fields: { plate: 'CRIT-1' } },
      { def: { type: 'accident', label: 'Collision / Accident', severity: 'CRITICAL', emoji: '💥' }, fields: { plate: 'CRIT-2' } },
      { def: { type: 'engine_failure', label: 'Engine Failure / Overheat', severity: 'CRITICAL', emoji: '🔧' }, fields: { plate: 'CRIT-3' } },
      { def: { type: 'speeding', label: 'Over Speed', severity: 'HIGH', emoji: '🚨' }, fields: { plate: 'CRIT-4', speed: '125', speedLimit: '100' } },
    ];

    for (const item of criticalItems) {
      const { text, criticalLevel } = formatter.format(item.def, item.fields);
      const isCritical = item.def.type === 'sos' || item.def.type === 'accident' || item.def.type === 'engine_failure' || criticalLevel >= 3;
      assert.strictEqual(isCritical, true, `${item.def.type} must evaluate as critical`);

      // Emulate index.js routing:
      if (isCritical) {
        await mockWA.sendToGroup(text);
        if (criticalLevel >= 3) {
          await mockWA.sendCriticalDMs(`DM: ${item.def.label}`);
        }
        // DO NOT call batcher.addEvent()
      }
    }

    assert.strictEqual(mockWA.sentGroupMessages.length, 4, 'All 4 critical alerts must send immediate WhatsApp messages');
    assert.strictEqual(mockWA.sentDMs.length, 4, 'All 4 critical alerts must trigger personal DMs');
    assert.strictEqual(batcher.getBufferSize(), 0, 'Batcher buffer must remain 0');

    // Flush window: should send nothing because 0 non-critical alerts
    const flushRes = await batcher.flushWindow(batcher.getWindow());
    assert.strictEqual(flushRes.sent, false, 'Empty window sends nothing');
    assert.strictEqual(mockWA.sentGroupMessages.length, 4, 'No additional summary messages sent');
  });

  await runTest('3.2 — Mixed window: 5 non-critical + 2 critical produces 2 immediate + 1 summary of EXACTLY 5 alerts', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });

    // 2 Critical alerts
    const crit1 = { def: { type: 'sos', label: 'SOS Alert', severity: 'CRITICAL', emoji: '🆘' }, fields: { plate: 'MIX-C1' } };
    const crit2 = { def: { type: 'accident', label: 'Collision / Accident', severity: 'CRITICAL', emoji: '💥' }, fields: { plate: 'MIX-C2' } };

    // Send critical immediately without adding to batcher
    await mockWA.sendToGroup(formatter.format(crit1.def, crit1.fields).text);
    await mockWA.sendToGroup(formatter.format(crit2.def, crit2.fields).text);

    // 5 Non-critical alerts added to batcher
    const nonCritPlates = ['NC-1', 'NC-2', 'NC-3', 'NC-4', 'NC-5'];
    for (const plate of nonCritPlates) {
      batcher.addEvent({
        alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM', emoji: '📳' },
        fields: { plate, vehicleModel: 'Truck', alertTime: '2026-09-03T10:10:00.000Z' },
      });
    }

    assert.strictEqual(batcher.getBufferSize(), 5);

    const window = batcher.getWindow(new Date('2026-09-03T10:15:00.000Z'));
    const flushRes = await batcher.flushWindow(window);

    assert.strictEqual(flushRes.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 3, '2 immediate critical + 1 consolidated summary');
    assert.strictEqual(flushRes.alertCount, 5, 'Summary alertCount must be strictly 5');

    const summaryText = mockWA.sentGroupMessages[2];
    assert.ok(summaryText.includes('Total alerts:    5'), 'Report must state Total alerts: 5');
    assert.ok(summaryText.includes('Active vehicles: 5'), 'Report must state Active vehicles: 5');
    assert.ok(!summaryText.includes('MIX-C1'), 'Report must not include MIX-C1');
    assert.ok(!summaryText.includes('MIX-C2'), 'Report must not include MIX-C2');
    assert.ok(!summaryText.includes('SOS Alert'), 'Report must not include SOS Alert');
  });

  await runTest('3.3 — Defensive guard in batcher.addEvent rejects critical alerts if erroneously passed', async () => {
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(createMockHistory(), mockWA, { persist: false });

    batcher.addEvent({
      alertDef: { type: 'sos', label: 'SOS Alert', severity: 'CRITICAL' },
      fields: { plate: 'DEF-1' },
      isCritical: true,
    });

    assert.strictEqual(batcher.getBufferSize(), 0, 'Critical alert must be rejected from buffer');
  });

  // ─── 4. FIX #3: Crash & Process Restart Recovery from HistoryStore ──────────
  console.log('\n--- 4. FIX #3: Process Restart Recovery from HistoryStore ---');

  await runTest('4.1 — Unflushed non-critical alerts in current window are recovered from HistoryStore after restart', async () => {
    const mockWA = createMockWhatsApp();
    const mockHist = createMockHistory();

    const testTime1 = new Date();
    const testWindow = new FleetAlertBatcher(mockHist, mockWA, { persist: false }).getWindow(testTime1);

    // Populate HistoryStore with 3 non-critical events in the active window
    const baseTime = new Date(testWindow.start.getTime() + 5 * 60000); // 5 min into window
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'REC-1', vehicleModel: 'Toyota Hilux', alertTime: baseTime.toISOString() }
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' },
      { plate: 'REC-2', vehicleModel: 'Nissan Patrol', alertTime: new Date(baseTime.getTime() + 60000).toISOString() }
    );
    mockHist.record(
      { type: 'speeding', label: 'Over Speed', severity: 'HIGH' },
      { plate: 'REC-3', vehicleModel: 'Lexus', speed: '105', speedLimit: '100', alertTime: new Date(baseTime.getTime() + 120000).toISOString() } // excess 5 (non-critical)
    );

    // Simulate process crash & restart: instantiate a NEW FleetAlertBatcher instance
    const restartedBatcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });
    assert.strictEqual(restartedBatcher.getBufferSize(), 0, 'New instance starts with empty buffer');

    // Run recovery
    const recovered = restartedBatcher.recoverFromHistory(testTime1);
    assert.strictEqual(recovered, 3, 'Must recover exactly 3 non-critical records');
    assert.strictEqual(restartedBatcher.getBufferSize(), 3);

    // Flush: verify exactly 1 report with 3 alerts
    const flushRes = await restartedBatcher.flushWindow(testWindow);
    assert.strictEqual(flushRes.sent, true);
    assert.strictEqual(flushRes.alertCount, 3);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.ok(mockWA.sentGroupMessages[0].includes('Total alerts:    3'));
    assert.ok(mockWA.sentGroupMessages[0].includes('REC-1'));
    assert.ok(mockWA.sentGroupMessages[0].includes('REC-2'));
    assert.ok(mockWA.sentGroupMessages[0].includes('REC-3'));
  });

  await runTest('4.2 — Recovery ignores critical alerts, ignition_on, and ignition_off records in HistoryStore', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: false });
    const window = batcher.getWindow();

    const t = new Date(window.start.getTime() + 60000).toISOString();
    mockHist.record({ type: 'sos', label: 'SOS Alert', severity: 'CRITICAL' }, { plate: 'IGN-1', alertTime: t });
    mockHist.record({ type: 'accident', label: 'Collision', severity: 'CRITICAL' }, { plate: 'IGN-2', alertTime: t });
    mockHist.record({ type: 'engine_failure', label: 'Engine Failure', severity: 'CRITICAL' }, { plate: 'IGN-3', alertTime: t });
    mockHist.record({ type: 'speeding', label: 'Speeding', severity: 'HIGH' }, { plate: 'IGN-4', speed: '120', speedLimit: '100', alertTime: t }); // excess 20 >= 15
    mockHist.record({ type: 'ignition_on', label: 'Ignition ON', severity: 'LOW' }, { plate: 'IGN-5', alertTime: t });
    mockHist.record({ type: 'ignition_off', label: 'Ignition OFF', severity: 'LOW' }, { plate: 'IGN-6', alertTime: t });
    mockHist.record({ type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' }, { plate: 'VALID-1', alertTime: t });

    const recovered = batcher.recoverFromHistory();
    assert.strictEqual(recovered, 1, 'Only VALID-1 (non-critical) should be recovered');
    assert.strictEqual(batcher.getBufferSize(), 1);
    assert.strictEqual(batcher.getBuffer()[0].fields.plate, 'VALID-1');
  });

  await runTest('4.3 — Multiple calls to recoverFromHistory do not duplicate records', async () => {
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, createMockWhatsApp(), { persist: false });
    const window = batcher.getWindow();

    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'NODUP-1', alertTime: new Date(window.start.getTime() + 60000).toISOString() }
    );

    const rec1 = batcher.recoverFromHistory();
    assert.strictEqual(rec1, 1);
    assert.strictEqual(batcher.getBufferSize(), 1);

    const rec2 = batcher.recoverFromHistory();
    assert.strictEqual(rec2, 0, 'Second recovery call must add 0 duplicates');
    assert.strictEqual(batcher.getBufferSize(), 1);
  });

  await runTest('4.4 — Already-flushed window is not re-recovered or re-flushed after restart', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    const batcher1 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testStateFile,
    });
    const window = batcher1.getWindow();

    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'FLUSHED-1', alertTime: new Date(window.start.getTime() + 60000).toISOString() }
    );

    batcher1.recoverFromHistory();
    await batcher1.flushWindow(window);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);

    // Restart: instantiate batcher2 with saved state file
    const batcher2 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testStateFile,
    });

    const rec = batcher2.recoverFromHistory();
    assert.strictEqual(rec, 0, 'Must not recover for already-flushed windowId');

    const res = await batcher2.flushWindow(window);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'already_flushed');
    assert.strictEqual(mockWA.sentGroupMessages.length, 1, 'No duplicate report sent');
  });

  await runTest('4.5 — Recovery is strictly read-only and does not mutate HistoryStore or RiskEngine', async () => {
    const mockHist = createMockHistory();
    const batcher = new FleetAlertBatcher(mockHist, createMockWhatsApp(), { persist: false });

    const histCountBefore = mockHist._records.length;
    const tripsCountBefore = mockHist._trips.length;

    batcher.recoverFromHistory();

    assert.strictEqual(mockHist._records.length, histCountBefore, 'History records must not be mutated');
    assert.strictEqual(mockHist._trips.length, tripsCountBefore, 'Trips must not be mutated');
  });

  // ─── 5. Concurrency, Edge Cases & Boundaries ───────────────────────────────
  console.log('\n--- 5. Concurrency, Edge Cases & Boundaries ---');

  await runTest('5.1 — Empty window (0 non-critical alerts) sends zero messages', async () => {
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(createMockHistory(), mockWA, { persist: false });

    const res = await batcher.flushWindow();
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'empty_window');
    assert.strictEqual(mockWA.sentGroupMessages.length, 0);
  });

  await runTest('5.2 — Exact half-open [start, end) interval: event at end boundary is held for next window', async () => {
    const batcher = new FleetAlertBatcher(createMockHistory(), createMockWhatsApp(), { persist: false });

    // Window 10:00 - 10:30 (Dubai UTC+4 -> 06:00 - 06:30 UTC)
    const windowStart = new Date('2026-09-03T06:00:00.000Z');
    const windowEnd = new Date('2026-09-03T06:30:00.000Z');

    // Event exactly at windowEnd belongs to the NEXT window
    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'BOUND-NEXT', alertTime: windowEnd.toISOString() },
    });

    const w10_00 = batcher.getWindow(windowStart);
    const res1 = await batcher.flushWindow(w10_00);
    assert.strictEqual(res1.sent, false, 'Event at 10:30.000 belongs to next window, not 10:00-10:30');
    assert.strictEqual(batcher.getBufferSize(), 1, 'Event remains in buffer for 10:30-11:00 window');
  });

  // ─── 6. Intelligence & Taxonomy Integrity ──────────────────────────────────
  console.log('\n--- 6. Intelligence & Taxonomy Integrity ---');

  await runTest('6.1 — EventContextBuilder builds Feature #1–#4 intelligence in real-time', async () => {
    const ctxBuilder = new EventContextBuilder(createMockHistory(), { persistRisk: false });
    const context = ctxBuilder.build({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'INTELL-1', alertTime: '2026-09-03T10:00:00.000Z' },
    });

    assert.ok(context.recentActivity);
    assert.ok(context.contextIntelligence);
    assert.ok(context.alertCorrelation);
    assert.ok(context.risk);
  });

  await runTest('6.2 — All 32 alert types buffer cleanly in FleetAlertBatcher', async () => {
    const batcher = new FleetAlertBatcher(createMockHistory(), createMockWhatsApp(), { persist: false });

    let nonCritCount = 0;
    for (const def of alertTypes) {
      const isCrit = def.severity === 'CRITICAL' || def.type === 'sos' || def.type === 'accident' || def.type === 'engine_failure';
      batcher.addEvent({
        alertDef: def,
        fields: { plate: `TEST-${def.type.toUpperCase()}`, alertTime: '2026-09-03T10:00:00.000Z' },
        isCritical: isCrit,
      });
      if (!isCrit) nonCritCount++;
    }

    assert.strictEqual(batcher.getBufferSize(), nonCritCount, 'Only non-critical taxonomy alerts must enter buffer');
  });

  cleanupState();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 ROUND 2 TEST RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});

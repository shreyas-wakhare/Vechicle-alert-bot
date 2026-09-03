/**
 * tests/test_batteryDepletionBatching.js
 *
 * Comprehensive Test Suite for Battery / Inactivity State-Based Reporting:
 * 1. Initial >=24h inactivity triggers exactly one warning.
 * 2. Persistent inactivity across multiple checks / flushes remains SILENT (zero repeated reports).
 * 3. Ignition activity resets state to ACTIVE without external WhatsApp spam.
 * 4. Subsequent >=24h inactivity creates a new episode and reports once again.
 * 5. State survives server restart (already-reported episode remains silent).
 * 6. Crash recovery: unreported state survives restart and is eventually reported once.
 * 7. Window boundary [start, end) holds future battery warnings for the next window.
 * 8. Multiple vehicles maintain independent state.
 * 9. Elimination of individual WhatsApp messages (zero spam).
 * 10. Critical alert isolation (immediate WhatsApp + DMs remain untouched).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BatteryMonitor = require('../services/batteryMonitor');
const FleetAlertBatcher = require('../services/fleetAlertBatcher');

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
  const activityMap = new Map(); // plate -> timestamp ms

  return {
    _records: records,
    _trips: trips,
    _activityMap: activityMap,
    setVehicleActivity: (plate, timestampMs) => {
      activityMap.set(plate.toUpperCase(), timestampMs);
    },
    allPlates: () => Array.from(activityMap.keys()),
    lastIgnitionActivity: (plate) => activityMap.get(plate.toUpperCase()) || 0,
    record: (alertDef, fields, mail) => {
      const rec = {
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
        receivedAt: (fields.alertTime ? new Date(fields.alertTime) : (mail?.date || new Date())).toISOString(),
        loggedAt: new Date().toISOString(),
      };
      records.push(rec);
      return rec;
    },
    getRecentRecords: (hours) => {
      const cutoff = Date.now() - hours * 3600000;
      return records.filter(r => new Date(r.receivedAt).getTime() > cutoff);
    },
    getRecentTrips: (hours) => {
      const cutoff = Date.now() - hours * 3600000;
      return trips.filter(t => !t.invalid && new Date(t.endTime).getTime() > cutoff);
    },
    getAllVehicleSummaries: () => [],
    getVehicleSummary: () => null,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 BATTERY / INACTIVITY STATE-BASED REPORTING TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const testBatchStateFile = path.join(__dirname, 'scratch_batch_state_battery_lifecycle.json');
  const testBatteryStateFile = path.join(__dirname, 'scratch_battery_state_lifecycle.json');

  const cleanup = () => {
    try { if (fs.existsSync(testBatchStateFile)) fs.unlinkSync(testBatchStateFile); } catch {}
    try { if (fs.existsSync(testBatteryStateFile)) fs.unlinkSync(testBatteryStateFile); } catch {}
  };
  cleanup();

  // ─── 1. State-Based Inactivity Lifecycle & Silent Continuous Inactivity ───
  console.log('--- 1. State-Based Lifecycle & Zero Repeated Reports While Inactive ---');

  await runTest('1.1 — ACTIVE -> 24h INACTIVE -> Reported ONCE in Fleet Summary -> Silent across subsequent checks', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const monitor = new BatteryMonitor(mockHist, mockWA, {
      batcher,
      stateFile: testBatteryStateFile,
    });
    batcher.setBatteryMonitor(monitor);

    const now = Date.now();
    // Monday 10:00: Last activity was 25 hours ago (>24h)
    mockHist.setVehicleActivity('ABC123', now - 25 * 3600000);

    // Tuesday 10:00: Check runs
    await monitor._check();

    // Zero individual WhatsApp messages
    assert.strictEqual(mockWA.sentGroupMessages.length, 0);

    // One warning queued
    assert.strictEqual(batcher.getBatteryWarnings().length, 1);
    const vState1 = monitor.getVehicleState('ABC123');
    assert.strictEqual(vState1.status, 'INACTIVE_RISK');
    assert.strictEqual(vState1.reported, false);

    // Tuesday 10:30: 30-min Fleet Alert Summary flushes
    const window1 = batcher.getWindow(new Date(now));
    const res1 = await batcher.flushWindow(window1);
    assert.strictEqual(res1.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.ok(mockWA.sentGroupMessages[0].includes('🔋 *BATTERY DEPLETION / INACTIVITY*'));
    assert.ok(mockWA.sentGroupMessages[0].includes('ABC123 — 25h inactive'));

    // State is marked reported: true and persisted
    const vStateAfterFlush = monitor.getVehicleState('ABC123');
    assert.strictEqual(vStateAfterFlush.reported, true);

    // Tuesday 11:00, 11:30, 18:00: Vehicle remains inactive (same last activity)
    // Run multiple checks
    await monitor._check();
    await monitor._check();

    // Must be SILENT — zero new warnings queued
    assert.strictEqual(batcher.getBatteryWarnings().length, 0, 'Must NOT re-queue warning while continuously inactive');

    // Next 30-min window flushes (empty window check skips or normal driving alert without battery)
    const window2 = batcher.getWindow(new Date(now + 1800000));
    const res2 = await batcher.flushWindow(window2);
    assert.strictEqual(res2.sent, false, 'Should not send empty window since no alerts and no battery warnings');
    assert.strictEqual(mockWA.sentGroupMessages.length, 1, 'Total messages must remain 1 (no repeated battery summary)');
  });

  // ─── 2. Activity Reset & New Inactivity Episode ───────────────────────────
  console.log('\n--- 2. Activity Reset & New Inactivity Episode ---');

  await runTest('2.1 — Activity resets state to ACTIVE without spam; subsequent 24h inactivity reports once again', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const monitor = new BatteryMonitor(mockHist, mockWA, {
      batcher,
      stateFile: testBatteryStateFile,
    });
    batcher.setBatteryMonitor(monitor);

    let t = Date.now();
    // 1. Initial 25h inactivity
    mockHist.setVehicleActivity('XYZ789', t - 25 * 3600000);
    await monitor._check(t);
    await batcher.flushWindow(batcher.getWindow(new Date(t)));
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.strictEqual(monitor.getVehicleState('XYZ789').reported, true);

    // 2. Wednesday 08:00: Driver turns ignition ON (activity recorded 1 hour ago)
    t += 24 * 3600000;
    mockHist.setVehicleActivity('XYZ789', t - 1 * 3600000);

    // Battery check runs
    await monitor._check(t);

    // State transitioned to ACTIVE, reported reset to false
    const vStateActive = monitor.getVehicleState('XYZ789');
    assert.strictEqual(vStateActive.status, 'ACTIVE');
    assert.strictEqual(vStateActive.reported, false);
    // Zero "resolved" WhatsApp messages sent!
    assert.strictEqual(mockWA.sentGroupMessages.length, 1, 'Must NOT send a WhatsApp message when vehicle becomes active');

    // 3. Friday 09:00: Vehicle parked again and crosses 30h of inactivity
    t += 30 * 3600000; // 31 hours after the drive
    await monitor._check(t);

    // New episode detected! Warning queued
    const vStateNew = monitor.getVehicleState('XYZ789');
    assert.strictEqual(vStateNew.status, 'INACTIVE_RISK');
    assert.strictEqual(vStateNew.reported, false);
    assert.strictEqual(batcher.getBatteryWarnings().length, 1);

    // Flushes in next summary
    const res = await batcher.flushWindow(batcher.getWindow(new Date(t)));
    assert.strictEqual(res.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 2);
    assert.ok(mockWA.sentGroupMessages[1].includes('XYZ789 — 31h inactive'));
    assert.strictEqual(monitor.getVehicleState('XYZ789').reported, true);
  });

  // ─── 3. Persistence Across Restart & Crash Recovery ───────────────────────
  console.log('\n--- 3. Persistence Across Restart & Crash Recovery ---');

  await runTest('3.1 — Already-reported inactivity episode survives server restart and remains silent', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // Process 1: detect and flush
    const batcher1 = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor1 = new BatteryMonitor(mockHist, mockWA, { batcher: batcher1, stateFile: testBatteryStateFile });
    batcher1.setBatteryMonitor(monitor1);

    const now = Date.now();
    mockHist.setVehicleActivity('SRV-01', now - 35 * 3600000);
    await monitor1._check();
    await batcher1.flushWindow(batcher1.getWindow(new Date(now)));
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);

    // Simulate Server Restart: new instances loading from persisted state files
    const batcher2 = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor2 = new BatteryMonitor(mockHist, mockWA, { batcher: batcher2, stateFile: testBatteryStateFile });
    batcher2.setBatteryMonitor(monitor2);

    // Run check after restart
    await monitor2._check();

    // Must NOT re-queue
    assert.strictEqual(batcher2.getBatteryWarnings().length, 0);

    // Flush after restart must NOT send duplicate summary
    const res = await batcher2.flushWindow(batcher2.getWindow(new Date(now + 1800000)));
    assert.strictEqual(res.sent, false);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
  });

  await runTest('3.2 — Crash before window flush: unreported episode survives restart and is reported in next window', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // Process 1: detect warning but process crashes before flush!
    const batcher1 = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor1 = new BatteryMonitor(mockHist, mockWA, { batcher: batcher1, stateFile: testBatteryStateFile });
    batcher1.setBatteryMonitor(monitor1);

    const now = Date.now();
    mockHist.setVehicleActivity('CRASH-01', now - 28 * 3600000);
    await monitor1._check();
    assert.strictEqual(monitor1.getVehicleState('CRASH-01').reported, false);
    // Crash happens: batcher1 never flushes!

    // Process 2: Server restarts
    const batcher2 = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor2 = new BatteryMonitor(mockHist, mockWA, { batcher: batcher2, stateFile: testBatteryStateFile });
    batcher2.setBatteryMonitor(monitor2);

    // Check runs after restart
    await monitor2._check();

    // Warning was pending, so it is queued
    assert.strictEqual(batcher2.getBatteryWarnings().length, 1);

    // Window flushes cleanly
    const res = await batcher2.flushWindow(batcher2.getWindow(new Date(now)));
    assert.strictEqual(res.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.ok(mockWA.sentGroupMessages[0].includes('CRASH-01'));

    // Now marked reported: true
    assert.strictEqual(monitor2.getVehicleState('CRASH-01').reported, true);
  });

  // ─── 4. Window Boundary [start, end) ───────────────────────────────────────
  console.log('\n--- 4. Window Boundary [start, end) ---');

  await runTest('4.1 — Battery warning arriving at or after window.end is held for subsequent window', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor = new BatteryMonitor(mockHist, mockWA, { batcher, stateFile: testBatteryStateFile });
    batcher.setBatteryMonitor(monitor);

    const window = batcher.getWindow(new Date('2026-09-03T10:15:00.000Z')); // [10:00, 10:30)

    // Warning 1: detected at 10:10 (within window)
    batcher.addBatteryWarning({
      plate: 'WIN-EARLY',
      inactiveHours: 30,
      detectedAt: new Date('2026-09-03T10:10:00.000Z').getTime(),
    });

    // Warning 2: detected at 10:30 (exactly at window.end -> belongs to next window)
    batcher.addBatteryWarning({
      plate: 'WIN-NEXT',
      inactiveHours: 40,
      detectedAt: new Date('2026-09-03T10:30:00.000Z').getTime(),
    });

    // Flush window [10:00, 10:30)
    const res = await batcher.flushWindow(window);
    assert.strictEqual(res.sent, true);
    const msg = mockWA.sentGroupMessages[0];
    assert.ok(msg.includes('WIN-EARLY'));
    assert.ok(!msg.includes('WIN-NEXT'), 'WIN-NEXT must NOT be included in [10:00, 10:30) window');

    // WIN-NEXT remains in batcher buffer for next window [10:30, 11:00)
    assert.strictEqual(batcher.getBatteryWarnings().length, 1);
    assert.strictEqual(batcher.getBatteryWarnings()[0].plate, 'WIN-NEXT');

    // Flush next window
    const nextWindow = batcher.getWindow(new Date('2026-09-03T10:45:00.000Z'));
    const resNext = await batcher.flushWindow(nextWindow);
    assert.strictEqual(resNext.sent, true);
    assert.ok(mockWA.sentGroupMessages[1].includes('WIN-NEXT'));
  });

  // ─── 5. Multiple Vehicles Independence & Critical Isolation ───────────────
  console.log('\n--- 5. Multiple Vehicles Independence & Critical Isolation ---');

  await runTest('5.1 — Multiple vehicles have independent states, and critical alerts remain immediate', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(mockHist, mockWA, { persist: true, stateFile: testBatchStateFile });
    const monitor = new BatteryMonitor(mockHist, mockWA, { batcher, stateFile: testBatteryStateFile });
    batcher.setBatteryMonitor(monitor);

    const now = Date.now();
    // VEH-A is inactive 30h
    mockHist.setVehicleActivity('VEH-A', now - 30 * 3600000);
    // VEH-B is active (activity 2h ago)
    mockHist.setVehicleActivity('VEH-B', now - 2 * 3600000);
    // VEH-C is inactive 50h
    mockHist.setVehicleActivity('VEH-C', now - 50 * 3600000);

    await monitor._check();

    assert.strictEqual(monitor.getVehicleState('VEH-A').status, 'INACTIVE_RISK');
    assert.strictEqual(monitor.getVehicleState('VEH-B'), null);
    assert.strictEqual(monitor.getVehicleState('VEH-C').status, 'INACTIVE_RISK');

    // Immediate critical alert arrives for VEH-B
    await mockWA.sendToGroup('🚨 IMMEDIATE CRITICAL: VEH-B Accident');
    await mockWA.sendCriticalDMs('🚨 CRITICAL DM: VEH-B');
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.strictEqual(mockWA.sentDMs.length, 1);

    // Fleet Summary flushes
    await batcher.flushWindow(batcher.getWindow(new Date(now)));
    assert.strictEqual(mockWA.sentGroupMessages.length, 2);

    const summaryMsg = mockWA.sentGroupMessages[1];
    assert.ok(summaryMsg.includes('VEH-A — 30h inactive'));
    assert.ok(summaryMsg.includes('VEH-C — 50h inactive'));
    assert.ok(!summaryMsg.includes('VEH-B —'), 'Active vehicle must not appear in battery section');
  });

  // ─── 6. Meaningful Activity Calculation & Plate Normalization ─────────────
  console.log('\n--- 6. Meaningful Activity Calculation & Plate Normalization ---');

  await runTest('6.1 — Vehicle with old ignition trip but recent speeding uses speeding as lastActivityAt', async () => {
    cleanup();
    const HistoryStore = require('../services/historyStore');
    const h = new HistoryStore({ historyFile: ':memory:', tripsFile: ':memory:', stateFile: ':memory:', persist: false });

    const now = Date.now();
    const oldTripEnd = now - 87 * 24 * 3600000; // 87 days ago (June 8)
    const recentSpeeding = now - 23 * 3600000;  // 23 hours ago (September 2)

    // Add old trip
    h._trips.push({
      id: 1, plate: 'D/31498', startTime: new Date(oldTripEnd - 3600000).toISOString(),
      endTime: new Date(oldTripEnd).toISOString(), durationMs: 3600000, invalid: false,
    });

    // Add recent speeding record in history
    h._records.push({
      id: 2, plate: 'D/31498', alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH',
      receivedAt: new Date(recentSpeeding).toISOString(),
    });

    const act = h.lastIgnitionActivity('D/31498');
    assert.strictEqual(act, recentSpeeding, 'Must select the recent speeding alert, not the 87-day old trip');

    const diffH = Math.round((now - act) / 3600000);
    assert.strictEqual(diffH, 23, 'Inactivity must be ~23h, NOT ~2088h');
  });

  await runTest('6.2 — Vehicle with recent vibration alert is treated as active (<24h)', async () => {
    cleanup();
    const HistoryStore = require('../services/historyStore');
    const h = new HistoryStore({ historyFile: ':memory:', tripsFile: ':memory:', stateFile: ':memory:', persist: false });

    const now = Date.now();
    const oldTripEnd = now - 50 * 24 * 3600000; // 50 days ago (mid-July)
    const recentVibration = now - 6 * 3600000;   // 6 hours ago

    h._trips.push({
      id: 10, plate: 'AA50982', startTime: new Date(oldTripEnd - 3600000).toISOString(),
      endTime: new Date(oldTripEnd).toISOString(), durationMs: 3600000, invalid: false,
    });

    h._records.push({
      id: 11, plate: 'AA-50982', alertType: 'vibration', alertLabel: 'Vibration Alert', severity: 'MEDIUM',
      receivedAt: new Date(recentVibration).toISOString(),
    });

    // Both hyphenated and non-hyphenated query must yield the recent vibration
    const act1 = h.lastIgnitionActivity('AA50982');
    const act2 = h.lastIgnitionActivity('AA-50982');
    assert.strictEqual(act1, recentVibration);
    assert.strictEqual(act2, recentVibration);

    // BatteryMonitor test with this history
    const mockWA = createMockWhatsApp();
    const batcher = new FleetAlertBatcher(h, mockWA, { persist: false });
    const monitor = new BatteryMonitor(h, mockWA, { batcher, stateFile: testBatteryStateFile });
    batcher.setBatteryMonitor(monitor);

    await monitor._check(now);
    assert.strictEqual(monitor.getVehicleState('AA50982'), null, 'Vehicle with recent vibration must remain ACTIVE (<24h)');
  });

  await runTest('6.3 — Plate normalization: AA50982, AA-50982, AA/50982, AA 50982 resolve identically and allPlates de-duplicates', async () => {
    cleanup();
    const HistoryStore = require('../services/historyStore');
    const h = new HistoryStore({ historyFile: ':memory:', tripsFile: ':memory:', stateFile: ':memory:', persist: false });

    const t = Date.now() - 10 * 3600000;
    h._records.push({ id: 1, plate: 'AA-50982', alertType: 'speeding', receivedAt: new Date(t).toISOString() });
    h._records.push({ id: 2, plate: 'AA50982', alertType: 'distraction', receivedAt: new Date(t).toISOString() });
    h._trips.push({ id: 3, plate: 'AA/50982', startTime: new Date(t).toISOString(), endTime: new Date(t).toISOString() });

    const plates = h.allPlates();
    assert.strictEqual(plates.length, 1, 'allPlates must de-duplicate variants of the same plate');

    assert.strictEqual(h.lastIgnitionActivity('AA-50982'), t);
    assert.strictEqual(h.lastIgnitionActivity('AA50982'), t);
    assert.strictEqual(h.lastIgnitionActivity('AA/50982'), t);
    assert.strictEqual(h.lastIgnitionActivity('AA 50982'), t);
  });

  await runTest('6.4 — Real repository data sanity: D/31498 lastActivity reflects September 2 speeding', async () => {
    const HistoryStore = require('../services/historyStore');
    const h = new HistoryStore(); // loads actual data/history.json and data/trips.json
    const act = h.lastIgnitionActivity('D/31498');
    const iso = new Date(act).toISOString();

    assert.ok(iso.startsWith('2026-09-02'), `D/31498 last activity must be in September 2026, got: ${iso}`);
    const diffH = (Date.now() - act) / 3600000;
    assert.ok(diffH < 30, `Inactivity must be around ~23-24h, got: ${diffH.toFixed(1)}h`);
  });

  cleanup();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 BATTERY LIFECYCLE TEST RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled test runner error:', err);
  process.exit(1);
});

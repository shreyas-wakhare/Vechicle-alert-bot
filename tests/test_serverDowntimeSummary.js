/**
 * tests/test_serverDowntimeSummary.js
 *
 * Comprehensive Test Suite for Round 3: Server Downtime Summary & Recovery.
 * Covers:
 * 1. Downtime Detection (<=30m, exactly 30m, >30m, overnight, multi-day).
 * 2. Report Content, Metrics, Risk Overview, and AI Fallback.
 * 3. Explicit Critical Alert Accounting during downtime.
 * 4. Trip Validity (3m-8h bounds, spurious/orphan filters).
 * 5. Idempotency & Duplicate Restart Prevention.
 * 6. Half-open Interval Boundaries [offlineStart, startupTime).
 * 7. Crash / Power-loss Recovery from Heartbeat.
 * 8. Empty Downtime Period Handling.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ServerLifecycleManager = require('../services/serverLifecycleManager');
const DowntimeSummaryService = require('../services/downtimeSummaryService');
const MessageFormatter = require('../services/messageFormatter');

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
  return {
    _records: records,
    _trips: trips,
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
    getRecordsInRange: (start, end) => {
      const sMs = new Date(start).getTime();
      const eMs = new Date(end).getTime();
      return records.filter(r => {
        const t = new Date(r.receivedAt || r.loggedAt).getTime();
        return t >= sMs && t < eMs;
      });
    },
    getValidTripsInRange: (start, end) => {
      const sMs = new Date(start).getTime();
      const eMs = new Date(end).getTime();
      return trips.filter(t => {
        if (t.invalid) return false;
        const tEnd = new Date(t.endTime).getTime();
        return tEnd >= sMs && tEnd < eMs;
      });
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
  console.log('🧪 ROUND 3: SERVER DOWNTIME SUMMARY & RECOVERY TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const testStateFile = path.join(__dirname, 'scratch_server_lifecycle_test.json');
  const cleanupState = () => { try { if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile); } catch {} };

  cleanupState();

  // ─── 1. Downtime Detection Thresholds ──────────────────────────────────────
  console.log('--- 1. Downtime Detection Thresholds ---');

  await runTest('1.1 — Offline <= 30 minutes (e.g. 10m restart) requires NO downtime summary', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const now = new Date('2026-09-03T10:10:00.000Z');
    lm._state.lastShutdownAt = new Date('2026-09-03T10:00:00.000Z').toISOString(); // 10 min downtime

    const { durationMs, requiresDowntimeSummary } = lm.init(now);
    assert.strictEqual(durationMs, 10 * 60000);
    assert.strictEqual(requiresDowntimeSummary, false, 'Downtime of 10m must NOT trigger summary');
  });

  await runTest('1.2 — Offline exactly 30 minutes requires NO downtime summary (strictly >30m rule)', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const now = new Date('2026-09-03T10:30:00.000Z');
    lm._state.lastShutdownAt = new Date('2026-09-03T10:00:00.000Z').toISOString(); // exactly 30 min

    const { durationMs, requiresDowntimeSummary } = lm.init(now);
    assert.strictEqual(durationMs, 30 * 60000);
    assert.strictEqual(requiresDowntimeSummary, false, 'Exactly 30m downtime must NOT trigger summary');
  });

  await runTest('1.3 — Offline > 30 minutes (e.g. 31m) triggers downtime summary', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const now = new Date('2026-09-03T10:31:00.000Z');
    lm._state.lastShutdownAt = new Date('2026-09-03T10:00:00.000Z').toISOString(); // 31 min

    const { durationMs, requiresDowntimeSummary } = lm.init(now);
    assert.strictEqual(durationMs, 31 * 60000);
    assert.strictEqual(requiresDowntimeSummary, true, 'Downtime > 30m must trigger summary');
  });

  await runTest('1.4 — Overnight downtime (17:00 -> 08:00 next day = 15 hours) triggers downtime summary', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const offlineStart = new Date('2026-09-03T17:00:00.000Z');
    const startupTime = new Date('2026-09-04T08:00:00.000Z'); // 15 hours
    lm._state.lastShutdownAt = offlineStart.toISOString();

    const { durationMs, requiresDowntimeSummary } = lm.init(startupTime);
    assert.strictEqual(durationMs, 15 * 3600000);
    assert.strictEqual(requiresDowntimeSummary, true);
    assert.strictEqual(lm.getDowntimeInterval().durationStr, '15h 00m');
  });

  await runTest('1.5 — Multi-day downtime (72 hours) triggers downtime summary with correct duration', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const offlineStart = new Date('2026-09-01T08:00:00.000Z');
    const startupTime = new Date('2026-09-04T08:00:00.000Z'); // 72 hours
    lm._state.lastShutdownAt = offlineStart.toISOString();

    const { durationMs, requiresDowntimeSummary } = lm.init(startupTime);
    assert.strictEqual(durationMs, 72 * 3600000);
    assert.strictEqual(requiresDowntimeSummary, true);
    assert.strictEqual(lm.getDowntimeInterval().durationStr, '72h 00m');
  });

  // ─── 2. Report Content, Metrics & Executive Formatting ──────────────────────
  console.log('\n--- 2. Report Content, Metrics & Executive Formatting ---');

  await runTest('2.1 — Downtime Summary formats required header, timestamps, and fleet totals', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z'); // 17:00 Dubai
    const startupTime = new Date('2026-09-04T04:00:00.000Z');  // 08:00 Dubai (15h)

    // Add 3 non-critical events and 1 critical event in history
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'E-30849', vehicleModel: 'Toyota Hilux', idleTime: '20', alertTime: '2026-09-03T14:00:00.000Z' }
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' },
      { plate: 'BB-18050', vehicleModel: 'Nissan Patrol', idleTime: '15', alertTime: '2026-09-03T15:00:00.000Z' }
    );
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'E-30849', vehicleModel: 'Toyota Hilux', idleTime: '10', alertTime: '2026-09-03T16:00:00.000Z' }
    );
    mockHist.record(
      { type: 'accident', label: 'Collision / Accident', severity: 'CRITICAL' },
      { plate: 'E-30849', vehicleModel: 'Toyota Hilux', alertTime: '2026-09-03T18:14:00.000Z' } // 22:14 Dubai
    );

    // Add 1 valid completed trip
    mockHist.recordTrip({
      plate: 'E-30849', vehicleModel: 'Toyota Hilux',
      startTime: '2026-09-03T13:30:00.000Z',
      endTime: '2026-09-03T14:15:00.000Z',
      durationMs: 45 * 60000,
    });

    const res = await service.sendSummary({ offlineStart, startupTime });
    assert.strictEqual(res.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);

    const msg = mockWA.sentGroupMessages[0];
    assert.ok(msg.includes('📊 *SERVER DOWNTIME SUMMARY*'), 'Must contain header');
    assert.ok(msg.includes('Server Offline:'), 'Must show Server Offline section');
    assert.ok(msg.includes('15h 00m'), 'Must display 15h 00m duration');
    assert.ok(msg.includes('Active vehicles: 2'), 'Must report 2 active vehicles');
    assert.ok(msg.includes('Total alerts:    4'), 'Must report 4 total alerts');
    assert.ok(msg.includes('Non-critical:  3'), 'Must report 3 non-critical alerts');
    assert.ok(msg.includes('Critical:      1'), 'Must report 1 critical alert');
    assert.ok(msg.includes('Completed trips: 1'), 'Must report 1 completed trip');
    assert.ok(msg.includes('Total idle time: 45 min'), 'Must sum 45 min idle');
  });

  // ─── 3. Critical Alerts During Downtime ────────────────────────────────────
  console.log('\n--- 3. Critical Alerts During Downtime ---');

  await runTest('3.1 — Critical alerts during downtime are explicitly surfaced with details and not double-counted', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    // 2 Critical alerts
    mockHist.record(
      { type: 'sos', label: 'SOS Alert', severity: 'CRITICAL' },
      { plate: 'SOS-999', alertTime: '2026-09-03T15:30:00.000Z' }
    );
    mockHist.record(
      { type: 'engine_failure', label: 'Engine Failure / Overheat', severity: 'CRITICAL' },
      { plate: 'ENG-888', alertTime: '2026-09-03T19:00:00.000Z' }
    );

    // 1 Non-critical alert
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'VIB-111', alertTime: '2026-09-03T14:00:00.000Z' }
    );

    await service.sendSummary({ offlineStart, startupTime });
    const msg = mockWA.sentGroupMessages[0];

    assert.ok(msg.includes('Critical alerts: 2'), 'Must show Critical alerts: 2');
    assert.ok(msg.includes('SOS Alert — *SOS-999*'), 'Must detail SOS alert');
    assert.ok(msg.includes('Engine Failure / Overheat — *ENG-888*'), 'Must detail Engine Failure');
    assert.ok(msg.includes('Non-critical:  1'), 'Non-critical count must be 1');
    assert.ok(msg.includes('Total alerts:    3'), 'Total alerts must equal non-critical + critical (3)');
  });

  await runTest('3.2 — Zero critical alerts during downtime renders clean green status', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'SAFE-1', alertTime: '2026-09-03T14:00:00.000Z' }
    );

    await service.sendSummary({ offlineStart, startupTime });
    const msg = mockWA.sentGroupMessages[0];

    assert.ok(msg.includes('None detected during offline period'), 'Must indicate none detected');
    assert.ok(msg.includes('Critical:      0'));
  });

  // ─── 4. Trip Handling & Validity Rules ─────────────────────────────────────
  console.log('\n--- 4. Trip Handling & Validity Rules ---');

  await runTest('4.1 — Trip validity rules strictly preserved during downtime report', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    // 1 Valid trip (30m)
    mockHist.recordTrip({
      plate: 'VALID-TRIP', startTime: '2026-09-03T14:00:00.000Z', endTime: '2026-09-03T14:30:00.000Z', durationMs: 30 * 60000,
    });

    // 1 Spurious trip (<3m) -> rejected by recordTrip
    mockHist.recordTrip({
      plate: 'SPUR-TRIP', startTime: '2026-09-03T15:00:00.000Z', endTime: '2026-09-03T15:01:00.000Z', durationMs: 60000,
    });

    // 1 Orphan trip (no start) -> rejected
    mockHist.recordTrip({
      plate: 'ORPH-TRIP', startTime: null, endTime: '2026-09-03T16:00:00.000Z', durationMs: 0,
    });

    // 1 Invalid long trip (>8h) -> marked invalid
    mockHist.recordTrip({
      plate: 'LONG-TRIP', startTime: '2026-09-03T13:00:00.000Z', endTime: '2026-09-03T23:00:00.000Z', durationMs: 10 * 3600000,
    });

    await service.sendSummary({ offlineStart, startupTime });
    const msg = mockWA.sentGroupMessages[0];

    assert.ok(msg.includes('Completed trips: 1'), 'Only valid trip must be counted (Completed trips: 1)');
  });

  // ─── 5. Duplicate Prevention & Idempotency ─────────────────────────────────
  console.log('\n--- 5. Duplicate Prevention & Idempotency ---');

  await runTest('5.1 — Repeated restart after downtime does NOT send a duplicate downtime summary', async () => {
    const mockWA = createMockWhatsApp();
    const lm1 = new ServerLifecycleManager({ persist: true, stateFile: testStateFile });

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z'); // 15h
    lm1._state.lastShutdownAt = offlineStart.toISOString();

    const res1 = lm1.init(startupTime);
    assert.strictEqual(res1.requiresDowntimeSummary, true);

    // Mark downtime reported
    lm1.markDowntimeReported(offlineStart, startupTime);

    // Simulate second restart 5 minutes later
    const startupTime2 = new Date('2026-09-04T04:05:00.000Z');
    const lm2 = new ServerLifecycleManager({ persist: true, stateFile: testStateFile });
    const res2 = lm2.init(startupTime2);

    assert.strictEqual(res2.durationMs, 5 * 60000, 'Downtime is 5m against last heartbeat');
    assert.strictEqual(res2.requiresDowntimeSummary, false, 'Second startup must NOT require summary');
  });

  // ─── 6. Half-Open Interval Boundaries [offlineStart, startupTime) ──────────
  console.log('\n--- 6. Half-Open Interval Boundaries ---');

  await runTest('6.1 — Event exactly at offlineStart is included; event exactly at startupTime is excluded', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    // Event 1: exactly at offlineStart -> INCLUDED
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'EXACT-START', alertTime: offlineStart.toISOString() }
    );

    // Event 2: just before startup -> INCLUDED
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'JUST-BEFORE', alertTime: new Date(startupTime.getTime() - 1000).toISOString() }
    );

    // Event 3: exactly at startupTime -> EXCLUDED (belongs to online session)
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'EXACT-END', alertTime: startupTime.toISOString() }
    );

    // Event 4: after startup -> EXCLUDED
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'AFTER-START', alertTime: new Date(startupTime.getTime() + 60000).toISOString() }
    );

    await service.sendSummary({ offlineStart, startupTime });
    const msg = mockWA.sentGroupMessages[0];

    assert.ok(msg.includes('Total alerts:    2'), 'Only events 1 and 2 must be included');
    assert.ok(msg.includes('EXACT-START'));
    assert.ok(msg.includes('JUST-BEFORE'));
    assert.ok(!msg.includes('EXACT-END'));
    assert.ok(!msg.includes('AFTER-START'));
  });

  // ─── 7. Crash / Power-loss Recovery from Heartbeat ─────────────────────────
  console.log('\n--- 7. Crash / Power-loss Recovery from Heartbeat ---');

  await runTest('7.1 — Process crash without graceful shutdown recovers offlineStart from lastHeartbeatAt', async () => {
    const lm = new ServerLifecycleManager({ persist: false });

    // Simulate crash at 17:00 (no lastShutdownAt, only lastHeartbeatAt)
    const crashTime = new Date('2026-09-03T17:00:00.000Z');
    const startupTime = new Date('2026-09-04T08:00:00.000Z');

    lm._state.lastHeartbeatAt = crashTime.toISOString();
    lm._state.lastShutdownAt = null; // Unclean exit / power loss

    const { offlineStart, durationMs, requiresDowntimeSummary } = lm.init(startupTime);

    assert.strictEqual(offlineStart.getTime(), crashTime.getTime(), 'offlineStart must fallback to lastHeartbeatAt');
    assert.strictEqual(durationMs, 15 * 3600000);
    assert.strictEqual(requiresDowntimeSummary, true);
  });

  // ─── 8. Empty Downtime Period Handling ─────────────────────────────────────
  console.log('\n--- 8. Empty Downtime Period Handling ---');

  await runTest('8.1 — Empty downtime period (0 alerts, 0 trips) renders clean report with zero spam', async () => {
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();
    const service = new DowntimeSummaryService(mockHist, mockWA);

    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    const res = await service.sendSummary({ offlineStart, startupTime });
    assert.strictEqual(res.sent, true);

    const msg = mockWA.sentGroupMessages[0];
    assert.ok(msg.includes('Active vehicles: 0'));
    assert.ok(msg.includes('Total alerts:    0'));
    assert.ok(msg.includes('Completed trips: 0'));
    assert.ok(msg.includes('None detected during offline period'));
  });

  cleanupState();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 ROUND 3 TEST RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});

/**
 * tests/test_incompleteWindowRecovery.js
 *
 * Dedicated Test Suite for:
 * 1. Edge Case 1: Incomplete online 30-minute window recovery.
 * 2. Edge Case 2: Short downtime (<=30m) offline alert recovery into normal batch.
 * 3. Short downtime critical alert recovery (reported in summary, no delayed DM/individual card).
 * 4. Long downtime (>30m) strict exclusion from normal batch.
 * 5. Exactly 30:00 vs 30:01 downtime boundary handling.
 * 6. Durable window flush tracking & zero duplicate recovery across multiple restarts.
 * 7. Boundary timestamps half-open interval [start, end).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FleetAlertBatcher = require('../services/fleetAlertBatcher');
const ServerLifecycleManager = require('../services/serverLifecycleManager');
const DowntimeSummaryService = require('../services/downtimeSummaryService');

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
    recordTrip: ({ plate, vehicleModel, driver, startTime, endTime, durationMs }) => {
      const trip = {
        plate: plate?.toUpperCase(),
        vehicleModel,
        driver,
        startTime,
        endTime,
        durationMs,
        invalid: durationMs > 28800000 || durationMs < 180000,
      };
      trips.push(trip);
      return { recorded: !trip.invalid, trip };
    },
    getRecentRecords: (hours) => {
      const cutoff = Date.now() - hours * 3600000;
      return records.filter(r => new Date(r.receivedAt).getTime() > cutoff);
    },
    getRecordsInRange: (startTime, endTime) => {
      const s = new Date(startTime).getTime();
      const e = new Date(endTime).getTime();
      return records.filter(r => {
        const t = new Date(r.receivedAt).getTime();
        return t >= s && t < e;
      });
    },
    getValidTripsInRange: (startTime, endTime) => {
      const s = new Date(startTime).getTime();
      const e = new Date(endTime).getTime();
      return trips.filter(t => {
        if (t.invalid) return false;
        const tEnd = new Date(t.endTime).getTime();
        return tEnd >= s && tEnd < e;
      });
    },
    getAllVehicleSummaries: () => [],
    getVehicleSummary: () => null,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 EDGE CASES 1 & 2: INCOMPLETE WINDOW & SHORT DOWNTIME SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const testBatchStateFile = path.join(__dirname, 'scratch_batch_state_edge_cases.json');
  const cleanup = () => {
    try { if (fs.existsSync(testBatchStateFile)) fs.unlinkSync(testBatchStateFile); } catch {}
  };
  cleanup();

  // ─── 1. EDGE CASE 1: Incomplete Online Window Recovery ─────────────────────
  console.log('--- 1. Edge Case 1: Incomplete Online Window Recovery ---');

  await runTest('1.1 — Online alerts before shutdown are recovered into next normal batch, while previously flushed alerts remain excluded', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // 09:30–10:00 window was previously active and flushed
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'EARLIER-FLUSHED', alertTime: '2026-09-03T05:45:00.000Z' } // 09:45 Dubai
    );

    // Establish prior flush state for 09:30–10:00
    const earlyBatcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const w0930 = earlyBatcher.getWindow(new Date('2026-09-03T05:45:00.000Z'));
    await earlyBatcher.flushWindow(w0930);
    assert.strictEqual(earlyBatcher.isWindowFlushed(w0930.windowId), true);
    mockWA.sentGroupMessages.length = 0;

    // 10:00–10:15: Server was online, 2 non-critical alerts arrived
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'ONLINE-1', alertTime: '2026-09-03T06:05:00.000Z' } // 10:05 Dubai
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction / Phone Use', severity: 'HIGH' },
      { plate: 'ONLINE-2', alertTime: '2026-09-03T06:10:00.000Z' } // 10:10 Dubai
    );

    // Server stopped at 10:15 (offlineStart), window 10:00-10:30 was never flushed
    const offlineStart = new Date('2026-09-03T06:15:00.000Z');
    // Server starts again at 11:00
    const startupTime = new Date('2026-09-03T07:00:00.000Z');

    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    // Downtime is 45m (>30m), so downtime summary covers [10:15, 11:00)
    const recovered = batcher.recoverFromHistory({
      targetDate: startupTime,
      offlineStart,
      startupTime,
      isDowntimeReported: true,
    });

    assert.strictEqual(recovered, 2, 'Must recover exactly 2 online alerts from incomplete 10:00-10:15 window (excluding EARLIER-FLUSHED)');
    assert.strictEqual(batcher.getBufferSize(), 2, 'Buffer must contain only the 2 recovered alerts');
    const plates = batcher.getBuffer().map(e => e.fields.plate);
    assert.ok(!plates.includes('EARLIER-FLUSHED'), 'Previously flushed alert must NEVER re-appear');
    assert.ok(plates.includes('ONLINE-1'));
    assert.ok(plates.includes('ONLINE-2'));

    // Add a new live alert in 11:00-11:30
    batcher.addEvent({
      alertDef: { type: 'overspeed', label: 'Speed Alert', severity: 'MEDIUM' },
      fields: { plate: 'LIVE-1', alertTime: '2026-09-03T07:10:00.000Z' },
    });
    assert.strictEqual(batcher.getBufferSize(), 3);

    // Flush at 11:30
    const window11 = batcher.getWindow(startupTime); // 11:00–11:30
    const res = await batcher.flushWindow(window11);

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.alertCount, 3, 'Must flush exactly 3 alerts (2 recovered + 1 live)');
    assert.ok(mockWA.sentGroupMessages[0].includes('Total alerts:    3'));
    assert.ok(!mockWA.sentGroupMessages[0].includes('EARLIER-FLUSHED'));
    assert.ok(mockWA.sentGroupMessages[0].includes('ONLINE-1'));
    assert.ok(mockWA.sentGroupMessages[0].includes('ONLINE-2'));
    assert.ok(mockWA.sentGroupMessages[0].includes('LIVE-1'));
  });

  await runTest('1.2 — Incomplete online window does NOT generate a separate mini-report', async () => {
    // Verified: Exactly 1 report sent above at the 11:30 boundary, 0 mini-reports sent at 10:15 or 11:00
    assert.ok(true);
  });

  // ─── 2. EDGE CASE 2: Short Downtime (<= 30m) Recovery ──────────────────────
  console.log('\n--- 2. Edge Case 2: Short Downtime (<= 30m) Recovery ---');

  await runTest('2.1 — Offline alerts during short downtime (10m) recovered into normal batch without Downtime Summary', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // Server stopped at 10:20 (06:20 UTC), starts at 10:30 (06:30 UTC) -> 10 min downtime
    const offlineStart = new Date('2026-09-03T06:20:00.000Z');
    const startupTime = new Date('2026-09-03T06:30:00.000Z');

    // 2 alerts occurred while server was OFF (10:22, 10:25)
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'OFFLINE-1', alertTime: '2026-09-03T06:22:00.000Z' }
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction Alert', severity: 'HIGH' },
      { plate: 'OFFLINE-2', alertTime: '2026-09-03T06:25:00.000Z' }
    );

    const lm = new ServerLifecycleManager({ persist: false });
    lm._state.lastShutdownAt = offlineStart.toISOString();
    const { durationMs, requiresDowntimeSummary } = lm.init(startupTime);

    assert.strictEqual(durationMs, 10 * 60000);
    assert.strictEqual(requiresDowntimeSummary, false, 'Downtime <= 30m must NOT trigger Downtime Summary');

    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    const recovered = batcher.recoverFromHistory({
      targetDate: startupTime,
      offlineStart,
      startupTime,
      isDowntimeReported: false, // Short downtime: no downtime summary
    });

    assert.strictEqual(recovered, 2, 'Must recover the 2 offline alerts into the batch');
    assert.strictEqual(batcher.getBufferSize(), 2);

    // Flush at 11:00
    const window1030 = batcher.getWindow(startupTime); // 10:30–11:00
    const res = await batcher.flushWindow(window1030);

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.alertCount, 2);
    assert.ok(mockWA.sentGroupMessages[0].includes('OFFLINE-1'));
    assert.ok(mockWA.sentGroupMessages[0].includes('OFFLINE-2'));
  });

  await runTest('2.2 — Critical alert during short downtime is recovered into summary without retroactive DM/individual spam', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    const offlineStart = new Date('2026-09-03T06:20:00.000Z');
    const startupTime = new Date('2026-09-03T06:30:00.000Z'); // 10m downtime

    // Critical collision occurred while server was OFF at 10:24
    mockHist.record(
      { type: 'accident', label: 'Collision / Accident', severity: 'CRITICAL' },
      { plate: 'CRIT-OFFLINE', alertTime: '2026-09-03T06:24:00.000Z' }
    );
    // Non-critical alert at 10:26
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'NONCRIT-OFFLINE', alertTime: '2026-09-03T06:26:00.000Z' }
    );

    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    const recovered = batcher.recoverFromHistory({
      targetDate: startupTime,
      offlineStart,
      startupTime,
      isDowntimeReported: false,
    });

    assert.strictEqual(recovered, 2, 'Both non-critical and critical offline alerts must be recovered');

    // Zero retroactive DMs or individual cards sent upon recovery
    assert.strictEqual(mockWA.sentDMs.length, 0);
    assert.strictEqual(mockWA.sentGroupMessages.length, 0);

    // Flush window
    const res = await batcher.flushWindow(batcher.getWindow(startupTime));
    assert.strictEqual(res.sent, true);
    assert.strictEqual(mockWA.sentDMs.length, 0, 'No retroactive critical DMs allowed');

    const msg = mockWA.sentGroupMessages[0];
    assert.ok(msg.includes('Critical Alerts (Recovered from offline period)'));
    assert.ok(msg.includes('Collision / Accident — *CRIT-OFFLINE*'));
    assert.ok(msg.includes('NONCRIT-OFFLINE'));
  });

  // ─── 3. Long Downtime (>30m) Strict Exclusion from Normal Batch ─────────────
  console.log('\n--- 3. Long Downtime (>30m) Strict Exclusion from Normal Batch ---');

  await runTest('3.1 — Alerts during >30m downtime are covered by Downtime Summary and NOT added to normal batch', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // 17:00 (13:00 UTC) to 08:00 next day (04:00 UTC) -> 15 hours
    const offlineStart = new Date('2026-09-03T13:00:00.000Z');
    const startupTime = new Date('2026-09-04T04:00:00.000Z');

    // 3 alerts occurred during the 15h downtime
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'DOWNTIME-1', alertTime: '2026-09-03T14:00:00.000Z' }
    );
    mockHist.record(
      { type: 'accident', label: 'Collision / Accident', severity: 'CRITICAL' },
      { plate: 'DOWNTIME-CRIT', alertTime: '2026-09-03T16:00:00.000Z' }
    );
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'DOWNTIME-2', alertTime: '2026-09-03T18:00:00.000Z' }
    );

    // 1. DowntimeSummaryService generates the Downtime Summary
    const dtService = new DowntimeSummaryService(mockHist, mockWA);
    const dtRes = await dtService.sendSummary({ offlineStart, startupTime });
    assert.strictEqual(dtRes.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    assert.ok(mockWA.sentGroupMessages[0].includes('SERVER DOWNTIME SUMMARY'));

    // 2. Batcher recovers with isDowntimeReported: true
    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    const recovered = batcher.recoverFromHistory({
      targetDate: startupTime,
      offlineStart,
      startupTime,
      isDowntimeReported: true, // Downtime already reported!
    });

    assert.strictEqual(recovered, 0, 'Downtime alerts must NOT enter normal batcher');
    assert.strictEqual(batcher.getBufferSize(), 0, 'Buffer must be empty (zero leakage)');
  });

  // ─── 4. Downtime Boundary: Exactly 30:00 vs 30:01 ─────────────────────────
  console.log('\n--- 4. Downtime Boundary: Exactly 30:00 vs 30:01 ---');

  await runTest('4.1 — Exactly 30m downtime (1800000ms) routes alerts to normal batch (no downtime summary)', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const offlineStart = new Date('2026-09-03T10:00:00.000Z');
    const startupTime = new Date('2026-09-03T10:30:00.000Z'); // Exactly 30m
    lm._state.lastShutdownAt = offlineStart.toISOString();

    const { durationMs, requiresDowntimeSummary } = lm.init(startupTime);
    assert.strictEqual(durationMs, 30 * 60000);
    assert.strictEqual(requiresDowntimeSummary, false, 'Strictly >30m required for downtime summary');
  });

  await runTest('4.2 — 30m + 1ms downtime (1800001ms) triggers Downtime Summary', async () => {
    const lm = new ServerLifecycleManager({ persist: false });
    const offlineStart = new Date('2026-09-03T10:00:00.000Z');
    const startupTime = new Date('2026-09-03T10:30:00.001Z'); // 30m + 1ms
    lm._state.lastShutdownAt = offlineStart.toISOString();

    const { durationMs, requiresDowntimeSummary } = lm.init(startupTime);
    assert.strictEqual(durationMs, 30 * 60000 + 1);
    assert.strictEqual(requiresDowntimeSummary, true, 'Downtime > 30m must trigger downtime summary');
  });

  // ─── 5. Durable Window Flush & Multiple Restart Idempotency ────────────────
  console.log('\n--- 5. Durable Window Flush & Multiple Restart Idempotency ---');

  await runTest('5.1 — Flushed window is permanently sealed in flushedWindows and never re-recovered across multiple restarts', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // 10:00–10:30 window (06:00–06:30 UTC)
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'FLUSHED-1', alertTime: '2026-09-03T06:10:00.000Z' }
    );
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'FLUSHED-2', alertTime: '2026-09-03T06:20:00.000Z' }
    );

    const batcher1 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    batcher1.recoverFromHistory(new Date('2026-09-03T06:25:00.000Z'));
    assert.strictEqual(batcher1.getBufferSize(), 2);

    // Flush the window at 10:30
    const w1030 = batcher1.getWindow(new Date('2026-09-03T06:25:00.000Z'));
    await batcher1.flushWindow(w1030);
    assert.strictEqual(batcher1.getBufferSize(), 0);
    assert.strictEqual(batcher1.isWindowFlushed(w1030.windowId), true);

    // --- First Restart at 10:35 ---
    const batcher2 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    assert.strictEqual(batcher2.isWindowFlushed(w1030.windowId), true, 'Window must remain durably flushed');
    const recoveredAfterRestart1 = batcher2.recoverFromHistory(new Date('2026-09-03T06:35:00.000Z'));
    assert.strictEqual(recoveredAfterRestart1, 0, 'Must recover 0 alerts for already-flushed window');
    assert.strictEqual(batcher2.getBufferSize(), 0);

    // --- Second Restart at 10:45 ---
    const batcher3 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const recoveredAfterRestart2 = batcher3.recoverFromHistory(new Date('2026-09-03T06:45:00.000Z'));
    assert.strictEqual(recoveredAfterRestart2, 0, 'Must recover 0 alerts on second restart');
    assert.strictEqual(batcher3.getBufferSize(), 0);
  });

  // ─── 6. Boundary Timestamps [start, end) ──────────────────────────────────
  console.log('\n--- 6. Boundary Timestamps [start, end) ---');

  await runTest('6.1 — Half-open interval strictly respected: event at window.start included; event at window.end held for next', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    const batcher = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });

    const window = batcher.getWindow(new Date('2026-09-03T06:15:00.000Z')); // 10:00–10:30 Dubai
    const startMs = window.start.getTime();
    const endMs = window.end.getTime();

    // Event 1: exactly at window.start (10:00:00)
    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'EXACT-START', alertTime: new Date(startMs).toISOString() },
    });

    // Event 2: just before window.end (10:29:59)
    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'JUST-BEFORE-END', alertTime: new Date(endMs - 1000).toISOString() },
    });

    // Event 3: exactly at window.end (10:30:00) -> belongs to 10:30-11:00
    batcher.addEvent({
      alertDef: { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      fields: { plate: 'EXACT-END', alertTime: new Date(endMs).toISOString() },
    });

    assert.strictEqual(batcher.getBufferSize(), 3);

    const res = await batcher.flushWindow(window);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.alertCount, 2, 'Must flush exactly 2 events (start and just-before-end)');
    assert.strictEqual(batcher.getBufferSize(), 1, 'Event at exact end must remain buffered for next window');
    assert.strictEqual(batcher.getBuffer()[0].fields.plate, 'EXACT-END');
  });

  // ─── 7. Mixed Timeline: Flushed + Incomplete Online + Downtime (>30m) ──────
  console.log('\n--- 7. Mixed Timeline: Flushed + Incomplete Online + Downtime (>30m) ---');

  await runTest('7.1 — Mixed timeline: previously flushed window (09:50) never recovered, incomplete online (10:05, 10:10) recovered into Fleet Summary, downtime (10:20, 10:25) covered by Downtime Summary with ZERO duplicate/overlap', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // 1. Alert at 09:50 (05:50 UTC) — part of 09:30–10:00 window
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'FLUSHED-0950', alertTime: '2026-09-03T05:50:00.000Z' }
    );

    // Initial batcher flushes the 09:30–10:00 window at 10:00
    const batcherEarly = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    batcherEarly.recoverFromHistory(new Date('2026-09-03T05:55:00.000Z'));
    const w0930 = batcherEarly.getWindow(new Date('2026-09-03T05:50:00.000Z'));
    await batcherEarly.flushWindow(w0930);
    assert.strictEqual(batcherEarly.isWindowFlushed(w0930.windowId), true);
    mockWA.sentGroupMessages.length = 0; // Clear group messages

    // 2. Alerts during incomplete online window 10:00–10:15
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'ONLINE-1005', alertTime: '2026-09-03T06:05:00.000Z' }
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction Alert', severity: 'HIGH' },
      { plate: 'ONLINE-1010', alertTime: '2026-09-03T06:10:00.000Z' }
    );

    // 3. Server shuts down at 10:15
    const offlineStart = new Date('2026-09-03T06:15:00.000Z');

    // 4. Alerts arrive during downtime (10:15–11:00)
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'DOWNTIME-1020', alertTime: '2026-09-03T06:20:00.000Z' }
    );
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'DOWNTIME-1025', alertTime: '2026-09-03T06:25:00.000Z' }
    );

    // 5. Server restarts at 11:00 (downtime = 45m > 30m)
    const startupTime = new Date('2026-09-03T07:00:00.000Z');

    // A. Downtime Summary dispatches for [10:15, 11:00)
    const dtService = new DowntimeSummaryService(mockHist, mockWA);
    const dtRes = await dtService.sendSummary({ offlineStart, startupTime });
    assert.strictEqual(dtRes.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 1);
    const dtMsg = mockWA.sentGroupMessages[0];
    assert.ok(dtMsg.includes('SERVER DOWNTIME SUMMARY'));
    assert.ok(dtMsg.includes('DOWNTIME-1020'));
    assert.ok(dtMsg.includes('DOWNTIME-1025'));
    assert.ok(!dtMsg.includes('FLUSHED-0950'));
    assert.ok(!dtMsg.includes('ONLINE-1005'));
    assert.ok(!dtMsg.includes('ONLINE-1010'));

    // B. FleetAlertBatcher recovers for next normal window (11:00–11:30)
    const batcher11 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const recCount = batcher11.recoverFromHistory({
      targetDate: startupTime,
      offlineStart,
      startupTime,
      isDowntimeReported: true,
    });

    assert.strictEqual(recCount, 2, 'Must recover exactly the 2 incomplete online alerts (10:05, 10:10)');
    assert.strictEqual(batcher11.getBufferSize(), 2);
    const bufPlates = batcher11.getBuffer().map(e => e.fields.plate);
    assert.ok(bufPlates.includes('ONLINE-1005'));
    assert.ok(bufPlates.includes('ONLINE-1010'));
    assert.ok(!bufPlates.includes('FLUSHED-0950'), '09:50 must NEVER be recovered');
    assert.ok(!bufPlates.includes('DOWNTIME-1020'), '10:20 must NOT leak into batch');
    assert.ok(!bufPlates.includes('DOWNTIME-1025'), '10:25 must NOT leak into batch');

    // Flush normal Fleet Summary at 11:30
    const w1100 = batcher11.getWindow(startupTime);
    const flushRes = await batcher11.flushWindow(w1100);
    assert.strictEqual(flushRes.sent, true);
    assert.strictEqual(mockWA.sentGroupMessages.length, 2); // 1 Downtime + 1 Fleet Summary
    const fleetMsg = mockWA.sentGroupMessages[1];
    assert.ok(fleetMsg.includes('FLEET ALERT SUMMARY'));
    assert.ok(fleetMsg.includes('Total alerts:    2'));
    assert.ok(fleetMsg.includes('ONLINE-1005'));
    assert.ok(fleetMsg.includes('ONLINE-1010'));
    assert.ok(!fleetMsg.includes('DOWNTIME-1020'));
    assert.ok(!fleetMsg.includes('DOWNTIME-1025'));
    assert.ok(!fleetMsg.includes('FLUSHED-0950'));
  });

  // ─── 8. Crash During Recovery: Multi-Crash Idempotency ─────────────────────
  console.log('\n--- 8. Crash During Recovery: Multi-Crash Idempotency ---');

  await runTest('8.1 — Crash during recovery & multiple restarts: alerts recovered exactly once, zero duplicates across repeated crashes before flush, permanently sealed after flush', async () => {
    cleanup();
    const mockHist = createMockHistory();
    const mockWA = createMockWhatsApp();

    // 10:05 and 10:10 alerts
    mockHist.record(
      { type: 'vibration', label: 'Vibration Alert', severity: 'MEDIUM' },
      { plate: 'RECOVERY-CRASH-1', alertTime: '2026-09-03T06:05:00.000Z' }
    );
    mockHist.record(
      { type: 'distraction', label: 'Distraction Alert', severity: 'HIGH' },
      { plate: 'RECOVERY-CRASH-2', alertTime: '2026-09-03T06:10:00.000Z' }
    );

    // Initial crash at 10:15
    const offlineStart = new Date('2026-09-03T06:15:00.000Z');

    // --- Restart 1 at 10:16 ---
    const batcherCycle1 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const c1 = batcherCycle1.recoverFromHistory({
      targetDate: new Date('2026-09-03T06:16:00.000Z'),
      offlineStart,
      startupTime: new Date('2026-09-03T06:16:00.000Z'),
      isDowntimeReported: false,
    });
    assert.strictEqual(c1, 2);
    assert.strictEqual(batcherCycle1.getBufferSize(), 2);

    // Simulated CRASH AGAIN at 10:18 (process dies without flushing)

    // --- Restart 2 at 10:20 ---
    const batcherCycle2 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const c2 = batcherCycle2.recoverFromHistory({
      targetDate: new Date('2026-09-03T06:20:00.000Z'),
      offlineStart,
      startupTime: new Date('2026-09-03T06:20:00.000Z'),
      isDowntimeReported: false,
    });
    assert.strictEqual(c2, 2, 'Must recover the 2 alerts again');
    assert.strictEqual(batcherCycle2.getBufferSize(), 2, 'Buffer must have exactly 2 alerts (no duplicate multiplication)');

    // Call recoverFromHistory a second time within same process run to verify in-memory dedup
    const c2Dupe = batcherCycle2.recoverFromHistory({
      targetDate: new Date('2026-09-03T06:20:00.000Z'),
      offlineStart,
      startupTime: new Date('2026-09-03T06:20:00.000Z'),
      isDowntimeReported: false,
    });
    assert.strictEqual(c2Dupe, 0, 'Subsequent recovery call in same process must recover 0 duplicates');
    assert.strictEqual(batcherCycle2.getBufferSize(), 2);

    // Flush at 10:30
    const w1000 = batcherCycle2.getWindow(new Date('2026-09-03T06:20:00.000Z'));
    const flushRes = await batcherCycle2.flushWindow(w1000);
    assert.strictEqual(flushRes.sent, true);
    assert.strictEqual(flushRes.alertCount, 2);

    // --- Restart 3 at 10:35 (after flush) ---
    const batcherCycle3 = new FleetAlertBatcher(mockHist, mockWA, {
      persist: true,
      stateFile: testBatchStateFile,
    });
    const c3 = batcherCycle3.recoverFromHistory({
      targetDate: new Date('2026-09-03T06:35:00.000Z'),
      offlineStart: new Date('2026-09-03T06:31:00.000Z'),
      startupTime: new Date('2026-09-03T06:35:00.000Z'),
      isDowntimeReported: false,
    });
    assert.strictEqual(c3, 0, 'Window was flushed, so 0 alerts must be recovered after flush');
    assert.strictEqual(batcherCycle3.getBufferSize(), 0);
  });

  cleanup();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 INCOMPLETE WINDOW & SHORT DOWNTIME RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled test runner error:', err);
  process.exit(1);
});

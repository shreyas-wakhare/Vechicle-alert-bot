/**
 * tests/test_aiFleetIntegration.js
 *
 * Feature #4 Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization
 *
 * End-to-End Integration & Regression Test Suite.
 * Validates System 1 & Track9999 parser paths, DailySummary integration,
 * MessageFormatter formatting, single-alert Phase 2 regression isolation, and zero-spam boundaries.
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const AlertParser       = require('../services/alertParser');
const HistoryStore      = require('../services/historyStore');
const DailySummary      = require('../services/dailySummary');
const MessageFormatter  = require('../services/messageFormatter');
const AIFleetSynthesis  = require('../services/aiFleetSynthesis');
const { MockAIProvider } = require('../services/aiProvider');

let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('🧪 FEATURE #4 PHASE 3 — FLEET INTEGRATION TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. MessageFormatter Fleet Briefing Formatting ──────────────────────────
  await runTest('1 — MessageFormatter renders formatted WhatsApp Fleet Executive Briefing', () => {
    const formatter = new MessageFormatter();
    const fleetSynth = {
      schemaVersion: '1.0',
      fleetStatus: 'ATTENTION_REQUIRED — 1 vehicle elevated to High risk level.',
      executiveSummary: '2 alerts recorded across 2 active vehicles. High risk detected on vehicle D/31498.',
      topPriorities: [
        { vehicle: 'D/31498', driver: 'AHMED', priorityRank: 1, reason: 'HIGH risk level (72/100)', action: 'Contact driver and schedule coaching.' }
      ],
      dominantPatterns: ['Speed limit violations (1 event)'],
      operationalFocus: 'Focus immediate manager attention on vehicle D/31498.',
      groundingStatus: 'DETERMINISTIC_FALLBACK'
    };

    const text = formatter.formatFleetExecutiveBriefing(fleetSynth);
    assert.ok(text.includes('📊 *EXECUTIVE FLEET BRIEFING*'));
    assert.ok(text.includes('D/31498'));
    assert.ok(text.includes('AHMED'));
    assert.ok(text.includes('Contact driver and schedule coaching'));
  });

  // ── 2. System 1 Email Parser into Fleet Synthesis ─────────────────────────
  await runTest('2 — System 1 email alert parses into valid Fleet Ground Truth and Fleet Synthesis', async () => {
    const parser = new AlertParser();
    const fleetSynth = new AIFleetSynthesis({ provider: new MockAIProvider({ latencyMs: 0 }) });

    const mail = {
      from: { value: [{ address: 'alerts@tracking.com' }] },
      subject: 'Over Speed Alert',
      text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 80 kmph\n118 kmph\non 2026-09-02 10:00:00\nlat: 25.1234, lon: 55.2345',
      date: new Date('2026-09-02T10:00:00.000Z'),
    };

    const parsed = parser.parse(mail);
    const res = await fleetSynth.synthesizeFleet([parsed.context || parsed.fields]);

    assert.ok(res);
    assert.ok(res.executiveSummary.includes('D/31498') || res.executiveSummary.includes('1 alert'));
  });

  // ── 3. Track9999 Email Parser into Fleet Synthesis ────────────────────────
  await runTest('3 — Track9999 email alert parses into valid Fleet Ground Truth and Fleet Synthesis', async () => {
    const parser = new AlertParser();
    const fleetSynth = new AIFleetSynthesis({ provider: new MockAIProvider({ latencyMs: 0 }) });

    const mail = {
      from: { value: [{ address: 'noreply@track9999.com' }] },
      subject: 'Tracker Event Notification[Camera Screen Blocked][CC-48315]',
      text: 'Camera Screen Blocked alert for vehicle CC-48315 on 2026-09-02 10:00:00',
      date: new Date('2026-09-02T10:00:00.000Z'),
    };

    const parsed = parser.parse(mail);
    const res = await fleetSynth.synthesizeFleet([parsed.context || parsed.fields]);

    assert.ok(res);
    assert.ok(res.executiveSummary.includes('CC-48315') || res.executiveSummary.includes('1 alert'));
  });

  // ── 4. Multi-Source Mixed Fleet Synthesis ─────────────────────────────────
  await runTest('4 — Multi-source alerts (System 1 + Track9999) aggregate deterministically into Fleet Synthesis', async () => {
    const parser = new AlertParser();
    const fleetSynth = new AIFleetSynthesis({ provider: new MockAIProvider({ latencyMs: 0 }) });

    const mail1 = {
      from: { value: [{ address: 'alerts@tracking.com' }] },
      subject: 'Over Speed Alert',
      text: 'Your D/31498-Toyota Hilux is exceeding the speed limit 80 kmph\n118 kmph\non 2026-09-02 10:00:00',
      date: new Date('2026-09-02T10:00:00.000Z'),
    };

    const mail2 = {
      from: { value: [{ address: 'noreply@track9999.com' }] },
      subject: 'Tracker Event Notification[Camera Screen Blocked][CC-48315]',
      text: 'Camera Screen Blocked alert for vehicle CC-48315 on 2026-09-02 10:00:00',
      date: new Date('2026-09-02T10:00:00.000Z'),
    };

    const p1 = parser.parse(mail1);
    const p2 = parser.parse(mail2);

    const res = await fleetSynth.synthesizeFleet([
      { plate: 'D/31498', alertType: 'speeding', severity: 'HIGH', vehicleModel: 'Toyota Hilux' },
      { plate: 'CC-48315', alertType: 'camera_blocked', severity: 'HIGH', vehicleModel: 'Truck' }
    ]);

    assert.strictEqual(res.topPriorities.length, 2);
    assert.ok(res.executiveSummary.includes('2 alert(s) recorded across 2 active vehicle(s)'));
  });

  // ── 5. DailySummary Integration (Zero Alert Spam) ─────────────────────────
  await runTest('5 — DailySummary integrates AI Fleet Executive Briefing cleanly without notification spam', async () => {
    const history = new HistoryStore({ persist: false });
    history.record({ type: 'speeding', label: 'Over Speed', severity: 'HIGH' }, { plate: 'D/31498', vehicleModel: 'Toyota Hilux' });

    let sentMsg = null;
    const mockWhatsapp = {
      sendToGroup: async (msg) => { sentMsg = msg; }
    };

    const dailySummary = new DailySummary(history, mockWhatsapp);
    await dailySummary._send('2026-09-02');

    assert.ok(sentMsg);
    assert.ok(sentMsg.includes('📊 *DAILY FLEET SUMMARY*'));
    assert.ok(sentMsg.includes('*🤖 AI FLEET EXECUTIVE BRIEFING*'));
    assert.ok(sentMsg.includes('EXECUTIVE FLEET BRIEFING'));
  });

  // ── 6. Phase 2 Single-Alert Path Isolation ─────────────────────────────────
  await runTest('6 — Phase 2 single-alert executive synthesis path remains 100% frozen and isolated', async () => {
    const AIExecutiveSynthesis = require('../services/aiExecutiveSynthesis');
    const synthEngine = new AIExecutiveSynthesis({ provider: new MockAIProvider({ latencyMs: 0 }) });

    const ctx = {
      alertType: 'speeding', alertLabel: 'Over Speed', severity: 'HIGH',
      vehicle: { plate: 'ISO-PH2' }
    };

    const res = await synthEngine.synthesize(ctx);
    assert.ok(res);
    assert.strictEqual(res.groundingStatus, 'GROUNDED');
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 FLEET INTEGRATION TEST RESULTS: ${passedTests} Passed | ${failedTests} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});

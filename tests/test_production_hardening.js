/**
 * tests/test_production_hardening.js
 *
 * PRODUCTION HARDENING & RELIABILITY TEST SUITE
 * Validates fixes for:
 * 1. Non-blocking AI Delivery
 * 2. IMAP Partial Sender Search Failure Safety
 * 3. WhatsApp Wording Cleanups (no duplicate ALERT ALERT)
 * 4. Vibration Operational Attention (vibration x2 routine, vibration x3+ HIGH_ATTENTION, isIncident=false)
 */

const assert = require('assert');
const MessageFormatter = require('../services/messageFormatter');
const EmailMonitor = require('../services/emailMonitor');
const EventContextBuilder = require('../services/eventContext');
const IncidentGroupingEngine = require('../services/incidentGroupingEngine');
const IncidentInterpretationEngine = require('../services/incidentInterpretationEngine');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    console.error(err.stack);
    failed++;
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🧪 PRODUCTION HARDENING & RELIABILITY TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ─── PROBLEM 1: AI Non-blocking Alert Delivery ─────────────────────────────
  console.log('--- Problem 1: AI Non-blocking Alert Delivery ---');

  await runTest('1.1 — Standard alert receives AI enrichment when fast', async () => {
    const formatter = new MessageFormatter();
    const alertDef = { type: 'speeding', label: 'Over Speed', emoji: '🚨', severity: 'HIGH' };
    const fields = { plate: 'D/12345', speed: 120, speedLimit: 80, alertTime: new Date().toISOString() };
    const context = {
      alertLabel: 'Over Speed',
      alertType: 'speeding',
      vehicle: { plate: 'D/12345' },
      aiSynthesis: {
        summary: 'Vehicle exceeded speed limit significantly.',
        operationalMeaning: 'Increased risk of severe braking or collision.',
        recommendedAction: { directive: 'Notify fleet manager.' }
      }
    };

    const { text } = formatter.format(alertDef, fields);
    const briefing = formatter.formatExecutiveBriefing(context);
    const combined = `${text}\n\n*🤖 EXECUTIVE AI SYNTHESIS*\n${briefing}`;

    assert.ok(combined.includes('OVER SPEED ALERT'), 'Must contain clean alert header');
    assert.ok(combined.includes('*🤖 EXECUTIVE AI SYNTHESIS*'), 'Must contain AI executive synthesis header');
  });

  await runTest('1.2 — Critical alerts (SOS/Accident) format deterministic alert immediately', async () => {
    const formatter = new MessageFormatter();
    const alertDef = { type: 'sos', label: 'SOS Alert', emoji: '🆘', severity: 'CRITICAL' };
    const fields = { plate: 'D/12345', alertTime: new Date().toISOString() };

    const { text, criticalLevel } = formatter.format(alertDef, fields);
    assert.strictEqual(criticalLevel, 3, 'SOS must have critical level >= 3');
    assert.ok(text.includes('🆘 *SOS ALERT*'), 'Must render clean SOS alert header');
    assert.ok(!text.includes('ALERT ALERT'), 'Must NOT duplicate ALERT suffix');
  });


  // ─── PROBLEM 2: IMAP Partial Sender Search Failure ──────────────────────────
  console.log('\n--- Problem 2: IMAP Partial Sender Search Failure ---');

  await runTest('2.1 — Both sender searches succeed -> clean poll and _onPollSuccess called', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor._reconnectDelay = 40000;
    monitor._consecutiveSuccesses = 0;

    monitor.client = {
      usable: true,
      search: async () => [],
    };

    await monitor._poll();
    await monitor._poll();

    assert.strictEqual(monitor._consecutiveSuccesses, 2, 'Two clean polls must yield 2 consecutive successes');
    assert.strictEqual(monitor._reconnectDelay, 5000, 'Two clean polls must reset backoff delay to 5000ms');

    await monitor.stop();
  });

  await runTest('2.2 — Partial sender search failure prevents _onPollSuccess and resets _consecutiveSuccesses', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor._reconnectDelay = 40000;
    monitor._consecutiveSuccesses = 1;

    let callCount = 0;
    monitor.client = {
      usable: true,
      search: async ({ from }) => {
        callCount++;
        if (callCount === 1) throw new Error('System1 search timeout');
        return [];
      }
    };

    await monitor._poll();

    assert.strictEqual(monitor._consecutiveSuccesses, 0, 'Partial search failure must reset _consecutiveSuccesses to 0');
    assert.strictEqual(monitor._reconnectDelay, 40000, 'Partial search failure must NOT reset backoff delay to 5000ms');

    await monitor.stop();
  });

  await runTest('2.3 — Partial sender search failure skips fetch/process entirely, keeping watermark at 100 and consecutiveSuccesses at 0', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor.setLastProcessedUID(100);
    monitor._consecutiveSuccesses = 1;
    monitor._reconnectDelay = 40000;

    let processMessageCalled = false;
    const sender = 'touchtrack@teamworldtechnology.com';

    monitor.client = {
      usable: true,
      search: async (query) => {
        if (query && query.from && query.from.includes('touchtrack')) {
          throw new Error('Search failure on sender 1');
        }
        return [105];
      },
      fetch: async function* () {
        processMessageCalled = true;
        yield { uid: 105, source: Buffer.from(`From: TouchTrack <${sender}>\r\nSubject: Test 105\r\n\r\nTest Body`) };
      }
    };
    monitor.alertParser = { parse: () => null };

    await monitor._poll();

    assert.strictEqual(processMessageCalled, false, 'Fetch/processMessage MUST NOT be invoked during partial search failure to prevent duplicate processing');
    assert.strictEqual(monitor._lastProcessedUID, 100, 'Global watermark MUST remain unchanged at 100');
    assert.strictEqual(monitor._consecutiveSuccesses, 0, 'Partial sender search failure must reset consecutive successes to 0');
    assert.strictEqual(monitor._reconnectDelay, 40000, 'Backoff delay must remain unchanged');

    await monitor.stop();
  });

  await runTest('2.4 — Follow-up clean poll processes UID 105 exactly once after all sender searches succeed', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor.setLastProcessedUID(100);

    const sender = 'touchtrack@teamworldtechnology.com';

    let searchFailedOnPoll1 = true;
    let fetchCount = 0;

    monitor.client = {
      usable: true,
      search: async (query) => {
        if (searchFailedOnPoll1 && query && query.from && query.from.includes('touchtrack')) {
          throw new Error('Transient search failure');
        }
        return [105];
      },
      fetch: async function* () {
        fetchCount++;
        yield { uid: 105, source: Buffer.from(`From: TouchTrack <${sender}>\r\nSubject: Test 105\r\n\r\nTest Body`) };
      }
    };
    monitor.alertParser = { parse: () => null };

    // Poll 1: Partial failure -> skipped
    await monitor._poll();
    assert.strictEqual(fetchCount, 0, 'Poll 1 (degraded) must skip fetch');
    assert.strictEqual(monitor._lastProcessedUID, 100, 'Poll 1 must not advance watermark');

    // Poll 2: Recovered -> all searches succeed
    searchFailedOnPoll1 = false;
    await monitor._poll();
    assert.strictEqual(fetchCount, 1, 'Poll 2 (clean) must fetch UID 105 exactly once');
    assert.strictEqual(monitor._lastProcessedUID, 105, 'Poll 2 must advance watermark to 105');

    await monitor.stop();
  });


  // ─── PROBLEM 3: WhatsApp Alert Wording Cleanup ─────────────────────────────
  console.log('\n--- Problem 3: WhatsApp Alert Wording Cleanup ---');

  await runTest('3.1 — Vibration alert renders clean "VIBRATION ALERT" without duplicate ALERT', async () => {
    const formatter = new MessageFormatter();
    const alertDef = { type: 'vibration', label: 'Vibration Alert', emoji: '⚠️', severity: 'MEDIUM' };
    const fields = { plate: 'V-999', alertTime: new Date().toISOString() };

    const { text } = formatter.format(alertDef, fields);
    assert.ok(text.includes('⚠️ *VIBRATION ALERT*'), `Header should be "⚠️ *VIBRATION ALERT*", got:\n${text}`);
    assert.ok(!text.includes('ALERT ALERT'), 'Must not contain duplicate ALERT word');
  });

  await runTest('3.2 — SOS Alert renders clean "SOS ALERT" without duplicate ALERT', async () => {
    const formatter = new MessageFormatter();
    const alertDef = { type: 'sos', label: 'SOS Alert', emoji: '🆘', severity: 'CRITICAL' };
    const fields = { plate: 'V-999', alertTime: new Date().toISOString() };

    const { text } = formatter.format(alertDef, fields);
    assert.ok(text.includes('🆘 *SOS ALERT*'), `Header should be "🆘 *SOS ALERT*", got:\n${text}`);
    assert.ok(!text.includes('ALERT ALERT'), 'Must not contain duplicate ALERT word');
  });

  await runTest('3.3 — Over Speed, Accident, Track9999 render clean headers', async () => {
    const formatter = new MessageFormatter();

    const speedDef = { type: 'speeding', label: 'Over Speed', emoji: '🚨', severity: 'HIGH' };
    const accDef = { type: 'accident', label: 'Collision / Accident', emoji: '💥', severity: 'CRITICAL' };
    const t99Def = { type: 'camera_blocked', label: 'Camera Blocked', emoji: '📷', severity: 'HIGH' };

    const t1 = formatter.format(speedDef, { plate: 'V-1' }).text;
    const t2 = formatter.format(accDef, { plate: 'V-2' }).text;
    const t3 = formatter.format(t99Def, { plate: 'V-3', source: 'track9999', eventName: 'Camera Screen Blocked' }).text;

    assert.ok(t1.includes('🚨 *OVER SPEED ALERT*'));
    assert.ok(t2.includes('💥 *COLLISION / ACCIDENT ALERT*'));
    assert.ok(t3.includes('📷 *CAMERA BLOCKED ALERT*'));
    assert.ok(!t1.includes('ALERT ALERT') && !t2.includes('ALERT ALERT') && !t3.includes('ALERT ALERT'));
  });

  await runTest('3.4 — Executive briefing header clean formatting', async () => {
    const formatter = new MessageFormatter();
    const context = {
      alertLabel: 'Vibration Alert',
      riskLevel: 'HIGH',
      vehicle: { plate: 'V-999' },
      aiSynthesis: { summary: 'Vibration detected.' }
    };

    const briefing = formatter.formatExecutiveBriefing(context);
    assert.ok(briefing.includes('🚨 *HIGH RISK — VIBRATION ALERT*'), `Briefing header must be clean, got:\n${briefing}`);
    assert.ok(!briefing.includes('ALERT ALERT'));
  });


  // ─── PROBLEM 4: Repeated Vibration Operational Attention ─────────────────
  console.log('\n--- Problem 4: Repeated Vibration Operational Attention ---');

  await runTest('4.1 — Vibration x 2 evaluates as CORRELATED_ACTIVITY, IsIncident: false, ROUTINE_ATTENTION', async () => {
    const grouping = new IncidentGroupingEngine();
    const interpretation = new IncidentInterpretationEngine();

    const correlation = {
      eventCount: 2,
      events: [
        { alertType: 'vibration', timestamp: '2026-09-02T10:00:00.000Z' },
        { alertType: 'vibration', timestamp: '2026-09-02T10:05:00.000Z' }
      ]
    };

    const inc = grouping.group(correlation);
    assert.strictEqual(inc.isIncident, false, 'Pure vibration sequence must have isIncident: false');
    assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY', 'Pure vibration sequence must classify as CORRELATED_ACTIVITY');

    const interp = interpretation.interpret(inc, correlation, {}, null);
    assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION', 'Vibration x2 must evaluate to ROUTINE_ATTENTION');
  });

  await runTest('4.2 — Vibration x 3+ evaluates as CORRELATED_ACTIVITY, IsIncident: false, HIGH_ATTENTION', async () => {
    const grouping = new IncidentGroupingEngine();
    const interpretation = new IncidentInterpretationEngine();

    const correlation = {
      eventCount: 3,
      events: [
        { alertType: 'vibration', timestamp: '2026-09-02T10:00:00.000Z' },
        { alertType: 'vibration', timestamp: '2026-09-02T10:05:00.000Z' },
        { alertType: 'vibration', timestamp: '2026-09-02T10:10:00.000Z' }
      ]
    };

    const inc = grouping.group(correlation);
    assert.strictEqual(inc.isIncident, false, 'Vibration x3 must maintain isIncident: false');
    assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY', 'Vibration x3 must maintain CORRELATED_ACTIVITY');

    const interp = interpretation.interpret(inc, correlation, {}, null);
    assert.strictEqual(interp.recommendedAttention, 'HIGH_ATTENTION', 'Vibration x3+ must evaluate to HIGH_ATTENTION for operational review');
  });

  await runTest('4.3 — Distraction x 2 evaluates as DRIVER_DISTRACTION_UNSAFE_DRIVING, IsIncident: true, HIGH_ATTENTION', async () => {
    const grouping = new IncidentGroupingEngine();
    const interpretation = new IncidentInterpretationEngine();

    const correlation = {
      eventCount: 2,
      events: [
        { alertType: 'distraction', timestamp: '2026-09-02T10:00:00.000Z' },
        { alertType: 'distraction', timestamp: '2026-09-02T10:05:00.000Z' }
      ]
    };

    const inc = grouping.group(correlation);
    assert.strictEqual(inc.isIncident, true, 'Distraction x2 must be isIncident: true');
    assert.strictEqual(inc.type, 'DRIVER_DISTRACTION_UNSAFE_DRIVING');

    const interp = interpretation.interpret(inc, correlation, {}, null);
    assert.strictEqual(interp.recommendedAttention, 'HIGH_ATTENTION');
  });

  await runTest('4.4 — Generic 3-event correlation (e.g. idle x3) evaluates to ROUTINE_ATTENTION, NOT HIGH_ATTENTION', async () => {
    const grouping = new IncidentGroupingEngine();
    const interpretation = new IncidentInterpretationEngine();

    const correlation = {
      eventCount: 3,
      events: [
        { alertType: 'idle', timestamp: '2026-09-02T10:00:00.000Z' },
        { alertType: 'idle', timestamp: '2026-09-02T10:05:00.000Z' },
        { alertType: 'idle', timestamp: '2026-09-02T10:10:00.000Z' }
      ]
    };

    const inc = grouping.group(correlation);
    assert.strictEqual(inc.isIncident, false, 'Idle x3 must remain isIncident: false');
    assert.strictEqual(inc.type, 'CORRELATED_ACTIVITY', 'Idle x3 must classify as CORRELATED_ACTIVITY');

    const interp = interpretation.interpret(inc, correlation, {}, null);
    assert.strictEqual(interp.recommendedAttention, 'ROUTINE_ATTENTION', 'Generic 3-event correlation must remain ROUTINE_ATTENTION and NOT be upgraded to HIGH_ATTENTION');
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 TEST RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});

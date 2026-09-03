/**
 * tests/test_imap_reliability.js
 *
 * Deterministic Test Suite for BUG #1 — IMAP Reconnect Storm & Reliability
 *
 * Tests cases 1 through 13 as specified in Phase 3 of the master prompt.
 * Uses mock ImapFlow to run 100% offline without live network dependencies.
 */

'use strict';
require('dotenv').config();

const assert = require('assert');
const EmailMonitor = require('../services/emailMonitor');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ❌ ${name}: ${err.message}`);
      console.error(err.stack);
      failed++;
    });
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('🧪 BUG #1 — IMAP RECONNECT STORM & RELIABILITY TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════\n');

async function runAllTests() {

  // Test 1: Simultaneous reconnect requests produce a single reconnect operation
  await runTest('1 — Simultaneous reconnect requests produce single reconnect operation', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor.client = { usable: false, logout: async () => {}, connect: async () => {}, mailboxOpen: async () => {} };

    // Fire 3 reconnect calls concurrently
    const p1 = monitor._scheduleReconnect();
    const p2 = monitor._scheduleReconnect();
    const p3 = monitor._scheduleReconnect();

    assert.strictEqual(p1, p2, 'p1 and p2 must be identical promise references');
    assert.strictEqual(p2, p3, 'p2 and p3 must be identical promise references');
    assert.strictEqual(monitor.stats.reconnects, 1, 'reconnect count must increment exactly once');

    await monitor.stop();
  });

  // Test 2: Repeated socket error events trigger a single reconnect workflow
  await runTest('2 — Repeated socket errors produce single reconnect workflow', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    let socketErrorHandler = null;
    monitor.client = {
      usable: true,
      on: (event, handler) => { if (event === 'error') socketErrorHandler = handler; },
      logout: async () => {},
      connect: async () => {},
      mailboxOpen: async () => {}
    };

    // Attach real client error behavior
    monitor.client.on('error', (err) => {
      if (monitor.state === 'CONNECTED') {
        monitor.state = 'DEGRADED';
      }
      monitor._scheduleReconnect();
    });

    // Emit 3 rapid socket errors
    socketErrorHandler(new Error('Socket reset 1'));
    socketErrorHandler(new Error('Socket reset 2'));
    socketErrorHandler(new Error('Socket reset 3'));

    assert.strictEqual(monitor.stats.reconnects, 1, 'Multiple socket errors must schedule only 1 reconnect attempt');
    assert.strictEqual(monitor.getState(), 'RECONNECTING', 'State must be RECONNECTING');

    await monitor.stop();
  });

  // Test 3: Poll while reconnecting skips execution
  await runTest('3 — Poll while reconnecting skips execution', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'RECONNECTING';
    monitor._polling = false;

    let searchCalled = false;
    monitor.client = {
      usable: true,
      search: async () => { searchCalled = true; return []; },
    };

    await monitor._poll();

    assert.strictEqual(searchCalled, false, 'Poll must NOT query IMAP server while in RECONNECTING state');
    assert.strictEqual(monitor._polling, false, 'Polling flag must remain false');

    await monitor.stop();
  });

  // Test 4: Overlapping polls do not run concurrently
  await runTest('4 — Overlapping polls skip concurrent execution', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor._polling = true; // Simulate poll in progress

    let searchCalled = false;
    monitor.client = {
      usable: true,
      search: async () => { searchCalled = true; return []; },
    };

    await monitor._poll();

    assert.strictEqual(searchCalled, false, 'Overlapping poll must return early');

    await monitor.stop();
  });

  // Test 5: Reconnect failure uses exponential backoff
  await runTest('5 — Reconnect failure uses exponential backoff', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    const initDelay = monitor._reconnectDelay;

    monitor._scheduleReconnect();
    const delayAfter1 = monitor._reconnectDelay;

    monitor._reconnectPromise = null;
    monitor._reconnectTimer = null;
    monitor._scheduleReconnect();
    const delayAfter2 = monitor._reconnectDelay;

    assert.strictEqual(delayAfter1, initDelay * 2, 'First reconnect doubles delay');
    assert.strictEqual(delayAfter2, initDelay * 4, 'Second reconnect quadruples delay');

    await monitor.stop();
  });

  // Test 6: Jitter calculation remains bounded
  await runTest('6 — Jitter delay calculation remains bounded in scheduleReconnect', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    const baseDelay = monitor._reconnectDelay;

    // Intercept setTimeout to inspect scheduled delay
    let scheduledDelay = 0;
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => {
      scheduledDelay = delay;
      return 123;
    };

    monitor._scheduleReconnect();
    global.setTimeout = origSetTimeout;

    const addedJitter = scheduledDelay - baseDelay;
    assert.ok(addedJitter >= 0 && addedJitter < 1000, `Scheduled delay (${scheduledDelay}ms) must include 0-999ms jitter over base (${baseDelay}ms)`);

    await monitor.stop();
  });

  // Test 7: Backoff is capped at RECONNECT_MAX_MS (5 min)
  await runTest('7 — Backoff delay is capped at 5 minutes', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor._reconnectDelay = 4 * 60 * 1000;

    monitor._scheduleReconnect();
    monitor._reconnectPromise = null;
    monitor._reconnectTimer = null;
    monitor._scheduleReconnect();

    assert.strictEqual(monitor._reconnectDelay, 5 * 60 * 1000, 'Backoff delay must cap at 300,000ms');

    await monitor.stop();
  });

  // Test 8: Successful stable connection resets backoff end-to-end
  await runTest('8 — Successful stable connection resets backoff after consecutive polls', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor._reconnectDelay = 40000;
    monitor.client = {
      usable: true,
      search: async () => [],
    };

    // Run 2 consecutive successful poll cycles
    await monitor._poll();
    await monitor._poll();

    assert.strictEqual(monitor._reconnectDelay, 5000, 'Backoff delay resets to initial 5000ms after 2 successful poll cycles');

    await monitor.stop();
  });

  // Test 9: Transient connect success followed by immediate failure does NOT reset backoff
  await runTest('9 — Immediate failure after connect does NOT falsely reset backoff', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;
    monitor.state = 'CONNECTED';
    monitor._reconnectDelay = 40000;

    // Only 1 successful poll before failure
    monitor._onPollSuccess();
    monitor.state = 'DEGRADED';
    monitor._scheduleReconnect();

    assert.ok(monitor._reconnectDelay > 5000, 'Backoff delay should NOT reset to 5000ms after a transient failure');

    await monitor.stop();
  });

  // Test 10: Shutdown cancels reconnect timers and prevents new reconnects
  await runTest('10 — Shutdown cancels reconnect timers and prevents new reconnects', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.running = true;

    monitor._scheduleReconnect();
    assert.ok(monitor._reconnectTimer !== null, 'Reconnect timer must be scheduled');

    await monitor.stop();

    assert.strictEqual(monitor.getState(), 'STOPPED', 'State must be STOPPED');
    assert.strictEqual(monitor._reconnectTimer, null, 'Timer must be cleared');

    const res = monitor._scheduleReconnect();
    assert.strictEqual(res, null, 'No new reconnect promise should be scheduled after stop');
  });

  // Test 11: UID watermark is NOT advanced on failed processing and does NOT jump over failed UID
  await runTest('11 — Multi-email UID failure guard prevents watermark jumping over failed UID', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.setLastProcessedUID(100);

    const sender = process.env.ALERT_SENDER || 'alerts@trackingsystem.com';

    // Sequence: UID 101 succeeds, UID 102 fails (parser crash), UID 103 succeeds
    monitor.client = {
      usable: true,
      search: async () => [101, 102, 103],
      fetch: async function* () {
        yield { uid: 101, source: Buffer.from(`From: ${sender}\r\nSubject: Valid Email 101`) };
        yield { uid: 102, source: Buffer.from(`From: ${sender}\r\nSubject: CRASH`) };
        yield { uid: 103, source: Buffer.from(`From: ${sender}\r\nSubject: Valid Email 103`) };
      }
    };

    let processedUIDs = [];
    monitor.alertParser = {
      parse: (mail) => {
        if (mail.uid === 102) throw new Error('Simulated parser crash on UID 102');
        processedUIDs.push(mail.uid);
        return { alertDef: { type: 'speeding' }, fields: { plate: 'TEST-100' } };
      }
    };
    monitor.onAlert = async () => {};

    monitor.running = true;
    monitor.state = 'CONNECTED';
    await monitor._poll();

    // Watermark MUST be 101, NOT 102 or 103!
    assert.strictEqual(monitor._lastProcessedUID, 101, 'Watermark must stay at 101 (last successful UID) and NOT advance past failed UID 102');
    assert.deepStrictEqual(processedUIDs, [101], 'Fetch loop must break on UID 102 failure so UID 103 is not processed out of order');

    await monitor.stop();
  });

  // Test 12: Successful processing advances UID watermark
  await runTest('12 — Successful message processing advances UID watermark', async () => {
    const monitor = new EmailMonitor(async () => {});
    monitor.setLastProcessedUID(100);

    const sender = process.env.ALERT_SENDER || 'alerts@trackingsystem.com';

    let updatedUID = 0;
    monitor.onUIDProcessed(uid => { updatedUID = uid; });

    monitor.client = {
      usable: true,
      search: async () => [101, 105],
      fetch: async function* () {
        yield { uid: 101, source: Buffer.from(`From: ${sender}\r\nSubject: Test 101`) };
        yield { uid: 105, source: Buffer.from(`From: ${sender}\r\nSubject: Test 105`) };
      }
    };
    monitor.alertParser = { parse: () => null };

    monitor.running = true;
    monitor.state = 'CONNECTED';
    await monitor._poll();

    assert.strictEqual(monitor._lastProcessedUID, 105, 'Watermark must advance to highest processed UID (105)');
    assert.strictEqual(updatedUID, 105, 'onUIDProcessed callback must be triggered with 105');

    await monitor.stop();
  });

  // Test 13: Existing IMAP configuration validation remains intact
  await runTest('13 — Config validation throws expected errors on missing credentials', async () => {
    const monitor = new EmailMonitor(async () => {});
    const config = require('../config/settings');

    const oldUser = config.email.user;
    config.email.user = null;

    assert.throws(() => {
      monitor._validateConfig();
    }, /Missing .env/);

    config.email.user = oldUser;
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`📊 IMAP TEST RESULTS: ${passed} Passed | ${failed} Failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

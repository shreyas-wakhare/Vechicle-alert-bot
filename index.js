/**
 * Vehicle Alert Bot — Entry Point v6
 */

require('dotenv').config();

const WhatsAppBot      = require('./services/whatsappBot');
const EmailMonitor     = require('./services/emailMonitor');
const HistoryStore     = require('./services/historyStore');
const HealthMonitor    = require('./services/healthMonitor');
const DailySummary     = require('./services/dailySummary');
const BatteryMonitor   = require('./services/batteryMonitor');
const FleetAlertBatcher = require('./services/fleetAlertBatcher');
const ServerLifecycleManager = require('./services/serverLifecycleManager');
const DowntimeSummaryService = require('./services/downtimeSummaryService');
const MessageFormatter     = require('./services/messageFormatter');
const AIExecutiveSynthesis = require('./services/aiExecutiveSynthesis');
const config           = require('./config/settings');
const logger           = require('./utils/logger');

process.on('uncaughtException',  (err) => logger.fatal('Uncaught exception:',  err.message, err.stack));
process.on('unhandledRejection', (err) => logger.fatal('Unhandled rejection:', err?.stack || err?.message || err));

const fs   = require('fs');
const path = require('path');

const LOCK_FILE = path.join(process.cwd(), 'data', 'app.lock');

function acquireInstanceLock() {
  try {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (existingPid && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          logger.fatal(`Startup blocked: Another instance of Vehicle Alert Bot is already running (PID ${existingPid}).`);
          process.exit(1);
        } catch {
          logger.warn(`Removing stale instance lock file from PID ${existingPid}`);
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    const cleanup = () => {
      try { if (activeLifecycleManager) activeLifecycleManager.recordShutdown(); } catch {}
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch (err) {
    logger.warn(`Instance lock check warning: ${err?.message || err}`);
  }
}

let activeLifecycleManager = null;

const formatter = new MessageFormatter();
const aiSynthesisEngine = new AIExecutiveSynthesis();

async function main() {
  acquireInstanceLock();
  logger.banner('Vehicle Alert Bot v6 — Starting Up');

  const history  = new HistoryStore();
  const whatsapp = new WhatsAppBot();
  whatsapp.setHistoryStore(history);
  await whatsapp.initialize();

  const lifecycleManager = new ServerLifecycleManager();
  activeLifecycleManager = lifecycleManager;
  const downtimeSummaryService = new DowntimeSummaryService(history, whatsapp);

  const fleetBatcher = new FleetAlertBatcher(history, whatsapp, {
    intervalMinutes: config.alertReportIntervalMinutes || 30,
  });

  const emailMonitor = new EmailMonitor(async ({ alertDef, fields, context }, mail) => {
    const plate   = fields.plate?.toUpperCase();
    const offTime = fields.alertTime || mail?.date?.toISOString();

    const alertTimestamp = new Date(fields.alertTime || mail?.date || Date.now());
    const isDowntimeBacklog = lifecycleManager.startupTime && alertTimestamp.getTime() < lifecycleManager.startupTime.getTime();

    if (isDowntimeBacklog) {
      // Historical event that occurred during downtime (< startupTime).
      // Recorded in HistoryStore, but suppresses immediate messages and batch buffer.
      if (alertDef.type === 'ignition_on') {
        history.recordIgnitionOn(plate, offTime, fields.address, fields.mapsUrl || fields.trackUrl);
        history.record(alertDef, fields, mail);
        return;
      }
      if (alertDef.type === 'ignition_off') {
        const onData = plate ? history.getLastIgnitionOn(plate) : null;
        let durationMs = 0;
        if (onData?.time) {
          try { durationMs = new Date(offTime) - new Date(onData.time); } catch {}
        }
        if (history.isTripsEnabled()) {
          history.recordTrip({
            plate, vehicleModel: fields.vehicleModel, driver: fields.driver,
            startTime: onData?.time, startAddress: onData?.address, startMapsUrl: onData?.mapsUrl,
            endTime: offTime, endAddress: fields.address, endMapsUrl: fields.mapsUrl, durationMs,
          });
        }
        history.record(alertDef, fields, mail);
        history.recordIgnitionOff(plate, offTime);
        if (plate) history.clearIgnitionOn(plate);
        return;
      }

      history.record(alertDef, fields, mail);

      // If downtime was <= 30m, buffer this offline alert into the next normal batch report!
      if (!lifecycleManager.isDowntimeSummaryRequired()) {
        const isCriticalType = alertDef.type === 'sos' || alertDef.type === 'accident' || alertDef.type === 'engine_failure' || alertDef.severity === 'CRITICAL';
        fleetBatcher.addRecoveredEvent({
          alertDef,
          fields,
          timestamp: alertTimestamp,
          isCritical: isCriticalType,
        });
      }
      return;
    }

    if (context) {
      const w15 = context.recentActivity?.windows?.['15m'];
      const intel = context.contextIntelligence;
      logger.info(
        `   ↳ 🧬 [EventContext] ID: ${context.eventId} | Type: ${context.alertType} | Plate: ${context.vehicle?.plate || '?'}` +
        ` | 15m events: ${w15?.totalEvents || 0} | Intelligence Signals: ${intel?.summary?.signalCount || 0} (${intel?.summary?.highestLevel || 'NONE'})`
      );
      if (intel?.signals?.length > 0) {
        logger.info(`   ↳ 💡 [ContextIntelligence] Signals: ${intel.signals.map(s => `${s.code}[${s.level}]`).join(', ')}`);
      }
      if (context.alertCorrelation) {
        const corr = context.alertCorrelation;
        logger.info(
          `   ↳ 🔗 [AlertCorrelation] ID: ${corr.correlationId} | Status: ${corr.status}` +
          ` | Count: ${corr.eventCount} | Duration: ${Math.round(corr.durationMs / 1000)}s | Types: [${corr.eventTypes.join(', ')}]`
        );
        if (corr.incident && corr.incident.type !== 'NONE') {
          const inc = corr.incident;
          const intel = inc.intelligence;
          logger.info(
            `   ↳ 🚗 [IncidentGrouping] Type: ${inc.type} (${inc.label}) | IsIncident: ${inc.isIncident}` +
            ` | Rule: ${inc.ruleId} | Matched: [${inc.matchedEvents.join(', ')}]` +
            (intel ? ` | Status: ${intel.status} | Cat: ${intel.interpretation?.operationalCategory} | Attn: ${intel.interpretation?.recommendedAttention} | Cont: ${intel.continuation?.isContinuation} | Esc: ${intel.escalation?.detected} | Seq: [${intel.sequence.join(' → ')}]` : '')
          );
        }
      }
    }

    // ── IGNITION ON ────────────────────────────────────────────────────────
    if (alertDef.type === 'ignition_on') {
      history.recordIgnitionOn(plate, offTime, fields.address, fields.mapsUrl || fields.trackUrl);
      history.record(alertDef, fields, mail);
      return;
    }

    // ── IGNITION OFF ───────────────────────────────────────────────────────
    if (alertDef.type === 'ignition_off') {
      // Spurious check
      if (plate && history.isSpuriousOff(plate, offTime)) {
        history.record(alertDef, fields, mail);
        return;
      }

      const onData = plate ? history.getLastIgnitionOn(plate) : null;
      let durationMs = 0, durationStr = null;

      if (onData?.time) {
        try {
          durationMs  = new Date(offTime) - new Date(onData.time);
          if (durationMs > 0) durationStr = _fmtDur(durationMs);
        } catch {}
      }

      // Validate and record trip
      let tripOk = false;
      if (history.isTripsEnabled()) {
        const { recorded, reason } = history.recordTrip({
          plate, vehicleModel: fields.vehicleModel, driver: fields.driver,
          startTime:    onData?.time,
          startAddress: onData?.address,
          startMapsUrl: onData?.mapsUrl,
          endTime:      offTime,
          endAddress:   fields.address,
          endMapsUrl:   fields.mapsUrl,
          durationMs,
        });
        tripOk = recorded && reason === 'ok';

        if (reason === 'no_start') {
          logger.warn(`   ↳ Orphan ignition OFF for ${plate} — no matching ON. No trip card sent.`);
          history.record(alertDef, fields, mail);
          history.recordIgnitionOff(plate, offTime);
          return;
        }

        if (reason === 'too_short') {
          history.record(alertDef, fields, mail);
          history.recordIgnitionOff(plate, offTime);
          if (plate) history.clearIgnitionOn(plate);
          return;
        }

        if (reason === 'invalid_long') {
          // Send trip card but with a warning
          durationStr = `⚠️ ${durationStr} (unverified — possible missed alert)`;
        }
      }

      history.record(alertDef, fields, mail);
      history.recordIgnitionOff(plate, offTime);
      if (plate) history.clearIgnitionOn(plate);

      if (history.isMuted('ignition_off')) return;

      // DO NOT send immediate WhatsApp message for ignition_off!
      // Valid trips are persisted in HistoryStore and represented in the 30-min summary (🛣️ Completed trips: X).
      logger.info(`   ↳ 🔒 [Ignition OFF] Trip recorded for ${plate || '?'} — aggregated into 30-min summary (no immediate WhatsApp card)`);
      return;
    }

    // ── ALL OTHER ALERTS ───────────────────────────────────────────────────
    history.record(alertDef, fields, mail);

    if (history.isMuted(alertDef.type)) {
      logger.info(`   ↳ "${alertDef.label}" muted — stored only`);
      return;
    }

    const { text, criticalLevel } = formatter.format(alertDef, fields);

    // Critical operational alerts (sos, accident, engine_failure or criticalLevel >= 3) MUST NOT wait for AI
    const isCriticalType = alertDef.type === 'sos' || alertDef.type === 'accident' || alertDef.type === 'engine_failure' || criticalLevel >= 3;

    if (isCriticalType) {
      // 🚨 CRITICAL ALERT ROUTING — IMMEDIATE WHATSAPP GROUP & PERSONAL DMS
      logger.info(`   ↳ 🚨 [Critical Alert Routing] Dispatching immediate alert: ${alertDef.label} for ${plate || '?'}`);
      await whatsapp.sendToGroup(text);

      if (criticalLevel >= 3) {
        const sev    = '🔴'.repeat(criticalLevel);
        const dmText =
          `⚠️ *HIGH SEVERITY ALERT — ${sev}*\n` +
          `${alertDef.emoji} ${alertDef.label}\n🚗 ${plate || '?'} ${fields.vehicleModel || ''}\n\n` +
          text.split('\n').slice(0, 10).join('\n');
        await whatsapp.sendCriticalDMs(dmText);
      }

      // Critical alerts are delivered immediately and MUST NOT enter the 30-minute non-critical batcher
      return;
    }

    // 🟡 NON-CRITICAL ALERT ROUTING — 30-MINUTE BATCHING BUFFER
    if (context) {
      try {
        const aiPromise = aiSynthesisEngine.synthesize(context, mail);
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 1000));
        
        // Race AI synthesis against a 1000ms budget for standard alerts
        const synthesisResult = await Promise.race([aiPromise, timeoutPromise]);
        if (synthesisResult) {
          context.aiSynthesis = synthesisResult;
        } else {
          logger.warn(`AI synthesis timed out (>1000ms); falling back to deterministic alert`);
          // Ensure late AI promise resolution/rejection is safely caught
          aiPromise.catch(aiErr => logger.warn(`Late AI synthesis exception: ${aiErr?.message || aiErr}`));
        }
      } catch (aiErr) {
        logger.warn(`AI executive synthesis exception: ${aiErr?.message || aiErr}`);
      }
    }

    // Buffer non-critical alert — DO NOT send individual WhatsApp message!
    fleetBatcher.addEvent({ alertDef, fields, context, mail, isCritical: false });
  });

  emailMonitor.alertParser.setHistoryStore(history);
  emailMonitor.setLastProcessedUID(history.getLastProcessedUID());
  emailMonitor.onUIDProcessed((uid) => history.setLastProcessedUID(uid));

  whatsapp.onReady(async () => {
    logger.success('WhatsApp ready — checking server lifecycle & starting email monitor');

    // 1. Initialize server lifecycle and determine if downtime exceeded 30m
    const { offlineStart, startupTime, durationMs, requiresDowntimeSummary } = lifecycleManager.init();

    // 2. Ingest unread backlog emails (events with alertTime < startupTime are marked as backlog)
    await emailMonitor.start();

    // 3. If offline downtime exceeded 30 minutes, send exactly ONE Server Downtime Summary
    if (requiresDowntimeSummary) {
      logger.banner(`Server Downtime Detected: ${lifecycleManager._fmtDur(durationMs)} — Generating Recovery Summary`);
      try {
        await downtimeSummaryService.sendSummary({ offlineStart, startupTime, durationMs });
        lifecycleManager.markDowntimeReported(offlineStart, startupTime);
      } catch (err) {
        logger.error(`Downtime summary dispatch error: ${err.message}`);
      }
    }

    // 4. Start heartbeat and operational monitors
    lifecycleManager.startHeartbeat();
    new HealthMonitor(emailMonitor, whatsapp, history).start();
    new DailySummary(history, whatsapp).start();
    const batteryMonitor = new BatteryMonitor(history, whatsapp, { batcher: fleetBatcher });
    fleetBatcher.setBatteryMonitor(batteryMonitor);
    batteryMonitor.start();
    fleetBatcher.start({
      offlineStart,
      startupTime,
      isDowntimeReported: requiresDowntimeSummary,
    });
    logger.banner('All systems operational ✅');
  });
}

function _fmtDur(ms) {
  if (!ms || ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

main().catch((err) => {
  logger.fatal('Startup failed:', err.message, err.stack);
  process.exit(1);
});

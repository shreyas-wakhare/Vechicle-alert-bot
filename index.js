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
const MessageFormatter = require('./services/messageFormatter');
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
    const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch (err) {
    logger.warn(`Instance lock check warning: ${err?.message || err}`);
  }
}

const formatter = new MessageFormatter();

async function main() {
  acquireInstanceLock();
  logger.banner('Vehicle Alert Bot v6 — Starting Up');

  const history  = new HistoryStore();
  const whatsapp = new WhatsAppBot();
  whatsapp.setHistoryStore(history);
  await whatsapp.initialize();

  const emailMonitor = new EmailMonitor(async ({ alertDef, fields, context }, mail) => {
    const plate   = fields.plate?.toUpperCase();
    const offTime = fields.alertTime || mail?.date?.toISOString();

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

      const { text } = formatter.formatTripComplete({
        ...fields,
        tripStartTime:    onData?.time,
        tripStartAddress: onData?.address,
        tripStartMapsUrl: onData?.mapsUrl,
        tripDuration:     durationStr,
      });
      await whatsapp.sendToGroup(text);
      return;
    }

    // ── ALL OTHER ALERTS ───────────────────────────────────────────────────
    history.record(alertDef, fields, mail);

    if (history.isMuted(alertDef.type)) {
      logger.info(`   ↳ "${alertDef.label}" muted — stored only`);
      return;
    }

    const { text, criticalLevel } = formatter.format(alertDef, fields);
    await whatsapp.sendToGroup(text);

    if (criticalLevel >= 3) {
      const sev    = '🔴'.repeat(criticalLevel);
      const dmText =
        `⚠️ *HIGH SEVERITY ALERT — ${sev}*\n` +
        `${alertDef.emoji} ${alertDef.label}\n🚗 ${plate || '?'} ${fields.vehicleModel || ''}\n\n` +
        text.split('\n').slice(0, 10).join('\n');
      await whatsapp.sendCriticalDMs(dmText);
    }
  });

  emailMonitor.alertParser.setHistoryStore(history);
  emailMonitor.setLastProcessedUID(history.getLastProcessedUID());
  emailMonitor.onUIDProcessed((uid) => history.setLastProcessedUID(uid));

  whatsapp.onReady(async () => {
    logger.success('WhatsApp ready — starting email monitor');
    await emailMonitor.start();
    new HealthMonitor(emailMonitor, whatsapp, history).start();
    new DailySummary(history, whatsapp).start();
    new BatteryMonitor(history, whatsapp).start();
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

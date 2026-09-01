/**
 * services/batteryMonitor.js
 *
 * Checks every hour for vehicles that have had NO ignition activity in 24h.
 * Sends a WhatsApp group alert with a battery depletion warning.
 *
 * "No activity" = no ignition ON, no ignition OFF, no completed trip in 24h.
 * Only fires for vehicles we've seen at least once (known fleet).
 * Sends once per vehicle per day (tracked by plate + date key).
 */

const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = 60 * 60_000;   // every 1 hour
const INACTIVE_THRESHOLD_MS = 24 * 3_600_000;
const TIMEZONE = 'Asia/Dubai';

class BatteryMonitor {
  constructor(history, whatsapp) {
    this.history  = history;
    this.whatsapp = whatsapp;
    this._sentToday = new Set();  // "plate-YYYY-MM-DD" keys
    this._timer = null;
  }

  start() {
    logger.info('Battery monitor started — checking every 1h for inactive vehicles');
    // Run first check after 5 min (let system stabilise after boot)
    setTimeout(() => this._check(), 5 * 60_000);
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() { clearInterval(this._timer); }

  async _check() {
    const now       = Date.now();
    const plates    = this.history.allPlates();
    const dateKey   = this._dubaiDateKey();

    logger.info(`Battery check — ${plates.length} vehicles to check`);

    for (const plate of plates) {
      const lastActivity = this.history.lastIgnitionActivity(plate);
      if (!lastActivity) continue;

      const inactiveMs = now - lastActivity;
      if (inactiveMs < INACTIVE_THRESHOLD_MS) continue;

      const sentKey = `${plate}-${dateKey}`;
      if (this._sentToday.has(sentKey)) continue;

      // Vehicle has been inactive for 24h+ — alert
      this._sentToday.add(sentKey);
      const inactiveHours = Math.round(inactiveMs / 3_600_000);
      const lastSeen = new Date(lastActivity).toLocaleString('en-GB', {
        timeZone: TIMEZONE, day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });

      const msg =
        `🔋 *BATTERY DEPLETION WARNING*\n\n` +
        `🚗 *Vehicle:* ${plate}\n` +
        `⏱️  *Inactive for:* ${inactiveHours}h\n` +
        `🕐 *Last activity:* ${lastSeen}\n\n` +
        `⚠️ *Suggestion:* Start the vehicle and run for at least *15 minutes* ` +
        `to recharge the battery and prevent depletion.\n\n` +
        `─────────────────`;

      await this.whatsapp.sendToGroup(msg);
      logger.warn(`Battery warning sent for ${plate} (inactive ${inactiveHours}h)`);
    }

    // Clear the sent-today set at midnight Dubai time
    const todayKey = this._dubaiDateKey();
    if (this._lastDate && this._lastDate !== todayKey) {
      this._sentToday.clear();
      logger.info('Battery monitor: new day — alert history cleared');
    }
    this._lastDate = todayKey;
  }

  _dubaiDateKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // "YYYY-MM-DD"
  }
}

module.exports = BatteryMonitor;

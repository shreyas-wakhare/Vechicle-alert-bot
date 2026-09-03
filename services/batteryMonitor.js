/**
 * services/batteryMonitor.js
 *
 * Checks every hour for vehicles that have had NO ignition activity in >=24h.
 * Uses a durable, state-based lifecycle persisted in data/battery_state.json:
 *
 * ACTIVE
 *   ↓ (>= 24 hours of inactivity crossed)
 * INACTIVE_RISK (reported: false)
 *   ↓ (queued for 30-min Fleet Summary)
 * REPORTED (reported: true)
 *   ↓ (vehicle remains inactive)
 * SILENT (no repeated reports, no spam)
 *   ↓ (new ignition activity detected)
 * ACTIVE (state reset, 0 WhatsApp messages)
 *   ↓ (>= 24 hours of inactivity crossed again)
 * NEW INACTIVITY RISK (reported: false) -> reported once again
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = 60 * 60_000;   // every 1 hour
const INACTIVE_THRESHOLD_MS = 24 * 3_600_000;
const TIMEZONE = 'Asia/Dubai';

class BatteryMonitor {
  constructor(history, whatsapp, options = {}) {
    this.history  = history;
    this.whatsapp = whatsapp;
    this.batcher  = options.batcher || null;
    this._persist = options.persist !== false;
    this._stateFile = options.stateFile || path.join(process.cwd(), 'data', 'battery_state.json');
    this._state = { vehicles: {}, updatedAt: null };
    this._timer = null;

    this._loadState();
  }

  _loadState() {
    if (!this._persist) return;
    try {
      if (fs.existsSync(this._stateFile)) {
        const raw = fs.readFileSync(this._stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.vehicles === 'object') {
          this._state = parsed;
        }
      }
    } catch (err) {
      logger.warn(`BatteryMonitor: could not load state from ${this._stateFile}: ${err.message}`);
    }
  }

  _saveState() {
    if (!this._persist) return;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      this._state.updatedAt = new Date().toISOString();
      fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`BatteryMonitor: could not save state to ${this._stateFile}: ${err.message}`);
    }
  }

  setBatcher(batcher) {
    this.batcher = batcher;
  }

  start() {
    logger.info('Battery monitor started — checking every 1h for inactive vehicles');
    // Run first check after 5 min (let system stabilise after boot)
    setTimeout(() => this._check(), 5 * 60_000);
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Marks a vehicle's current inactivity episode as reported in the 30-min Fleet Summary.
   * Persisted to disk to ensure it survives server restarts.
   *
   * @param {string} plate
   * @param {string} [reportedAt]
   */
  markReported(plate, reportedAt = new Date().toISOString()) {
    if (!plate) return;
    const norm = plate.toUpperCase();
    if (!this._state.vehicles[norm]) {
      this._state.vehicles[norm] = {
        status: 'INACTIVE_RISK',
        reported: true,
        reportedAt,
      };
    } else {
      this._state.vehicles[norm].reported = true;
      this._state.vehicles[norm].reportedAt = reportedAt;
    }
    this._saveState();
    logger.info(`BatteryMonitor: marked ${norm} as reported for current inactivity episode`);
  }

  /**
   * Checks all known fleet vehicles for inactivity transitions.
   */
  async _check(now = Date.now()) {
    const plates = this.history.allPlates();

    logger.info(`Battery check — ${plates.length} vehicles to check`);

    let stateChanged = false;

    for (const plate of plates) {
      const norm = plate.toUpperCase();
      const lastActivity = this.history.lastIgnitionActivity(plate);
      if (!lastActivity) continue;

      const inactiveMs = now - lastActivity;
      const isPastThreshold = inactiveMs >= INACTIVE_THRESHOLD_MS;
      const vState = this._state.vehicles[norm];

      if (!isPastThreshold) {
        // Vehicle is ACTIVE (<24h since last activity)
        if (vState && vState.status === 'INACTIVE_RISK') {
          // Inactivity episode resolved! Transition to ACTIVE
          this._state.vehicles[norm] = {
            status: 'ACTIVE',
            lastActivityAt: lastActivity,
            reported: false,
            resolvedAt: new Date().toISOString(),
          };
          stateChanged = true;
          logger.info(`BatteryMonitor: vehicle ${norm} is now ACTIVE (activity detected) — inactivity risk resolved`);
        }
        continue;
      }

      // Inactivity is >= 24h
      const inactiveHours = Math.round(inactiveMs / 3_600_000);
      const lastSeen = new Date(lastActivity).toLocaleString('en-GB', {
        timeZone: TIMEZONE, day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });

      // Check if this is a NEW inactivity episode or an existing one
      const isNewEpisode = !vState || vState.status === 'ACTIVE' || vState.lastActivityAt !== lastActivity;

      if (isNewEpisode) {
        // New inactivity episode!
        this._state.vehicles[norm] = {
          status: 'INACTIVE_RISK',
          lastActivityAt: lastActivity,
          thresholdCrossedAt: lastActivity + INACTIVE_THRESHOLD_MS,
          reported: false,
          detectedAt: now,
          inactiveHours,
        };
        stateChanged = true;

        if (this.batcher && typeof this.batcher.addBatteryWarning === 'function') {
          this.batcher.addBatteryWarning({
            plate: norm,
            inactiveHours,
            lastSeen,
            detectedAt: now,
            lastActivity,
          });
        }
        logger.info(`Battery warning queued for ${norm} (inactive ${inactiveHours}h) -> FleetAlertBatcher`);
      } else {
        // Existing episode for this vehicle (lastActivityAt matches)
        if (vState.reported) {
          // SILENT — vehicle remains inactive, already reported in Fleet Summary
          logger.debug(`BatteryMonitor: vehicle ${norm} remains inactive (${inactiveHours}h) — already reported, silent`);
        } else {
          // Not yet reported (e.g. restart occurred before batch window flushed)
          if (this.batcher && typeof this.batcher.addBatteryWarning === 'function') {
            this.batcher.addBatteryWarning({
              plate: norm,
              inactiveHours,
              lastSeen,
              detectedAt: vState.detectedAt || now,
              lastActivity,
            });
          }
          logger.info(`Battery warning re-queued for ${norm} (pending report, ${inactiveHours}h inactive) -> FleetAlertBatcher`);
        }
      }
    }

    if (stateChanged) {
      this._saveState();
    }
  }

  getVehicleState(plate) {
    if (!plate) return null;
    return this._state.vehicles[plate.toUpperCase()] || null;
  }
}

module.exports = BatteryMonitor;

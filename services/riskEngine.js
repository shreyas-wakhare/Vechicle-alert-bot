/**
 * services/riskEngine.js
 *
 * Feature #3: Dynamic Vehicle/Driver Risk — Phase 1 (Risk Foundation & Scoring)
 *
 * Provides a deterministic, explainable, production-safe dynamic risk scoring layer
 * on top of Feature #1 (Event Context) and Feature #2 (Alert Correlation & Incident Intelligence).
 *
 * Key Capabilities:
 * 1. Bounded Risk Scoring (0–100) with deterministic risk levels (LOW, MEDIUM, ELEVATED, HIGH, CRITICAL).
 * 2. Vehicle Risk State (vehicleKey = IMEI or normalized PLATE).
 * 3. Driver Risk State (driverKey = DRIVER:NAME, strictly scoped ONLY when reliable driver identity exists).
 * 4. 32-Alert Risk Domain Mapping (base impact, vehicle vs driver domain attribution).
 * 5. Feature #2 Intelligence Consumption (pattern multipliers for correlated incidents & escalations).
 * 6. Duplicate Event Protection (eventId deduplication per entity).
 * 7. Risk Recovery / Time Decay (deterministic linear score decay over clean time).
 * 8. Compact State Persistence (data/risk_state.json with automatic fallback).
 *
 * Strictly NO AI/LLM, NO Machine Learning, NO Predictive Analytics in Phase 1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STATE_FILE_PATH = path.join(__dirname, '../data/risk_state.json');
const DECAY_RATE_PER_MINUTE = 0.1; // ~6.0 points score decay per clean hour
const MAX_CONTRIBUTORS = 10;
const MAX_PROCESSED_EVENT_IDS = 100;

// ── 32-Alert Risk Domain Mapping Specification ────────────────────────────────
const ALERT_RISK_MAP = {
  // Driver Behavior Alerts
  speeding:            { baseImpact: 18, vehicleDomain: true,  driverDomain: true  },
  harsh_acceleration:  { baseImpact: 10, vehicleDomain: true,  driverDomain: true  },
  harsh_braking:       { baseImpact: 10, vehicleDomain: true,  driverDomain: true  },
  distraction:         { baseImpact: 18, vehicleDomain: true,  driverDomain: true  },
  vibration:           { baseImpact: 8,  vehicleDomain: true,  driverDomain: true  },
  fatigue:             { baseImpact: 20, vehicleDomain: true,  driverDomain: true  },
  smoking:             { baseImpact: 8,  vehicleDomain: true,  driverDomain: true  },
  seatbelt:            { baseImpact: 15, vehicleDomain: true,  driverDomain: true  },
  drinking:            { baseImpact: 25, vehicleDomain: true,  driverDomain: true  },
  lane_change:         { baseImpact: 10, vehicleDomain: true,  driverDomain: true  },
  ubi_acceleration:    { baseImpact: 10, vehicleDomain: true,  driverDomain: true  },
  ubi_deceleration:    { baseImpact: 10, vehicleDomain: true,  driverDomain: true  },
  driver_change:       { baseImpact: 5,  vehicleDomain: true,  driverDomain: true  },
  idle:                { baseImpact: 3,  vehicleDomain: true,  driverDomain: false },
  voice_alarm:         { baseImpact: 8,  vehicleDomain: true,  driverDomain: true  },

  // Safety Incidents
  accident:            { baseImpact: 45, vehicleDomain: true,  driverDomain: true  },
  sos:                 { baseImpact: 45, vehicleDomain: true,  driverDomain: true  },

  // Device & Hardware Security
  tampering:           { baseImpact: 20, vehicleDomain: true,  driverDomain: false },
  camera_blocked:      { baseImpact: 18, vehicleDomain: true,  driverDomain: false },
  low_battery:         { baseImpact: 10, vehicleDomain: true,  driverDomain: false },

  // Connectivity
  gps_lost:            { baseImpact: 15, vehicleDomain: true,  driverDomain: false },
  lte_jamming:         { baseImpact: 15, vehicleDomain: true,  driverDomain: false },
  offline:             { baseImpact: 10, vehicleDomain: true,  driverDomain: false },
  gps_restored:        { baseImpact: -5, vehicleDomain: true,  driverDomain: false },
  lte_restored:        { baseImpact: -5, vehicleDomain: true,  driverDomain: false },

  // Vehicle Operation
  engine_failure:      { baseImpact: 40, vehicleDomain: true,  driverDomain: false },
  fuel_drop:           { baseImpact: 18, vehicleDomain: true,  driverDomain: false },
  ignition_on:         { baseImpact: 1,  vehicleDomain: true,  driverDomain: false },
  ignition_off:        { baseImpact: 0,  vehicleDomain: true,  driverDomain: false },

  // Geolocation
  geofence_exit:       { baseImpact: 15, vehicleDomain: true,  driverDomain: false },
  geofence_enter:      { baseImpact: 2,  vehicleDomain: true,  driverDomain: false },

  // Fallback
  unknown:             { baseImpact: 8,  vehicleDomain: true,  driverDomain: true  },
};

class RiskEngine {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.persist=true] - Whether to load/save state to disk
   */
  constructor(options = {}) {
    this.persist = options.persist !== false;
    this.vehicles = new Map(); // vehicleKey -> EntityState
    this.drivers = new Map();  // driverKey -> EntityState

    if (this.persist) {
      this._loadState();
    }
  }

  /**
   * Derives a normalized vehicle key compatible with RecentActivityEngine & AlertCorrelationEngine.
   * @param {Object} params
   * @param {string} [params.imei]
   * @param {string} [params.plate]
   * @returns {string} vehicleKey (e.g., 'IMEI:864201040123456' or 'PLATE:D31498')
   */
  deriveVehicleKey({ imei, plate } = {}) {
    if (imei && String(imei).trim()) {
      return `IMEI:${String(imei).trim()}`;
    }
    if (plate && String(plate).trim()) {
      const norm = String(plate).toUpperCase().replace(/[\s\/\-]/g, '');
      if (norm) return `PLATE:${norm}`;
    }
    return 'UNKNOWN';
  }

  /**
   * Derives a normalized driver key ONLY when a reliable, non-empty driver identity string exists.
   * Returns null if driver string is missing/empty/invalid.
   * @param {string} [driver]
   * @returns {string|null} driverKey (e.g., 'DRIVER:AHMED') or null
   */
  deriveDriverKey(driver) {
    if (!driver || typeof driver !== 'string') return null;
    const trimmed = driver.trim();
    if (!trimmed || trimmed.toUpperCase() === 'UNKNOWN' || trimmed.toUpperCase() === 'NONE') return null;
    const norm = trimmed.toUpperCase().replace(/[\s\/\-]/g, '_');
    return norm ? `DRIVER:${norm}` : null;
  }

  /**
   * Evaluates an EventContext object and updates vehicle and driver risk states.
   *
   * @param {Object} context - Feature #1 EventContext object
   * @returns {Object} Structured risk evaluation result
   */
  evaluate(context) {
    if (!context || typeof context !== 'object') {
      return this._buildDefaultRiskResult();
    }

    try {
      const alertType = context.alertType || 'unknown';
      const timestamp = context.timestamp || null;
      const currentMs = _parseTimestamp(timestamp);
      const safeTimeKey = timestamp && !isNaN(new Date(timestamp).getTime())
        ? String(new Date(timestamp).getTime())
        : '0';
      const eventId = context.eventId || `EVT-${alertType}-${safeTimeKey}`;

      const vehicleKey = this.deriveVehicleKey({
        imei: context.vehicle?.imei,
        plate: context.vehicle?.plate,
      });

      const driverKey = this.deriveDriverKey(context.vehicle?.driver);

      // Extract Feature #2 Pattern & Escalation Multipliers
      const corr = context.alertCorrelation || {};
      const inc = corr.incident || {};
      const intel = inc.intelligence || {};

      const isCorrelatedPattern = Boolean(inc.isIncident || (corr.isCorrelated && corr.eventCount > 1));
      const isEscalated = Boolean(intel.escalation?.detected);

      let patternMultiplier = 1.0;
      if (isCorrelatedPattern) patternMultiplier *= 1.35;
      if (isEscalated) patternMultiplier *= 1.25;

      const mapping = ALERT_RISK_MAP[alertType] || ALERT_RISK_MAP['unknown'];

      const timestampStr = timestamp || new Date(currentMs).toISOString();

      // ── 1. Vehicle Risk Update ─────────────────────────────────────────────
      let vehicleRiskOutput = null;
      if (vehicleKey && vehicleKey !== 'UNKNOWN') {
        vehicleRiskOutput = this._updateEntityState(
          this.vehicles,
          'vehicle',
          vehicleKey,
          eventId,
          alertType,
          context.alertLabel || alertType,
          mapping.baseImpact,
          mapping.vehicleDomain,
          patternMultiplier,
          currentMs,
          timestampStr
        );
      }

      // ── 2. Driver Risk Update (Only when reliable driver identity exists) ──
      let driverRiskOutput = null;
      if (driverKey) {
        driverRiskOutput = this._updateEntityState(
          this.drivers,
          'driver',
          driverKey,
          eventId,
          alertType,
          context.alertLabel || alertType,
          mapping.baseImpact,
          mapping.driverDomain,
          patternMultiplier,
          currentMs,
          timestampStr
        );
      }

      if (this.persist) {
        this._saveState();
      }

      return {
        generatedAt: new Date().toISOString(),
        vehicleRisk: vehicleRiskOutput,
        driverRisk: driverRiskOutput,
      };

    } catch (err) {
      logger.error(`RiskEngine evaluation error: ${err?.message || err}`);
      return this._buildDefaultRiskResult();
    }
  }

  /**
   * Queries current risk object for a vehicleKey.
   * @param {string} vehicleKey
   * @returns {Object|null}
   */
  getVehicleRisk(vehicleKey) {
    if (!vehicleKey || !this.vehicles.has(vehicleKey)) return null;
    return this._formatEntityOutput('vehicle', vehicleKey, this.vehicles.get(vehicleKey), Date.now());
  }

  /**
   * Queries current risk object for a driverKey.
   * @param {string} driverKey
   * @returns {Object|null}
   */
  getDriverRisk(driverKey) {
    if (!driverKey || !this.drivers.has(driverKey)) return null;
    return this._formatEntityOutput('driver', driverKey, this.drivers.get(driverKey), Date.now());
  }

  /**
   * Resets internal memory state (useful for tests).
   */
  resetState() {
    this.vehicles.clear();
    this.drivers.clear();
    if (this.persist && fs.existsSync(STATE_FILE_PATH)) {
      try { fs.unlinkSync(STATE_FILE_PATH); } catch {}
    }
  }

  /**
   * Internal entity state update logic (decay + impact + duplicate protection).
   * @private
   */
  _updateEntityState(map, entityType, entityKey, eventId, alertType, alertLabel, baseImpact, isDomainApplicable, patternMultiplier, currentMs, timestampStr) {
    if (!map.has(entityKey)) {
      map.set(entityKey, {
        score: 0,
        lastUpdatedMs: currentMs,
        contributors: [],
        processedEventIds: [],
      });
    }

    const state = map.get(entityKey);

    // 1. Decay previous score based on clean time elapsed since last updated
    const elapsedMinutes = Math.max(0, (currentMs - state.lastUpdatedMs) / (60 * 1000));
    if (elapsedMinutes > 0 && state.score > 0) {
      const decayAmount = elapsedMinutes * DECAY_RATE_PER_MINUTE;
      state.score = Math.max(0, state.score - decayAmount);
    }
    state.lastUpdatedMs = currentMs;

    // Save previous score before applying new impact
    const previousScore = Math.round(state.score);

    // 2. Duplicate Protection check
    const isDuplicate = state.processedEventIds.includes(eventId);

    // 3. Compute Net Impact
    let netImpact = 0;
    if (!isDuplicate && isDomainApplicable) {
      if (baseImpact >= 0) {
        netImpact = Math.round(baseImpact * patternMultiplier);
      } else {
        netImpact = baseImpact; // Recovery alert (negative impact)
      }

      state.score = Math.min(100, Math.max(0, state.score + netImpact));

      // Track processed eventId (bounded array)
      state.processedEventIds.push(eventId);
      if (state.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
        state.processedEventIds.shift();
      }

      // Add to contributors list if impact is non-zero
      if (netImpact !== 0) {
        state.contributors.unshift({
          eventId,
          alertType,
          alertLabel,
          netImpact,
          timestamp: timestampStr,
        });
        if (state.contributors.length > MAX_CONTRIBUTORS) {
          state.contributors.pop();
        }
      }

      // Record snapshot history (bounded array max 20)
      if (!state.snapshots) state.snapshots = [];
      state.snapshots.unshift({
        eventId,
        alertType,
        alertLabel,
        netImpact,
        score: Math.round(state.score),
        previousScore,
        level: this.deriveRiskLevel(Math.round(state.score)),
        timestamp: timestampStr,
      });
      if (state.snapshots.length > 20) {
        state.snapshots.pop();
      }
    }

    return this._formatEntityOutput(entityType, entityKey, state, currentMs);
  }

  /**
   * Formats structured output for an entity state.
   * @private
   */
  _formatEntityOutput(entityType, entityKey, state, currentMs) {
    // Apply decay up to currentMs if querying
    const elapsedMinutes = Math.max(0, (currentMs - state.lastUpdatedMs) / (60 * 1000));
    let effectiveScore = Number.isFinite(state.score) ? state.score : 0;
    if (elapsedMinutes > 0 && effectiveScore > 0) {
      effectiveScore = Math.max(0, effectiveScore - (elapsedMinutes * DECAY_RATE_PER_MINUTE));
    }

    const safeScore = Number.isFinite(effectiveScore) ? effectiveScore : 0;
    const finalScore = Math.min(100, Math.max(0, Math.round(safeScore)));
    const level = this.deriveRiskLevel(finalScore);

    return {
      entityType,
      entityKey,
      score: finalScore,
      level,
      lastUpdated: new Date(state.lastUpdatedMs).toISOString(),
      contributors: state.contributors.map(c => ({ ...c })),
      snapshots: (state.snapshots || []).map(s => ({ ...s })),
    };
  }

  /**
   * Derives deterministic risk level string based on score.
   * @param {number} score
   * @returns {string} LOW | MEDIUM | ELEVATED | HIGH | CRITICAL
   */
  deriveRiskLevel(score) {
    if (score >= 90) return 'CRITICAL';
    if (score >= 70) return 'HIGH';
    if (score >= 45) return 'ELEVATED';
    if (score >= 20) return 'MEDIUM';
    return 'LOW';
  }

  _loadState() {
    if (!fs.existsSync(STATE_FILE_PATH)) return;
    try {
      const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      const json = JSON.parse(raw);

      if (json.vehicles && typeof json.vehicles === 'object') {
        for (const [k, v] of Object.entries(json.vehicles)) {
          this.vehicles.set(k, {
            score: typeof v.score === 'number' ? v.score : 0,
            lastUpdatedMs: _parseTimestamp(v.lastUpdated) || Date.now(),
            contributors: Array.isArray(v.contributors) ? v.contributors : [],
            processedEventIds: Array.isArray(v.processedEventIds) ? v.processedEventIds : [],
            snapshots: Array.isArray(v.snapshots) ? v.snapshots : [],
          });
        }
      }

      if (json.drivers && typeof json.drivers === 'object') {
        for (const [k, v] of Object.entries(json.drivers)) {
          this.drivers.set(k, {
            score: typeof v.score === 'number' ? v.score : 0,
            lastUpdatedMs: _parseTimestamp(v.lastUpdated) || Date.now(),
            contributors: Array.isArray(v.contributors) ? v.contributors : [],
            processedEventIds: Array.isArray(v.processedEventIds) ? v.processedEventIds : [],
            snapshots: Array.isArray(v.snapshots) ? v.snapshots : [],
          });
        }
      }
    } catch (err) {
      logger.warn(`RiskEngine loadState warning: ${err?.message || err}`);
    }
  }

  _saveState() {
    try {
      const vehiclesObj = {};
      for (const [k, v] of this.vehicles.entries()) {
        vehiclesObj[k] = {
          score: v.score,
          lastUpdated: new Date(v.lastUpdatedMs).toISOString(),
          contributors: v.contributors,
          processedEventIds: v.processedEventIds,
          snapshots: v.snapshots || [],
        };
      }

      const driversObj = {};
      for (const [k, v] of this.drivers.entries()) {
        driversObj[k] = {
          score: v.score,
          lastUpdated: new Date(v.lastUpdatedMs).toISOString(),
          contributors: v.contributors,
          processedEventIds: v.processedEventIds,
          snapshots: v.snapshots || [],
        };
      }

      const payload = {
        updatedAt: new Date().toISOString(),
        vehicles: vehiclesObj,
        drivers: driversObj,
      };

      fs.mkdirSync(path.dirname(STATE_FILE_PATH), { recursive: true });
      fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`RiskEngine saveState warning: ${err?.message || err}`);
    }
  }

  _buildDefaultRiskResult() {
    return {
      generatedAt: new Date().toISOString(),
      vehicleRisk: null,
      driverRisk: null,
    };
  }
}

function _parseTimestamp(ts) {
  if (!ts) return Date.now();
  if (ts instanceof Date) return ts.getTime();
  const parsed = new Date(ts).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

module.exports = RiskEngine;

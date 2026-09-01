/**
 * services/historyStore.js  v6
 *
 * Trip validation rules (all must pass to record a trip):
 *   MIN_TRIP_MS   = 3 min   — shorter = spurious ignition pair, discard
 *   MAX_TRIP_MS   = 8 hours — longer = almost certainly a missed OFF; flag as invalid
 *   STALE_ON_MS   = 12 hours — if an ignition ON is this old with no OFF, auto-expire it
 *
 * Invalid trips:
 *   - duration < MIN  → discarded entirely (not stored)
 *   - duration > MAX  → stored with invalid=true, excluded from all stats/summaries
 *   - no start time   → stored with partial=true, excluded from all stats/summaries
 *
 * On startup, stale ON states are auto-purged before processing begins.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

const DATA_DIR     = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const TRIPS_FILE   = path.join(DATA_DIR, 'trips.json');
const STATE_FILE   = path.join(DATA_DIR, 'state.json');

const SPURIOUS_OFF_WINDOW_SEC = 120;
const MIN_TRIP_MS   = 3  * 60_000;        // 3 minutes
const MAX_TRIP_MS   = 8  * 3_600_000;     // 8 hours
const STALE_ON_MS   = 12 * 3_600_000;     // 12 hours

class HistoryStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this._records = [];
    this._trips   = [];
    this._state   = {
      lastIgnitionOn:    {},
      lastIgnitionOff:   {},
      lastProcessedUID:  0,
      dailySummarySent:  null,
      mutedCategories:   [],
      personalDMsEnabled: true,
      tripsEnabled:       true,
    };
    this._historyDirty = false;
    this._tripsDirty   = false;
    this._stateDirty   = false;
    this._saveTimer    = null;
    this._load();
    this._purgeStaleIgnitionON();  // clean up any stale state on boot

    logger.success(
      `History store ready — ${this._records.length} alerts | ` +
      `${this._trips.filter(t => !t.invalid && !t.partial).length} valid trips | ` +
      `UID: ${this._state.lastProcessedUID} | ` +
      `muted: [${this._state.mutedCategories.join(', ') || 'none'}]`
    );
  }

  // ─── Startup maintenance ──────────────────────────────────────────────────

  /** Remove ignition ON states older than STALE_ON_MS — prevents days-long phantom trips */
  _purgeStaleIgnitionON() {
    const now    = Date.now();
    const before = Object.keys(this._state.lastIgnitionOn).length;
    let purged   = 0;

    for (const [plate, data] of Object.entries(this._state.lastIgnitionOn)) {
      const onTime = typeof data === 'string' ? data : data?.time;
      if (!onTime) { delete this._state.lastIgnitionOn[plate]; purged++; continue; }
      const age = now - new Date(onTime).getTime();
      if (age > STALE_ON_MS) {
        logger.warn(`Purging stale ignition ON for ${plate} (age: ${Math.round(age/3600000)}h — exceeded ${STALE_ON_MS/3600000}h threshold)`);
        delete this._state.lastIgnitionOn[plate];
        purged++;
      }
    }

    if (purged > 0) {
      this._stateDirty = true;
      this._scheduleSave();
      logger.info(`Purged ${purged}/${before} stale ignition ON states`);
    }
  }

  // ─── UID ──────────────────────────────────────────────────────────────────
  getLastProcessedUID()    { return this._state.lastProcessedUID || 0; }
  setLastProcessedUID(uid) {
    if (uid > this._state.lastProcessedUID) {
      this._state.lastProcessedUID = uid;
      this._stateDirty = true; this._scheduleSave();
    }
  }

  // ─── Mute controls ────────────────────────────────────────────────────────
  getMutedCategories()  { return [...this._state.mutedCategories]; }
  isMuted(alertType)    { return this._state.mutedCategories.includes(alertType); }

  muteCategory(type) {
    if (!this._state.mutedCategories.includes(type)) {
      this._state.mutedCategories.push(type);
      this._stateDirty = true; this._scheduleSave();
    }
  }
  unmuteCategory(type) {
    this._state.mutedCategories = this._state.mutedCategories.filter(t => t !== type);
    this._stateDirty = true; this._scheduleSave();
  }

  // ─── Feature toggles ─────────────────────────────────────────────────────
  isPersonalDMsEnabled() { return this._state.personalDMsEnabled !== false; }
  setPersonalDMs(v)      { this._state.personalDMsEnabled = v; this._stateDirty = true; this._scheduleSave(); }

  isTripsEnabled()       { return this._state.tripsEnabled !== false; }
  setTripsEnabled(v)     { this._state.tripsEnabled = v; this._stateDirty = true; this._scheduleSave(); }

  resetAllActiveTrips() {
    const count = Object.keys(this._state.lastIgnitionOn).length;
    this._state.lastIgnitionOn = {};
    this._stateDirty = true; this._scheduleSave();
    logger.info(`Trip reset: cleared ${count} active ignition ON states`);
    return count;
  }

  // ─── Ignition state ───────────────────────────────────────────────────────

  recordIgnitionOn(plate, time, address, mapsUrl) {
    if (!this.isTripsEnabled()) return;
    const existing = this.getLastIgnitionOn(plate);
    if (existing) {
      logger.info(`   ↳ Replacing existing ON state for ${plate} (was: ${existing.time})`);
    }
    this._state.lastIgnitionOn[plate?.toUpperCase()] = {
      time, address: address || null, mapsUrl: mapsUrl || null,
    };
    this._stateDirty = true; this._scheduleSave();
  }

  getLastIgnitionOn(plate) {
    const v = this._state.lastIgnitionOn[plate?.toUpperCase()];
    if (!v) return null;
    if (typeof v === 'string') return { time: v, address: null, mapsUrl: null };
    return v;
  }

  clearIgnitionOn(plate) {
    delete this._state.lastIgnitionOn[plate?.toUpperCase()];
    this._stateDirty = true;
  }

  recordIgnitionOff(plate, time) {
    this._state.lastIgnitionOff[plate?.toUpperCase()] = time;
    this._stateDirty = true; this._scheduleSave();
  }

  getLastIgnitionOff(plate) {
    return this._state.lastIgnitionOff[plate?.toUpperCase()] || null;
  }

  isSpuriousOff(plate, offTimeISO) {
    const on = this.getLastIgnitionOn(plate);
    if (!on) return false;
    try {
      const diffSec = (new Date(offTimeISO) - new Date(on.time)) / 1000;
      if (diffSec < SPURIOUS_OFF_WINDOW_SEC) {
        logger.warn(`   ↳ Spurious OFF for ${plate} — ${Math.round(diffSec)}s after ON`);
        return true;
      }
    } catch {}
    return false;
  }

  // ─── Trip recording (with validation) ────────────────────────────────────

  /**
   * Records a trip after validation.
   * Returns { recorded: bool, reason: string, trip: object|null }
   */
  recordTrip({ plate, vehicleModel, driver,
               startTime, startAddress, startMapsUrl,
               endTime, endAddress, endMapsUrl, durationMs }) {

    const p = plate?.toUpperCase();

    // Validate: no start time → partial trip (orphan OFF with no matching ON)
    if (!startTime) {
      logger.warn(`   ↳ Trip for ${p}: no start time — orphan OFF, not recording`);
      return { recorded: false, reason: 'no_start', trip: null };
    }

    // Validate: too short → spurious
    if (durationMs < MIN_TRIP_MS) {
      logger.info(`   ↳ Trip for ${p}: ${Math.round(durationMs/1000)}s — below ${MIN_TRIP_MS/60000}min minimum, discarded`);
      return { recorded: false, reason: 'too_short', trip: null };
    }

    // Validate: too long → suspicious / stale ON state
    const invalid = durationMs > MAX_TRIP_MS;
    if (invalid) {
      logger.warn(
        `   ↳ Trip for ${p}: ${_fmtDur(durationMs)} — exceeds ${MAX_TRIP_MS/3600000}h maximum. ` +
        `Recording as INVALID (likely missed OFF). Will be excluded from stats.`
      );
    }

    const trip = {
      id:           Date.now(),
      plate:        p,
      vehicleModel: vehicleModel || null,
      driver:       driver       || null,
      startTime,
      startAddress: startAddress || null,
      startMapsUrl: startMapsUrl || null,
      endTime,
      endAddress:   endAddress   || null,
      endMapsUrl:   endMapsUrl   || null,
      durationMs:   durationMs   || 0,
      durationStr:  _fmtDur(durationMs),
      invalid,                      // true = excluded from stats
    };

    this._trips.push(trip);
    this._tripsDirty = true; this._scheduleSave();

    if (!invalid) {
      logger.info(`   ↳ Trip recorded: ${p} — ${trip.durationStr} ✅`);
    }

    return { recorded: true, reason: invalid ? 'invalid_long' : 'ok', trip };
  }

  // ─── Alert recording ──────────────────────────────────────────────────────

  record(alertDef, fields, mail) {
    if (!fields.plate) return;
    const idleDurationMin = (alertDef.type === 'idle' && fields.idleTime)
      ? parseInt(fields.idleTime) || 0 : 0;

    this._records.push({
      id:             Date.now() + Math.random(),
      plate:          fields.plate.toUpperCase(),
      vehicleModel:   fields.vehicleModel  || null,
      alertType:      alertDef.type,
      alertLabel:     alertDef.label,
      severity:       alertDef.severity,
      driver:         fields.driver        || null,
      speed:          fields.speed         || null,
      speedLimit:     fields.speedLimit    || null,
      idleTime:       fields.idleTime      || null,
      idleLimit:      fields.idleLimit     || null,
      idleDurationMin,
      address:        fields.address       || null,
      emailSubject:   mail?.subject        || null,
      source:         fields.source        || 'unknown',
      receivedAt:     (mail?.date || new Date()).toISOString(),
      loggedAt:       new Date().toISOString(),
    });
    this._historyDirty = true; this._scheduleSave();
  }

  // ─── Valid trips only ─────────────────────────────────────────────────────

  _validTrips()          { return this._trips.filter(t => !t.invalid); }
  _validRecentTrips(h)   {
    const cutoff = Date.now() - h * 3_600_000;
    return this._validTrips().filter(t => new Date(t.endTime).getTime() > cutoff);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getVehicleSummary(plate) {
    const norm    = _normPlate(plate);
    const records = this._records.filter(r => _normPlate(r.plate) === norm);
    const trips   = this._validTrips().filter(t => _normPlate(t.plate) === norm);
    if (records.length === 0 && trips.length === 0) return null;

    const typeCounts = {};
    let totalIdleMin = 0;
    for (const r of records) {
      if (!typeCounts[r.alertType]) {
        typeCounts[r.alertType] = { label: r.alertLabel, severity: r.severity, count: 0 };
      }
      typeCounts[r.alertType].count++;
      totalIdleMin += r.idleDurationMin || 0;
    }

    const totalTripMs = trips.reduce((s, t) => s + (t.durationMs || 0), 0);

    return {
      plate:         plate.toUpperCase(),
      model:         records.find(r => r.vehicleModel)?.vehicleModel ||
                     trips.find(t => t.vehicleModel)?.vehicleModel || 'Unknown',
      totalAlerts:   records.length,
      totalTrips:    trips.length,
      totalTripTime: _fmtDur(totalTripMs),
      totalIdleTime: `${totalIdleMin} min`,
      byType:        Object.values(typeCounts).sort((a, b) => b.count - a.count),
      lastSeen:      records[records.length - 1]?.receivedAt || null,
    };
  }

  getAllVehicleSummaries() {
    const plates = [...new Set([...this._records.map(r => r.plate), ...this._validTrips().map(t => t.plate)])];
    return plates.map(p => this.getVehicleSummary(p)).filter(Boolean)
                 .sort((a, b) => b.totalAlerts - a.totalAlerts);
  }

  getRecentRecords(hours) {
    const cutoff = Date.now() - hours * 3_600_000;
    return this._records.filter(r => new Date(r.receivedAt).getTime() > cutoff);
  }

  getRecentTrips(hours) { return this._validRecentTrips(hours); }

  getIdleStats(hours) {
    const recent = this.getRecentRecords(hours).filter(r => r.alertType === 'idle');
    const byPlate = {};
    for (const r of recent) {
      if (!byPlate[r.plate]) byPlate[r.plate] = { plate: r.plate, model: r.vehicleModel, totalIdleMin: 0, events: 0 };
      byPlate[r.plate].totalIdleMin += r.idleDurationMin || 0;
      byPlate[r.plate].events++;
    }
    return Object.values(byPlate).sort((a, b) => b.totalIdleMin - a.totalIdleMin);
  }

  getTripStats(hours) {
    const recent = this._validRecentTrips(hours);
    const byPlate = {};
    for (const t of recent) {
      if (!byPlate[t.plate]) byPlate[t.plate] = { plate: t.plate, model: t.vehicleModel, totalTripMs: 0, trips: 0 };
      byPlate[t.plate].totalTripMs += t.durationMs || 0;
      byPlate[t.plate].trips++;
    }
    return Object.values(byPlate)
      .map(v => ({ ...v, totalTripStr: _fmtDur(v.totalTripMs) }))
      .sort((a, b) => b.totalTripMs - a.totalTripMs);
  }

  /** Records for scoring — all records within N days */
  getRecordsForDays(days) {
    return this.getRecentRecords(days * 24);
  }

  allPlates() {
    return [...new Set([...this._records.map(r => r.plate), ...this._trips.map(t => t.plate)])];
  }

  lastIgnitionActivity(plate) {
    const norm  = _normPlate(plate);
    const trips = this._validTrips().filter(t => _normPlate(t.plate) === norm);
    const on    = this.getLastIgnitionOn(plate);
    const off   = this.getLastIgnitionOff(plate);
    const times = [
      on?.time ? new Date(on.time).getTime() : 0,
      off       ? new Date(off).getTime()    : 0,
      trips.length ? new Date(trips[trips.length-1].endTime).getTime() : 0,
    ].filter(Boolean);
    return times.length ? Math.max(...times) : 0;
  }

  globalTotal()      { return this._records.length; }
  distinctVehicles() { return new Set(this._records.map(r => r.plate)).size; }

  getDailySummarySentDate()     { return this._state.dailySummarySent || null; }
  setDailySummarySentDate(date) {
    this._state.dailySummarySent = date;
    this._stateDirty = true; this._scheduleSave();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  _load() {
    this._records = this._readJSON(HISTORY_FILE, []);
    this._trips   = this._readJSON(TRIPS_FILE,   []);
    const saved   = this._readJSON(STATE_FILE,   {});
    this._state   = {
      lastIgnitionOn:    saved.lastIgnitionOn    || {},
      lastIgnitionOff:   saved.lastIgnitionOff   || {},
      lastProcessedUID:  saved.lastProcessedUID  || 0,
      dailySummarySent:  saved.dailySummarySent  || null,
      mutedCategories:   saved.mutedCategories   || [],
      personalDMsEnabled: saved.personalDMsEnabled !== false,
      tripsEnabled:       saved.tripsEnabled      !== false,
    };
  }

  _readJSON(p, fb) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._flush(); }, 200);
  }

  _flush() {
    if (this._historyDirty) { this._atomicWrite(HISTORY_FILE, this._records); this._historyDirty = false; }
    if (this._tripsDirty)   { this._atomicWrite(TRIPS_FILE,   this._trips);   this._tripsDirty   = false; }
    if (this._stateDirty)   { this._atomicWrite(STATE_FILE,   this._state);   this._stateDirty   = false; }
  }

  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) { logger.error(`Write failed (${path.basename(filePath)}): ${err.message}`); }
  }
}

function _normPlate(p) { return (p || '').toUpperCase().replace(/[\s\/]/g, ''); }

function _fmtDur(ms) {
  if (!ms || ms <= 0) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = HistoryStore;

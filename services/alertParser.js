/**
 * services/alertParser.js  v5 — Router
 *
 * Detects which email system sent the alert and delegates to the
 * appropriate parser. Returns { alertDef, fields } or null.
 *
 * System 1 (original tracking system):
 *   From: config.email.alertSender
 *   Format: "Your D/31498-Toyota Hilux is exceeding..."
 *
 * System 2 (track9999):
 *   From: noreply@track9999.com
 *   Format: "Tracker Event Notification[Event][Plate]"
 */

const alertTypes          = require('../data/alertTypes.json');
const config              = require('../config/settings');
const Track9999Parser     = require('./track9999Parser');
const EventContextBuilder = require('./eventContext');
const logger              = require('../utils/logger');

// ─── System 1 field patterns ──────────────────────────────────────────────
const FIELD_PATTERNS = {
  plate:        [ /Your\s+([A-Z0-9\/]+)-/i ],
  vehicleModel: [ /Your\s+[A-Z0-9\/]+-(.+?)\s+(?:is\s+|ignition)/i ],
  speedLimit:   [ /speed\s+limit\s+(\d+)\s*kmph/i, /speed\s+limit\s+(\d+)/i ],
  speed:        [ /speed\s+limit\s+\d+\s*kmph[\s\S]*?\n\s*(\d+)\s*kmph/i, /\n\s*(\d+)\s*kmph/i ],
  idleLimit:    [ /[Ii]dle\s+limit\s+(\d+)\s*minutes/i, /[Ii]dle\s+limit\s+(\d+)/i ],
  idleTime:     [ /[Ii]dle\s+limit\s+\d+\s*minutes[\s\S]*?\n\s*(\d+)/i, /minutes\s*\n\s*(\d+)/i ],
  alertTime: [
    /\bon\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i,
    /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)/,
    /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/,
  ],
  latitude:  [ /lat(?:itude)?[^\n:]*[:\-]\s*([-+]?\d{1,3}\.\d+)/i ],
  longitude: [ /lon(?:gitude)?[^\n:]*[:\-]\s*([-+]?\d{1,3}\.\d+)/i ],
  driver:    [ /(?:driver|operator)[^\n:]*[:\-]\s*(.+)/i ],
};

function _stripPlusCode(raw) {
  if (!raw) return raw;
  return raw.replace(/^[A-Z0-9]{4,8}\+[A-Z0-9]{2,3}\s*-\s*/i, '').trim();
}

const SEVERITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const track9999 = new Track9999Parser();

class AlertParser {
  constructor(historyStore = null, options = {}) {
    this.contextBuilder = new EventContextBuilder(historyStore, options);
  }

  setHistoryStore(store, options = {}) {
    this.contextBuilder.setHistoryStore(store, options);
  }

  parse(mail) {
    const fromAddr = (mail.from?.value?.[0]?.address || '').toLowerCase();
    let result = null;

    // ── Route to system 2 parser ─────────────────────────────────────────
    if (fromAddr.includes('track9999') ||
        (config.email.alertSender2 && fromAddr.includes(config.email.alertSender2.toLowerCase()))) {
      logger.info(`   ↳ Routing to track9999 parser (from: ${fromAddr})`);
      result = track9999.parse(mail);
    } else {
      // ── System 1 parser ──────────────────────────────────────────────────
      result = this._parseSystem1(mail);
    }

    if (result) {
      result.context = this.contextBuilder.build(result, mail);
    }

    return result;
  }

  _parseSystem1(mail) {
    const rawText  = this._extractText(mail);
    const subject  = mail.subject || '';
    const combined = `${subject}\n${rawText}`;

    const alertDef = this._matchAlertType(combined);
    if (this._shouldSkip(alertDef)) {
      logger.info(`   ↳ Alert type "${alertDef.label}" filtered`);
      return null;
    }

    const fields = this._extractFields(combined);

    // Location from HTML anchor
    const loc = this._extractLocationFromHtml(mail);
    if (loc.address) fields.address = loc.address;
    if (loc.mapsUrl) fields.mapsUrl  = loc.mapsUrl;

    // Plain text fallback for __[...]__ address format
    if (!fields.address) {
      const m = combined.match(/__\[([^\]]+)\]__/)
             || combined.match(/turned\s+(?:ON|OFF)\s+at\s+([^_\[\n]+?)\s+on\s+\d{4}/i);
      if (m) fields.address = _stripPlusCode(m[1].trim());
    }

    if (!fields.alertTime && mail.date) {
      fields.alertTime = mail.date.toISOString();
    }

    fields.source = 'system1';

    logger.info(
      `   ↳ [system1] Type: ${alertDef.label} [${alertDef.severity}]` +
      ` | Plate: ${fields.plate || '?'} | Model: ${fields.vehicleModel || '?'}`
    );
    if (fields.speed && fields.speedLimit) {
      const excess = parseInt(fields.speed) - parseInt(fields.speedLimit);
      logger.info(`   ↳ Speed: ${fields.speed} km/h | Limit: ${fields.speedLimit} km/h | Excess: +${excess}`);
    }
    if (fields.idleTime) logger.info(`   ↳ Idle: ${fields.idleTime} min | Limit: ${fields.idleLimit || '?'} min`);
    if (fields.address)  logger.info(`   ↳ Address: ${fields.address}`);
    if (fields.mapsUrl)  logger.info(`   ↳ Maps URL: ${fields.mapsUrl}`);

    return { alertDef, fields };
  }

  _extractLocationFromHtml(mail) {
    const result = { address: null, mapsUrl: null };
    if (!mail.html) return result;

    const anchorRe = /<a[^>]+href=["']([^"']*(?:maps\.google|goo\.gl\/maps)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(mail.html)) !== null) {
      const href = m[1].trim();
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!result.mapsUrl) result.mapsUrl = href;
      if (!result.address && text) result.address = _stripPlusCode(text);
      if (result.mapsUrl && result.address) break;
    }

    if (!result.mapsUrl) {
      const um = mail.html.match(/href=["']([^"']*maps\.google[^"']*)["']/i);
      if (um) result.mapsUrl = um[1].trim();
    }
    if (!result.mapsUrl && mail.text) {
      const um = mail.text.match(/https?:\/\/(?:maps\.google\.com|google\.com\/maps)[^\s]*/i);
      if (um) result.mapsUrl = um[0].trim();
    }

    return result;
  }

  _extractText(mail) {
    if (mail.text) return mail.text;
    if (mail.html) return mail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return '';
  }

  _matchAlertType(text) {
    const lower = text.toLowerCase();
    for (const def of alertTypes) {
      if (def.type === 'unknown') continue;
      if (def.keywords.some(kw => lower.includes(kw.toLowerCase()))) return def;
    }
    return alertTypes.find(d => d.type === 'unknown');
  }

  _shouldSkip(alertDef) {
    if (config.alerts.ignored.includes(alertDef.type)) return true;
    if (config.alerts.ignored.includes(alertDef.label.toLowerCase())) return true;
    const minLevel   = SEVERITY_ORDER[config.alerts.minSeverity] ?? 0;
    const alertLevel = SEVERITY_ORDER[alertDef.severity]         ?? 1;
    return alertLevel < minLevel;
  }

  _extractFields(text) {
    const fields = {};
    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      for (const re of patterns) {
        const m = text.match(re);
        if (m) { fields[field] = m[1]?.trim(); break; }
      }
    }
    if (fields.vehicleModel) {
      fields.vehicleModel = fields.vehicleModel.replace(/[.,;:]+$/, '').trim();
    }
    return fields;
  }
}

module.exports = AlertParser;

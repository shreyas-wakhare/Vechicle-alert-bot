/**
 * services/track9999Parser.js  v2
 *
 * The "Position: Click to View" link goes to the tracking platform portal,
 * not Google Maps. We capture it as a tracking link and label it correctly.
 *
 * If a Google Maps URL happens to be present, we prefer that.
 * Otherwise we show the platform link labelled as "📌 Track link"
 * so the user knows where to click.
 */

const alertTypes = require('../data/alertTypes.json');
const config     = require('../config/settings');
const logger     = require('../utils/logger');

const SEVERITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

class Track9999Parser {
  parse(mail) {
    const subject  = mail.subject || '';
    const text     = this._extractText(mail);
    const combined = `${subject}\n${text}`;

    const plate = this._extractPlate(subject, text);
    if (!plate) {
      logger.warn('   ↳ track9999: could not extract plate — skipping');
      return null;
    }

    const eventName  = this._extractEventName(subject, text);
    const speedMatch = eventName.match(/\((\d+(?:\.\d+)?)\s*km\/h\)/i);
    const eventSpeed = speedMatch ? speedMatch[1] : null;

    const alertDef = this._matchAlertType(combined);

    if (this._shouldSkip(alertDef)) {
      logger.info(`   ↳ track9999: "${alertDef.label}" filtered`);
      return null;
    }

    const timeMatch = text.match(/Time:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i)
                   || text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    const alertTime = timeMatch ? timeMatch[1] : (mail.date?.toISOString() || null);

    const imeiMatch = text.match(/IMEI:\s*(\d+)/i);
    const imei      = imeiMatch ? imeiMatch[1] : null;

    const { mapsUrl, trackUrl } = this._extractLinks(mail);

    const fields = {
      plate,
      vehicleModel: null,
      driver:       null,
      alertTime,
      mapsUrl:      mapsUrl  || null,
      trackUrl:     trackUrl || null,   // platform tracking link
      address:      null,
      imei,
      eventName,
      speed:        eventSpeed,
      source:       'track9999',
    };

    logger.info(
      `   ↳ [track9999] ${alertDef.label} [${alertDef.severity}]` +
      ` | Plate: ${plate}` +
      ` | Event: ${eventName}` +
      (eventSpeed ? ` | Speed: ${eventSpeed} km/h` : '') +
      (mapsUrl  ? ` | Maps: YES`  : '') +
      (trackUrl ? ` | Track: YES` : '')
    );

    return { alertDef, fields };
  }

  // ─── Link extraction ──────────────────────────────────────────────────────

  _extractLinks(mail) {
    let mapsUrl  = null;
    let trackUrl = null;

    if (mail.html) {
      // Prefer Google Maps links
      const mapsRe = /href=["']([^"']*(?:maps\.google\.com|google\.com\/maps|goo\.gl\/maps)[^"']*)["']/i;
      const mm = mail.html.match(mapsRe);
      if (mm) mapsUrl = mm[1].trim();

      // Extract the "Click to View" / "Position" link (any non-unsubscribe, non-mailto link)
      if (!mapsUrl) {
        const posRe  = /Position[^<]{0,50}<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
        const pm = posRe.exec(mail.html);
        if (pm) trackUrl = pm[1].trim();
      }

      // Any other external link (not unsubscribe)
      if (!mapsUrl && !trackUrl) {
        const anyRe = /href=["'](https?:\/\/(?!.*unsubscribe)[^"']{15,})["']/gi;
        let lm;
        while ((lm = anyRe.exec(mail.html)) !== null) {
          const u = lm[1].trim();
          if (!u.includes('unsubscribe') && !u.includes('mailto')) {
            trackUrl = u; break;
          }
        }
      }
    }

    // Plain text fallback
    if (!mapsUrl && !trackUrl && mail.text) {
      const urlRe = /https?:\/\/[^\s]+/g;
      let m;
      while ((m = urlRe.exec(mail.text)) !== null) {
        const u = m[0].replace(/[)>]+$/, '');
        if (!u.includes('unsubscribe')) {
          if (u.includes('maps.google') || u.includes('google.com/maps')) mapsUrl = u;
          else trackUrl = u;
          break;
        }
      }
    }

    return { mapsUrl, trackUrl };
  }

  _extractPlate(subject, text) {
    // Subject: [...][P-17584]  last bracket
    const sm = subject.match(/\[([A-Z0-9][A-Z0-9\-\/]+)\]\s*$/i);
    if (sm) return sm[1].trim().toUpperCase();
    // Body: "Tracker Name: P-17584"
    const bm = text.match(/Tracker\s+Name:\s*([A-Z0-9][A-Z0-9\-\/]+)/i);
    if (bm) return bm[1].trim().toUpperCase();
    return null;
  }

  _extractEventName(subject, text) {
    // Subject: Notification[Event Name][Plate] — first bracket is event
    const sm = subject.match(/\[([^\]]+)\]\s*\[[^\]]+\]\s*$/i);
    if (sm) return sm[1].trim();
    const bm = text.match(/Event:\s*(.+)/i);
    if (bm) return bm[1].trim();
    return 'Unknown Event';
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
}

module.exports = Track9999Parser;

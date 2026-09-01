/**
 * services/messageFormatter.js  v6
 */

const TIMEZONE = 'Asia/Dubai';

const SEVERITY_LABELS = {
  LOW:'🟢 Low', MEDIUM:'🟡 Medium', HIGH:'🔴 High', CRITICAL:'🆘 CRITICAL',
};

class MessageFormatter {

  format(alertDef, fields) {
    const { severityLabel, criticalLevel } = this._dynamicSeverity(alertDef, fields);
    const datetime = this._dubaiTime(fields.alertTime);
    const text = this._buildStandardMessage({ alertDef, fields, severityLabel, datetime });
    return { text, criticalLevel };
  }

  formatTripComplete(fields) {
    const vehicle = [fields.plate, fields.vehicleModel].filter(Boolean).join(' — ');
    const lines   = [];

    lines.push(`✅ *TRIP COMPLETED*`);
    lines.push('');
    lines.push(`🚗 *Vehicle:*  ${vehicle || 'N/A'}`);
    if (fields.driver) lines.push(`👤 *Driver:*   ${fields.driver}`);
    lines.push('');

    lines.push(`🟢 *Started:*  ${this._dubaiTime(fields.tripStartTime)}`);
    if (fields.tripStartAddress) lines.push(`📍            ${fields.tripStartAddress}`);
    if (fields.tripStartMapsUrl) lines.push(`🗺️             ${fields.tripStartMapsUrl}`);
    else if (fields.tripStartTrackUrl) lines.push(`📌            ${fields.tripStartTrackUrl}`);
    lines.push('');

    lines.push(`🔴 *Ended:*    ${this._dubaiTime(fields.alertTime)}`);
    if (fields.address)  lines.push(`📍            ${fields.address}`);
    if (fields.mapsUrl)  lines.push(`🗺️             ${fields.mapsUrl}`);
    else if (fields.trackUrl) lines.push(`📌            ${fields.trackUrl}`);
    lines.push('');

    lines.push(`🕐 *Duration:* ${fields.tripDuration || 'N/A'}`);
    lines.push('', '─────────────────');
    return { text: lines.join('\n'), criticalLevel: 0 };
  }

  // ─── Standard alert ───────────────────────────────────────────────────────

  _buildStandardMessage({ alertDef, fields, severityLabel, datetime }) {
    const lines       = [];
    const isTrack9999 = fields.source === 'track9999';

    lines.push(`${alertDef.emoji} *${alertDef.label.toUpperCase()} ALERT*`);
    if (isTrack9999 && fields.eventName && fields.eventName.toLowerCase() !== alertDef.label.toLowerCase()) {
      lines.push(`_${fields.eventName}_`);
    }
    lines.push('');

    const vehicle = isTrack9999
      ? (fields.plate || 'N/A')
      : [fields.plate, fields.vehicleModel].filter(Boolean).join(' — ') || 'N/A';
    lines.push(`🚗 *Vehicle:*   ${vehicle}`);
    if (fields.driver) lines.push(`👤 *Driver:*    ${fields.driver}`);
    lines.push('');

    lines.push(`📅 *Time:*      ${datetime}`);
    lines.push(`📊 *Severity:*  ${severityLabel}`);

    // Overspeed
    if (alertDef.type === 'speeding' && fields.speed) {
      lines.push('');
      lines.push(`⚡ *Speed:*     ${fields.speed} km/h`);
      if (fields.speedLimit) {
        lines.push(`🚧 *Limit:*     ${fields.speedLimit} km/h`);
        const excess = parseInt(fields.speed) - parseInt(fields.speedLimit);
        if (excess > 0) lines.push(`📈 *Excess:*    +${excess} km/h`);
      }
    }

    // Distraction with embedded speed
    if (alertDef.type === 'distraction' && fields.speed) {
      lines.push('');
      lines.push(`⚡ *Speed at event:* ${fields.speed} km/h`);
    }

    // Idle
    if (alertDef.type === 'idle' && fields.idleTime) {
      lines.push('');
      lines.push(`⏱️  *Idle time:*  ${fields.idleTime} min`);
      if (fields.idleLimit) {
        lines.push(`🚧 *Limit:*     ${fields.idleLimit} min`);
        const over = parseInt(fields.idleTime) - parseInt(fields.idleLimit);
        if (over > 0) lines.push(`📈 *Over by:*   +${over} min`);
      }
    }

    // Location
    if (fields.address && alertDef.type !== 'ignition_on' && alertDef.type !== 'ignition_off') {
      lines.push('');
      lines.push(`📍 *Location:* ${fields.address}`);
    }

    // Maps link (preferred) or tracking platform link
    if (fields.mapsUrl) {
      lines.push(`🗺️  *Maps:*     ${fields.mapsUrl}`);
    } else if (fields.trackUrl) {
      lines.push(`📌 *Track:*    ${fields.trackUrl}`);
    }

    if (isTrack9999 && fields.imei) {
      lines.push(`🔧 *IMEI:*     ${fields.imei}`);
    }

    lines.push('', '─────────────────');
    return lines.join('\n');
  }

  // ─── Scoring helper: grade label ──────────────────────────────────────────

  static scoreGrade(score) {
    if (score >= 90) return '🏆 Excellent';
    if (score >= 75) return '🟢 Good';
    if (score >= 60) return '🟡 Fair';
    if (score >= 45) return '🟠 Poor';
    return '🔴 Critical';
  }

  // ─── Dynamic severity ─────────────────────────────────────────────────────

  _dynamicSeverity(alertDef, fields) {
    if (alertDef.type === 'speeding' && fields.speed && fields.speedLimit) {
      const excess = parseInt(fields.speed) - parseInt(fields.speedLimit);
      if (excess < 5)  return { severityLabel: '🔴',       criticalLevel: 1 };
      if (excess < 10) return { severityLabel: '🔴🔴',     criticalLevel: 2 };
      if (excess < 15) return { severityLabel: '🔴🔴🔴',   criticalLevel: 3 };
      return             { severityLabel: '🔴🔴🔴🔴', criticalLevel: 4 };
    }

    if (alertDef.type === 'idle' && fields.idleTime && fields.idleLimit) {
      const over = parseInt(fields.idleTime) - parseInt(fields.idleLimit);
      if (over <= 0)  return { severityLabel: '🟠',       criticalLevel: 0 };
      if (over < 5)   return { severityLabel: '🟠🔴',     criticalLevel: 1 };
      if (over < 10)  return { severityLabel: '🔴',       criticalLevel: 1 };
      if (over < 15)  return { severityLabel: '🔴🔴',     criticalLevel: 2 };
      return            { severityLabel: '🔴🔴🔴',   criticalLevel: 3 };
    }

    return {
      severityLabel: SEVERITY_LABELS[alertDef.severity] || alertDef.severity,
      criticalLevel: alertDef.severity === 'CRITICAL' ? 3 : 0,
    };
  }

  _dubaiTime(raw) {
    if (!raw) return 'N/A';
    try {
      const d = raw instanceof Date ? raw : new Date(String(raw).replace(' ', 'T'));
      if (isNaN(d.getTime())) return String(raw);
      return d.toLocaleString('en-GB', {
        timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
    } catch { return String(raw); }
  }
}

module.exports = MessageFormatter;

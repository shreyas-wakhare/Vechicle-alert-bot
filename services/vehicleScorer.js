/**
 * services/vehicleScorer.js
 *
 * Computes a driver behaviour score (0–100) per vehicle for a given period.
 * Higher = better. Score starts at 100 and deductions are applied per event.
 *
 * Deduction table (per event occurrence):
 *   Collision / SOS / Tampering         -20
 *   Fatigue / Drinking / Phone use      -12
 *   Seatbelt / Smoking / Camera blocked -10
 *   Overspeed (scaled by excess km/h)   -3 to -10
 *   Harsh braking / acceleration        -4
 *   Idle (scaled by minutes over limit) -2 to -6
 *   Lane change / Distraction           -3
 *   UBI deceleration / acceleration     -2
 *   Other MEDIUM severity               -2
 *   Other LOW severity                  -1
 *
 * Minimum score: 0. Score is clamped.
 */

const DEDUCTIONS = {
  accident:        20,
  sos:             20,
  tampering:       20,
  engine_failure:  15,
  fatigue:         12,
  drinking:        12,
  distraction:     10,
  seatbelt:        10,
  smoking:         10,
  camera_blocked:  10,
  harsh_braking:    4,
  harsh_acceleration: 4,
  lane_change:      3,
  ubi_deceleration: 2,
  ubi_acceleration: 2,
  lte_jamming:      2,
  gps_lost:         2,
  driver_change:    2,
  voice_alarm:      1,
  offline:          1,
  low_battery:      1,
};

class VehicleScorer {
  /**
   * Score all vehicles for a given set of alert records.
   * Returns sorted array: [ { plate, model, score, totalEvents, deductions, breakdown } ]
   */
  scoreAll(records) {
    // Group by plate
    const byPlate = {};
    for (const r of records) {
      if (!byPlate[r.plate]) {
        byPlate[r.plate] = { plate: r.plate, model: r.vehicleModel, records: [] };
      }
      byPlate[r.plate].records.push(r);
    }

    return Object.values(byPlate)
      .map(v => this._scoreVehicle(v))
      .sort((a, b) => b.score - a.score);
  }

  _scoreVehicle({ plate, model, records }) {
    let totalDeduction = 0;
    const breakdown = {};

    for (const r of records) {
      // Skip ignition events — not behaviour violations
      if (r.alertType === 'ignition_on' || r.alertType === 'ignition_off') continue;

      const deduction = this._deductionForRecord(r);
      if (deduction === 0) continue;

      totalDeduction += deduction;

      if (!breakdown[r.alertLabel]) {
        breakdown[r.alertLabel] = { count: 0, totalDeduction: 0, emoji: _emoji(r.alertType) };
      }
      breakdown[r.alertLabel].count++;
      breakdown[r.alertLabel].totalDeduction += deduction;
    }

    const score = Math.max(0, Math.min(100, 100 - totalDeduction));

    return {
      plate,
      model:        model || 'Unknown',
      score:        Math.round(score * 10) / 10,
      totalEvents:  records.filter(r => r.alertType !== 'ignition_on' && r.alertType !== 'ignition_off').length,
      totalDeduction: Math.round(totalDeduction * 10) / 10,
      breakdown:    Object.entries(breakdown)
                      .sort((a, b) => b[1].totalDeduction - a[1].totalDeduction)
                      .map(([label, v]) => ({ label, ...v })),
    };
  }

  _deductionForRecord(r) {
    // Check static deduction table first
    if (DEDUCTIONS[r.alertType] !== undefined) return DEDUCTIONS[r.alertType];

    // Overspeed — scaled by excess
    if (r.alertType === 'speeding' && r.speed && r.speedLimit) {
      const excess = parseInt(r.speed) - parseInt(r.speedLimit);
      if (excess < 0)   return 0;
      if (excess < 5)   return 3;
      if (excess < 10)  return 5;
      if (excess < 15)  return 7;
      return 10;
    }

    // Idle — scaled by minutes over limit
    if (r.alertType === 'idle' && r.idleTime && r.idleLimit) {
      const over = parseInt(r.idleTime) - parseInt(r.idleLimit);
      if (over <= 0)  return 2;   // at or under limit still counts a bit
      if (over < 5)   return 3;
      if (over < 10)  return 4;
      if (over < 15)  return 5;
      return 6;
    }

    // Fallback by severity
    const sevMap = { CRITICAL: 15, HIGH: 5, MEDIUM: 2, LOW: 1 };
    return sevMap[r.severity] || 1;
  }
}

function _emoji(type) {
  const map = {
    speeding:'🚨', harsh_braking:'⚠️', harsh_acceleration:'⚠️',
    idle:'💤', distraction:'📱', seatbelt:'🪢', smoking:'🚬',
    fatigue:'😴', accident:'💥', sos:'🆘', engine_failure:'🔧',
    drinking:'🥤', lane_change:'↔️', camera_blocked:'🎥',
    gps_lost:'📡', lte_jamming:'📶', tampering:'🚫',
    low_battery:'🔋', offline:'🔌', ubi_deceleration:'⬇️',
    ubi_acceleration:'⬆️', driver_change:'👤',
  };
  return map[type] || '📋';
}

module.exports = VehicleScorer;

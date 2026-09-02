# Feature #3 — Phase 1: Dynamic Vehicle/Driver Risk — Risk Foundation & Scoring

## Executive Summary

Feature #3 Phase 1 introduces a deterministic, explainable, production-safe dynamic risk engine (`services/riskEngine.js`) built directly on top of the frozen Feature #1 (Event Context) and Feature #2 (Alert Correlation & Incident Intelligence) pipelines.

Phase 1 establishes the mathematical foundation for tracking real-time risk scores (0–100) and risk levels (`LOW`, `MEDIUM`, `ELEVATED`, `HIGH`, `CRITICAL`) for both vehicles and drivers, incorporating clean-time score decay, duplicate event protection, pattern multipliers for correlated incidents, and compact state persistence (`data/risk_state.json`).

Phase 1 strictly avoids AI/LLMs, machine learning, risk score prediction, database migrations, and notification redesigns.

**Status**: **COMPLETE / FROZEN 🔒**  
**Date Completed**: 2026-09-02  
**Test Suite Metric**: 27 / 27 PASSED ✅  
**Full System Baseline**: 270 / 270 PASSED ✅

---

## 1. Technical Architecture & Integration Point

```text
Email Message
   │
   ▼
EmailParser (alertParser.js)
   │
   ▼
EventContextBuilder (services/eventContext.js)
   │ 1. Telemetry & Trip Context (HistoryStore)
   │ 2. RecentActivityEngine (5m, 15m, 30m, 60m windows)
   │ 3. ContextIntelligenceEngine (signal detection)
   │ 4. AlertCorrelationEngine (Feature #2 Phase 1)
   │ 5. IncidentGroupingEngine (Feature #2 Phase 2)
   │ 6. IncidentIntelligenceEngine (Feature #2 Phase 3.1 & 3.2)
   │ 7. IncidentInterpretationEngine (Feature #2 Phase 3.3)
   ▼
RiskEngine (services/riskEngine.js) ◄── [Feature #3 Phase 1 Integration]
   │ ──► Reads context.alertCorrelation & context.telemetry
   │ ──► Updates Vehicle Risk State (vehicleKey)
   │ ──► Updates Driver Risk State (driverKey, ONLY if reliable driver string exists)
   ▼
context.risk (Attached to EventContext)
```

---

## 2. Risk Model & Scoring Specification

### A. Bounded Score Range & Level Thresholds

Score range is strictly bounded: $0 \le \text{Score} \le 100$.

| Score Range | Risk Level | Operational Meaning |
|---|---|---|
| `0 – 19` | `LOW` | Normal, routine fleet operation |
| `20 – 44` | `MEDIUM` | Single minor or moderate alert observed |
| `45 – 69` | `ELEVATED` | Repeated violations or moderate correlated pattern |
| `70 – 89` | `HIGH` | Sustained aggressive driving, severe alerts, or active pattern incident |
| `90 – 100` | `CRITICAL` | Collision, SOS emergency, severe hardware tampering, or critical engine failure |

### B. Impact Formula & Feature #2 Multipliers

The risk score impact $S_{\text{impact}}$ for an incoming alert event is computed deterministically:

$$S_{\text{impact}} = \text{Math.round}(S_{\text{base}} \times M_{\text{incident}} \times M_{\text{escalation}})$$

1. **Base Impact ($S_{\text{base}}$)**: Derived from the alert-type risk mapping (`ALERT_RISK_MAP`), whose values are aligned with the existing severity classification:
   - `LOW` severity: $+1$ to $+5$ points
   - `MEDIUM` severity: $+8$ to $+12$ points
   - `HIGH` severity: $+15$ to $+20$ points
   - `CRITICAL` severity: $+35$ to $+45$ points
2. **Feature #2 Pattern Multiplier ($M_{\text{incident}}$)**:
   - Single isolated alert (`!incident.isIncident`): $M_{\text{incident}} = 1.0$
   - Correlated pattern incident (`incident.isIncident === true`): $M_{\text{incident}} = 1.35$
3. **Escalation Multiplier ($M_{\text{escalation}}$)**:
   - Pattern or severity escalation detected (`intel.escalation.detected === true`): $M_{\text{escalation}} = 1.25$

### C. Clean-Time Risk Recovery / Decay Foundation

Risk scores decay deterministically over clean, alert-free elapsed time:
- **Decay Rate**: $R_{\text{decay}} = 0.1$ points per minute (~$6.0$ points score decay per clean hour).
- Upon receiving a new event or querying state at timestamp $T$, the entity's score decays before applying new impact:

$$\text{Score}_{\text{decayed}} = \max\left(0, \text{Score}_{\text{prev}} - (\Delta T_{\text{minutes}} \times R_{\text{decay}})\right)$$

### D. Duplicate Event Protection

Each entity maintains a bounded set of processed `eventId` strings (capped at 100 items). If an incoming event's `eventId` has already been processed for that entity, $S_{\text{impact}} = 0$, preventing artificial score inflation from duplicate email processing or retries.

---

## 3. Vehicle & Driver Identity Domain Scoping

### Vehicle Identity (`vehicleKey`)
- **Primary Key**: `IMEI:${imei}` if IMEI is present.
- **Fallback Key**: `PLATE:${normalizedPlate}` (e.g. `PLATE:D31498`).
- **Default**: `'UNKNOWN'`.

### Driver Identity (`driverKey`) & Scoping Safeguard
- **Driver Key**: `DRIVER:${normName}` (e.g. `DRIVER:AHMED`).
- **Safeguard**: As mandated by Section 1 & 8 of the Master Prompt, **driver risk operates ONLY when a non-empty, reliable driver identity string exists**. When `driver` is `null` or missing, driver risk calculation is safely skipped for that event, while vehicle risk calculation proceeds normally. Missing driver data NEVER creates synthetic `"DRIVER:null"` profiles.

---

## 4. 32-Alert Risk Domain Mapping Table

| Alert Type | Severity | Base Impact | Vehicle Risk Domain? | Driver Risk Domain? |
|---|---|---|---|---|
| `speeding` | HIGH | $+18$ | Yes | Yes |
| `harsh_acceleration` | MEDIUM | $+10$ | Yes | Yes |
| `harsh_braking` | MEDIUM | $+10$ | Yes | Yes |
| `distraction` | HIGH | $+18$ | Yes | Yes |
| `vibration` | MEDIUM | $+8$ | Yes | Yes |
| `fatigue` | HIGH | $+20$ | Yes | Yes |
| `smoking` | MEDIUM | $+8$ | Yes | Yes |
| `seatbelt` | HIGH | $+15$ | Yes | Yes |
| `drinking` | HIGH | $+25$ | Yes | Yes |
| `lane_change` | MEDIUM | $+10$ | Yes | Yes |
| `ubi_acceleration` | MEDIUM | $+10$ | Yes | Yes |
| `ubi_deceleration` | MEDIUM | $+10$ | Yes | Yes |
| `driver_change` | MEDIUM | $+5$ | Yes | Yes |
| `idle` | LOW | $+3$ | Yes | No |
| `voice_alarm` | MEDIUM | $+8$ | Yes | Yes |
| `accident` | CRITICAL | $+45$ | Yes | Yes |
| `sos` | CRITICAL | $+45$ | Yes | Yes |
| `tampering` | HIGH | $+20$ | Yes | No |
| `camera_blocked` | HIGH | $+18$ | Yes | No |
| `low_battery` | MEDIUM | $+10$ | Yes | No |
| `gps_lost` | HIGH | $+15$ | Yes | No |
| `lte_jamming` | HIGH | $+15$ | Yes | No |
| `offline` | MEDIUM | $+10$ | Yes | No |
| `gps_restored` | LOW | $-5$ (Recovery) | Yes | No |
| `lte_restored` | LOW | $-5$ (Recovery) | Yes | No |
| `engine_failure` | CRITICAL | $+40$ | Yes | No |
| `fuel_drop` | HIGH | $+18$ | Yes | No |
| `ignition_on` | LOW | $+1$ | Yes | No |
| `ignition_off` | LOW | $0$ (Recovery trigger) | Yes | No |
| `geofence_exit` | HIGH | $+15$ | Yes | No |
| `geofence_enter` | LOW | $+2$ | Yes | No |
| `unknown` | MEDIUM | $+8$ | Yes | Yes |

---

## 5. Persistence & Data Contract

### Current State Schema (`context.risk`)

```json
{
  "generatedAt": "2026-09-02T11:40:00.000Z",
  "vehicleRisk": {
    "entityType": "vehicle",
    "entityKey": "PLATE:D31498",
    "score": 62,
    "level": "ELEVATED",
    "lastUpdated": "2026-09-02T11:40:00.000Z",
    "contributors": [
      {
        "eventId": "UID-101",
        "alertType": "speeding",
        "alertLabel": "Over Speed",
        "netImpact": 18,
        "timestamp": "2026-09-02T11:35:00.000Z"
      }
    ]
  },
  "driverRisk": {
    "entityType": "driver",
    "entityKey": "DRIVER:AHMED",
    "score": 62,
    "level": "ELEVATED",
    "lastUpdated": "2026-09-02T11:40:00.000Z",
    "contributors": [
      {
        "eventId": "UID-101",
        "alertType": "speeding",
        "alertLabel": "Over Speed",
        "netImpact": 18,
        "timestamp": "2026-09-02T11:35:00.000Z"
      }
    ]
  }
}
```

### Persistence Specification (`data/risk_state.json`)
- Stores compact entity states (`score`, `lastUpdated`, `contributors` capped at 10 items, `processedEventIds` capped at 100 items).
- Avoids scanning historical datasets. Loaded once on instantiation, saved automatically on update.

---

## 6. Verification & Test Metrics

- **Dedicated Test Suite**: `tests/test_riskFoundation.js` (**27 / 27 PASSED ✅**)
- **Full System Regression Baseline**: `npm test` (**270 / 270 PASSED ✅**)
  - Phase 1 Correlation: 15 / 15
  - Phase 2 Grouping: 28 / 28
  - Phase 3.1 Intelligence: 24 / 24
  - Phase 3.2 Lifecycle: 35 / 35
  - Phase 3.3 Interpretation: 28 / 28
  - Phase 3.4 Hardening: 42 / 42
  - Feature #3 Phase 1 Risk Foundation: 27 / 27
  - Phase 4 System Regression Validation: 71 / 71

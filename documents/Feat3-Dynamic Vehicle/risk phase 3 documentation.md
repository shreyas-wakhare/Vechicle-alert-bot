# Feature #3 — Phase 3: Operational Recommendations & Manager Action Directives

## Executive Summary

Feature #3 Phase 3 introduces a deterministic, explainable operational recommendation engine (`services/operationalRecommendationEngine.js`) built directly on top of the frozen Feature #3 Phase 1 (RiskEngine), Feature #3 Phase 2 (RiskTrendEngine), Feature #2 (Alert Correlation & Incident Intelligence), and Feature #1 (Event Context) pipelines.

Phase 3 answers:
- **WHAT is happening?** (Real-time telemetry and context)
- **WHY is the risk at this level?** (Feature #3 Phase 2 historical trend & top contributors)
- **WHAT does this mean operationally?** (`operationalMeaning`)
- **WHAT should the fleet manager do next?** (`recommendedAction` containing `urgency`, `directive`, and `category`)

Phase 3 strictly avoids AI/LLMs, machine learning, predictive analytics, database migrations, and notification redesigns.

**Status**: **COMPLETE / FROZEN 🔒**  
**Date Completed**: 2026-09-02  
**Test Suite Metric**: 36 / 36 PASSED ✅  
**Full System Baseline**: 333 / 333 PASSED ✅

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
   │ 8. RiskEngine (Feature #3 Phase 1) ──► context.risk
   │ 9. RiskTrendEngine (Feature #3 Phase 2) ──► context.riskTrend
   ▼
OperationalRecommendationEngine (services/operationalRecommendationEngine.js) ◄── [Feature #3 Phase 3 Integration]
   │ ──► Reads context.risk, context.riskTrend, & context.alertCorrelation
   │ ──► Generates Vehicle & Driver Operational Meanings & Directives
   ▼
context.riskRecommendation (Attached additively to EventContext)
```

---

## 2. Core Capabilities & Decision Logic

### A. Deterministic Urgency Mapping (`urgency`)
- `IMMEDIATE_ACTION`: `CRITICAL` risk level, OR SOS / accident / engine_failure, OR `HIGH` risk level + `RISING` trend, OR Feature #3.2 pattern/severity escalation detected.
- `HIGH_PRIORITY`: `HIGH` risk level (stable/improving), OR repeated dangerous behavior (`count >= 2` for `HIGH`/`CRITICAL` alert types), OR tampering / camera_blocked / fuel_drop.
- `FOLLOW_UP`: `ELEVATED` or `MEDIUM` risk level, OR repeated `MEDIUM` behavior, OR connectivity disruption (`gps_lost`, `lte_jamming`, `offline`), OR geofence_exit.
- `MONITOR`: `LOW` risk level, OR single minor alert, OR signal recovery alert (`gps_restored`, `lte_restored`).
- `NO_ACTION`: Ignition events or stable clean activity without active risk.

### B. Action Category & Alert-Specific Directives (`category`, `directive`)
- `DRIVER_COACHING_REQUIRED`: 
  - `speeding`: *"Contact driver to enforce speed limits and schedule speed coaching session."*
  - `harsh_braking` / `harsh_acceleration` / `ubi_acceleration` / `ubi_deceleration` / `lane_change`: *"Contact driver to review vehicle handling and enforce smooth driving standards."*
  - `distraction`: *"Contact driver to review cabin distraction policy and enforce focus on the road."*
  - `seatbelt`: *"Contact driver to enforce mandatory seatbelt usage policy for all occupants."*
  - `smoking`: *"Contact driver to enforce cabin anti-smoking policy."*
  - `vibration` / `voice_alarm`: *"Contact driver to review cabin alarm triggers and rough vehicle handling."*
  - `idle`: *"Contact driver to review engine idling policy and reduce unnecessary idle time."*
- `IMMEDIATE_DRIVER_CONTACT`: Drinking while driving, SOS emergency, fatigue driving (*"Contact driver immediately to halt trip and confirm driver safety status."*).
- `SAFETY_REVIEW_REQUIRED`: Accident collision, repeated severe safety violations (*"Dispatch safety response team and initiate incident investigation."*).
- `VEHICLE_INSPECTION_REQUIRED`: Engine failure / overheat, low battery / power shutdown (*"Dispatch field service technician or route vehicle to maintenance facility for inspection."*).
- `SECURITY_REVIEW_REQUIRED`: Device tampering, camera screen blocked (*"Inspect vehicle hardware and verify telematics unit security seal."*).
- `CONNECTIVITY_CHECK_REQUIRED`: GPS lost / signal jamming, LTE jamming, device offline (*"Check device power supply and verify LTE/GPS signal coverage in area."*).
- `ROUTE_REVIEW_REQUIRED`: Geofence exit / zone violation (*"Contact driver to verify route authorization for current location."*).
- `FUEL_INVESTIGATION_REQUIRED`: Fuel drop / theft anomaly (*"Inspect fuel tank sensor and check recent fuel transaction logs."*).
- `MONITOR_ONLY`: Signal restored alerts (`gps_restored`, `lte_restored`), vehicle-only alerts on driver entity (*"Continue standard automated monitoring of vehicle activity."*).
- `NO_ACTION_REQUIRED`: Low risk clean state (*"No action required; vehicle operates within normal parameters."*).

---

## 3. Domain-Aware Safety & Determinism Specification

- **Domain Safety Guard**: Vehicle-only alert types (`tampering`, `camera_blocked`, `low_battery`, `engine_failure`, `gps_lost`, `lte_jamming`, `offline`, `fuel_drop`, `geofence_exit`, `geofence_enter`, `ignition_on`, `ignition_off`, `gps_restored`, `lte_restored`, `idle`) map to `MONITOR_ONLY` / `NO_ACTION_REQUIRED` for the driver entity, preventing false driver coaching directives on device/hardware alerts.
- **Determinism Specification**: Decision fields (`urgency`, `category`, `operationalMeaning`, `directive`) are 100% deterministic functions of context inputs; `generatedAt` is runtime metadata timestamp.

---

## 3. Data Contract (`context.riskRecommendation`)

```json
{
  "generatedAt": "2026-09-02T12:45:00.000Z",
  "vehicle": {
    "entityKey": "PLATE:D31498",
    "riskLevel": "HIGH",
    "trend": "RISING",
    "operationalMeaning": "Repeated over speed alerts (3x) exceed speed limit, increasing collision risk and vehicle wear.",
    "recommendedAction": {
      "urgency": "IMMEDIATE_ACTION",
      "directive": "Contact driver to enforce speed limits and schedule safety coaching session.",
      "category": "DRIVER_COACHING_REQUIRED"
    }
  },
  "driver": {
    "entityKey": "DRIVER:AHMED",
    "riskLevel": "HIGH",
    "trend": "RISING",
    "operationalMeaning": "Repeated over speed alerts (3x) exceed speed limit, increasing collision risk and vehicle wear.",
    "recommendedAction": {
      "urgency": "IMMEDIATE_ACTION",
      "directive": "Contact driver to enforce speed limits and schedule safety coaching session.",
      "category": "DRIVER_COACHING_REQUIRED"
    }
  }
}
```

---

## 4. Verification & Test Metrics

- **Dedicated Test Suite**: `tests/test_riskRecommendations.js` (**36 / 36 PASSED ✅**)
- **Full System Baseline**: `npm test` (**333 / 333 PASSED ✅**)
  - Feature #2 Phase 1 Correlation: 15 / 15
  - Feature #2 Phase 2 Grouping: 28 / 28
  - Feature #2 Phase 3.1 Intelligence: 24 / 24
  - Feature #2 Phase 3.2 Lifecycle: 35 / 35
  - Feature #2 Phase 3.3 Interpretation: 28 / 28
  - Feature #2 Phase 3.4 Hardening: 42 / 42
  - Feature #3 Phase 1 Risk Scoring: 27 / 27
  - Feature #3 Phase 2 Risk Trends: 27 / 27
  - Feature #3 Phase 3 Recommendations: 36 / 36
  - Phase 4 System Regression Validation: 71 / 71

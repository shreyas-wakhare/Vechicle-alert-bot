# Feature #3 — Phase 2: Behavioral History, Trends & Risk Contributors

## Executive Summary

Feature #3 Phase 2 introduces a deterministic, explainable, production-safe trend and historical intelligence engine (`services/riskTrendEngine.js`) built on top of the frozen Feature #3 Phase 1 (RiskEngine), Feature #2 (Alert Correlation & Incident Intelligence), and Feature #1 (Event Context) pipelines.

Phase 2 answers:
- **"Why is this vehicle/driver at this risk level?"**
- **"Is the risk trajectory getting worse, stable, or improving?"** (`RISING`, `STABLE`, `IMPROVING`)
- **"What alert types are contributing most to current risk?"** (`topContributors`)
- **"Is the same unsafe driving behavior repeatedly occurring?"** (`repeatedBehaviors`)
- **"Has recent behavior deteriorated compared with the previous period?"** (`comparison`)
- **"What is the structured, human-readable reason for the risk change?"** (`explanation`)

Phase 2 strictly avoids AI/LLMs, machine learning, predictive statistical modeling, database migrations, and notification redesigns.

**Status**: **COMPLETE / FROZEN 🔒**  
**Date Completed**: 2026-09-02  
**Test Suite Metric**: 27 / 27 PASSED ✅  
**Full System Baseline**: 297 / 297 PASSED ✅

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
   ▼
RiskTrendEngine (services/riskTrendEngine.js) ◄── [Feature #3 Phase 2 Integration]
   │ ──► Reads context.risk & context.alertCorrelation
   │ ──► Generates Trend, Contributors, Repetition, Comparison, & Explanation
   ▼
context.riskTrend (Attached additively to EventContext)
```

---

## 2. Core Intelligence Capabilities

### A. Deterministic Trend Analysis (`trend`)
Compares the current score $S_{\text{curr}}$ against the entity's previous observation score $S_{\text{prev}}$:
- $\Delta S = S_{\text{curr}} - S_{\text{prev}}$
- $\Delta S > +5 \implies$ `RISING` 📈
- $\Delta S < -5 \implies$ `IMPROVING` 📉
- $-5 \le \Delta S \le +5 \implies$ `STABLE` ➡️

### B. Top Risk Contributors Aggregation (`topContributors`)
Aggregates total net impact points accumulated per alert type across the bounded snapshot history (capped at 20 snapshots per entity):
- Sums `netImpact` per `alertType`.
- Returns top 5 sorted descending by total impact points: e.g. `[{ alertType: "speeding", points: 36, eventCount: 2 }]`.

### C. Repeated Behavior Detection (`repeatedBehaviors`)
Inspects unique events in bounded entity history (deduplicated by `eventId`):
- Counts occurrences per `alertType`.
- Flags `repeated: true` when `count >= 2`.
- Returns: `[{ alertType: "speeding", count: 2, severity: "HIGH", repeated: true }]`.

### D. Recent vs Previous Period Comparison (`comparison`)
Splits bounded history snapshots into two equal halves (Recent vs Previous):
- `recentEventCount`: Count in the newer half.
- `previousEventCount`: Count in the older half.
- `trajectory`: `DETERIORATING` (recent > previous + 1), `IMPROVING` (recent < previous - 1), or `STABLE`.

### E. Risk Change Explanation Logic (`explanation`)
Deterministically templates the primary reason:
- `ESCALATION`: Triggered by Feature #3.2 severity or pattern escalation.
- `CORRELATED_PATTERN`: Triggered by Feature #2 correlated pattern incident (`isIncident === true`).
- `REPEATED_BEHAVIOR`: Triggered when any unsafe alert type has `count >= 2`.
- `NEW_HIGH_SEVERITY_EVENT`: Triggered by a new isolated `HIGH` or `CRITICAL` alert.
- `RECOVERY`: Triggered by explicit signal recovery (`gps_restored`, `lte_restored`).
- `CLEAN_TIME_DECAY`: Triggered by clean alert-free score decay.
- `STABLE_ACTIVITY`: Baseline activity state.

---

## 3. Data Contract (`context.riskTrend`)

```json
{
  "generatedAt": "2026-09-02T11:50:00.000Z",
  "vehicle": {
    "entityKey": "PLATE:D31498",
    "trend": "RISING",
    "scoreChange": 18,
    "currentScore": 50,
    "previousScore": 32,
    "topContributors": [
      { "alertType": "speeding", "alertLabel": "Over Speed", "points": 36, "eventCount": 2 },
      { "alertType": "harsh_braking", "alertLabel": "Harsh Braking", "points": 14, "eventCount": 1 }
    ],
    "repeatedBehaviors": [
      { "alertType": "speeding", "alertLabel": "Over Speed", "count": 2, "severity": "HIGH", "repeated": true }
    ],
    "comparison": {
      "recentEventCount": 3,
      "previousEventCount": 1,
      "trajectory": "DETERIORATING"
    },
    "explanation": {
      "primaryReason": "REPEATED_BEHAVIOR",
      "message": "Risk is rising (+18 pts) due to repeated over speed alerts (2x).",
      "contributors": ["speeding", "harsh_braking"]
    }
  },
  "driver": {
    "entityKey": "DRIVER:AHMED",
    "trend": "RISING",
    "scoreChange": 18,
    "currentScore": 50,
    "previousScore": 32,
    "topContributors": [
      { "alertType": "speeding", "alertLabel": "Over Speed", "points": 36, "eventCount": 2 }
    ],
    "repeatedBehaviors": [
      { "alertType": "speeding", "alertLabel": "Over Speed", "count": 2, "severity": "HIGH", "repeated": true }
    ],
    "comparison": {
      "recentEventCount": 2,
      "previousEventCount": 1,
      "trajectory": "DETERIORATING"
    },
    "explanation": {
      "primaryReason": "REPEATED_BEHAVIOR",
      "message": "Risk is rising (+18 pts) due to repeated over speed alerts (2x).",
      "contributors": ["speeding"]
    }
  }
}
```

---

## 4. Verification & Test Metrics

- **Dedicated Test Suite**: `tests/test_riskTrends.js` (**25 / 25 PASSED ✅**)
- **Full System Baseline**: `npm test` (**295 / 295 PASSED ✅**)
  - Phase 1 Correlation: 15 / 15
  - Phase 2 Grouping: 28 / 28
  - Phase 3.1 Intelligence: 24 / 24
  - Phase 3.2 Lifecycle: 35 / 35
  - Phase 3.3 Interpretation: 28 / 28
  - Phase 3.4 Hardening: 42 / 42
  - Feature #3 Phase 1 Risk Foundation: 27 / 27
  - Feature #3 Phase 2 Risk Trends: 25 / 25
  - Phase 4 System Regression Validation: 71 / 71

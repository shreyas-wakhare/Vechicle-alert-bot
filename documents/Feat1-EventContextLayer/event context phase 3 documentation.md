# Event Context Layer — Phase 3: Context Intelligence Architecture

**Implementation Date:** 02 September 2026  
**Module:** `services/contextIntelligenceEngine.js` & `services/eventContext.js`  
**Repository:** `vehicle-alert-bot`  
**Phase:** 3 of 4 (Context Intelligence / Pattern & Risk Signal Engine)  

---

## 1. Executive Purpose

Phase 3 introduces a **deterministic, explainable Context Intelligence Layer** on top of Phase 1 (`EventContext`) and Phase 2 (`recentActivity`). 

While Phase 1 answers *"What is this event?"* and Phase 2 answers *"What happened around this vehicle recently?"*, Phase 3 answers:
> *"Does the recent combination of events indicate a meaningful pattern, sequence, escalation, cluster, or contextual risk signal?"*

### Critical Architectural Principle: Zero AI / Zero LLM
Phase 3 is **100% deterministic rule-based intelligence**. It uses zero external AI calls, zero neural networks, and zero LLMs. It establishes a factual, evidence-backed signal foundation that can later be safely consumed by Phase 4 validation and a future AI explanation layer.

---

## 2. End-to-End Pipeline Architecture

```text
                               Email Arrives (MIME)
                                        │
                                        ▼
                               AlertParser.parse()
                                        │
                                        ▼
                             EventContextBuilder.build()
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            ▼                           ▼                           ▼
         PHASE 1                     PHASE 2                     PHASE 3
      EVENT CONTEXT              RECENT ACTIVITY          CONTEXT INTELLIGENCE
  "What is this event?"     "What happened recently?"  "What pattern exists?"
            │                           │                           │
            └───────────────────────────┴───────────────────────────┘
                                        │
                                        ▼
                       { alertDef, fields, context }
                                        │
                                        ▼
                           Existing Business Rules &
                          WhatsApp Notification Flow
                             (100% UNCHANGED)
```

---

## 3. `contextIntelligence` Schema Specification

Phase 3 extends `EventContext` by adding a top-level `contextIntelligence` object:

```json
{
  "eventId": "UID-118228",
  "alertType": "distraction",
  "alertLabel": "Distraction / Phone Use",
  "severity": "HIGH",
  "timestamp": "2026-09-01T17:13:28.000Z",
  "vehicle": { "plate": "CC-48315", "imei": "864201040123456" },

  "recentActivity": { /* Phase 2 5m/15m/30m/60m windows */ },

  "contextIntelligence": {
    "generatedAt": "2026-09-01T17:13:28.000Z",
    "signals": [
      {
        "type": "EVENT_COMBINATION",
        "code": "SPEEDING_WITH_DISTRACTION",
        "category": "COMBINATION",
        "level": "HIGH",
        "alertType": "distraction",
        "message": "Overspeeding and driver distraction detected together in 15-minute window.",
        "reason": "Alert combination [speeding + distraction] detected within 15 minutes.",
        "evidence": {
          "window": "15m",
          "alertTypes": ["speeding", "distraction"],
          "eventIds": ["UID-118220", "UID-118228"],
          "count": 2
        },
        "vehicleState": {
          "ignition": "ON",
          "tripActive": true
        }
      }
    ],
    "summary": {
      "signalCount": 1,
      "highestLevel": "HIGH",
      "hasEscalation": false,
      "hasRepeatedViolation": false,
      "hasSequence": true,
      "hasCombination": true,
      "hasCluster": false,
      "hasContextualRisk": false
    }
  }
}
```

---

## 4. Rule Categories & Detection Mechanics

All detection logic resides in `services/contextIntelligenceEngine.js` and is completely configuration-driven.

### 1. Repetition Detector (`REPEATED_EVENT`)
*   **Rule:** Detects $\ge 2$ occurrences of the same alert type within 15m.
*   **Levels:** 2x $\to$ `MEDIUM`, 3x $\to$ `HIGH`, $\ge 4$x $\to$ `CRITICAL`.
*   **Example Code:** `REPEATED_DISTRACTION`.

### 2. Sequence Detector (`SEQUENCE`)
*   **Rule:** Detects chronological, ordered sequences within defined max time gaps.
*   **Configured Sequences:**
    *   `speeding` $\to$ `harsh_braking` ($\le 10\text{m}$) $\to$ `SPEEDING_TO_HARSH_BRAKING` (level: `HIGH`)
    *   `harsh_acceleration` $\to$ `speeding` $\to$ `harsh_braking` ($\le 15\text{m}$) $\to$ `AGGRESSIVE_DRIVING_SEQUENCE` (level: `HIGH`)
    *   `distraction` $\to$ `speeding` ($\le 10\text{m}$) $\to$ `DISTRACTION_TO_SPEEDING` (level: `HIGH`)
    *   `distraction` $\to$ `harsh_braking` ($\le 10\text{m}$) $\to$ `DISTRACTION_TO_HARSH_BRAKING` (level: `HIGH`)
    *   `fatigue` $\to$ `speeding` ($\le 15\text{m}$) $\to$ `FATIGUE_TO_SPEEDING` (level: `CRITICAL`)
    *   `drinking` $\to$ `speeding` ($\le 15\text{m}$) $\to$ `DRINKING_TO_SPEEDING` (level: `CRITICAL`)

### 3. Combination Detector (`COMBINATION`)
*   **Rule:** Detects un-ordered co-occurrence of distinct alert types within 15m.
*   **Configured Combinations:**
    *   `speeding` + `distraction` $\to$ `SPEEDING_WITH_DISTRACTION` (level: `HIGH`)
    *   `speeding` + `harsh_braking` $\to$ `SPEEDING_WITH_HARSH_BRAKING` (level: `MEDIUM`)
    *   `fatigue` + `speeding` $\to$ `FATIGUE_WITH_SPEEDING` (level: `CRITICAL`)
    *   `drinking` + `speeding` $\to$ `DRINKING_WITH_SPEEDING` (level: `CRITICAL`)
    *   `vibration` + `distraction` $\to$ `VIBRATION_WITH_DISTRACTION` (level: `MEDIUM`)

### 4. Cluster Detector (`CLUSTER`)
*   **Rule:** Detects high event density: $\ge 4$ total events across $\ge 3$ distinct alert types in 15m.
*   **Code:** `HIGH_EVENT_DENSITY_CLUSTER` (level: `HIGH`).

### 5. Escalation Detector (`ESCALATION`)
*   **Rule:** Detects increasing severity progression (e.g. `LOW` $\to$ `MEDIUM` $\to$ `HIGH`/`CRITICAL`) within 15m.
*   **Code:** `VIOLATION_ESCALATION` (level: `HIGH`/`CRITICAL`).

### 6. Contextual Risk Detector (`CONTEXTUAL_RISK`)
*   **Rule 1:** `HIGH` or `CRITICAL` alert while `trip.active === true` $\to$ `ACTIVE_TRIP_HIGH_SEVERITY_VIOLATION`.
*   **Rule 2:** $\ge 3$ safety alerts while `trip.active === true` within 15m $\to$ `REPEATED_ACTIVE_TRIP_RISK` (level: `CRITICAL`).

---

## 5. Signal Evidence, Priority & Failure Isolation

1.  **Explainability & Evidence:** Every signal includes a human-readable `message`, a factual `reason`, and an `evidence` dictionary containing the time window, count, involved alert types, and exact event IDs (`['UID-118220', 'UID-118228']`).
2.  **Deterministic Priority Sorting:** Signals are sorted strictly by `Level` (`CRITICAL` $>$ `HIGH` $>$ `MEDIUM` $>$ `LOW`), then `Category` (`CONTEXTUAL_RISK` $>$ `ESCALATION` $>$ `SEQUENCE` $>$ `COMBINATION` $>$ `CLUSTER` $>$ `REPEATED_EVENT`), then `Code`.
3.  **Failure Isolation:** `ContextIntelligenceEngine.analyze(context)` is wrapped in a try-catch block inside `EventContextBuilder`. If any rule evaluation fails, an empty intelligence structure is returned and logged without interrupting alert parsing or notification delivery.
4.  **Performance:** Operates strictly on `context.recentActivity` ($O(\text{recent activity})$). Analysis completes in **$0.023\text{ms}$** per alert.

---

## 6. Explicit Phase 3 / Phase 4 Boundary

Phase 3 produces **structured intelligence signals only**. It explicitly **does NOT**:
*   ❌ Modify WhatsApp group alerts or supervisor DMs
*   ❌ Overwrite legacy alert severity or business rules
*   ❌ Introduce automated AI reasoning or LLM calls
*   ❌ Modify persistent JSON schemas (`history.json`, `trips.json`, `state.json`)

Phase 4 will evaluate and validate whether Phase 3 signals are accurate and valuable before any future notification integration is performed.

---

## 7. Verification Results

Executed `node tests/test_contextIntelligence.js` (27/27 Passed):

```text
────────────────────────────────────────────────────────────
🧪 RUNNING EVENT CONTEXT LAYER PHASE 3 VERIFICATION TESTS
────────────────────────────────────────────────────────────

✅ [PASS] TEST 1 — No recent activity produces no multi-event signals
✅ [PASS] TEST 2 — Single event baseline
✅ [PASS] TEST 3 — Repeated same event detection (3x distraction in 15m)
✅ [PASS] TEST 4 — Repeated event outside 15m window ignored
✅ [PASS] TEST 5 — Valid sequence detection (speeding -> harsh_braking)
✅ [PASS] TEST 6 — Invalid sequence order rejected (harsh_braking -> speeding)
✅ [PASS] TEST 7 — Sequence exceeding max gap rejected (>10 min gap)
✅ [PASS] TEST 8 — Valid alert combination (speeding + distraction)
✅ [PASS] TEST 9 — Combination outside window rejected (>15 min gap)
✅ [PASS] TEST 10 — High event density cluster detection (4+ events, 3+ types)
✅ [PASS] TEST 11 — Insufficient cluster density rejected (<3 distinct types)
✅ [PASS] TEST 12 — Violation severity escalation detection
✅ [PASS] TEST 13 — Non-escalating same-severity events
✅ [PASS] TEST 14 — Intelligence vehicle isolation (Vehicle A vs Vehicle B)
✅ [PASS] TEST 15 — Current event duplicate protection
✅ [PASS] TEST 16 — Duplicate historical event protection
✅ [PASS] TEST 17 — Out-of-order sequence detection by event timestamp
✅ [PASS] TEST 18 — Contextual risk signal during active trip
✅ [PASS] TEST 19 — Ignition OFF context risk evaluation
✅ [PASS] TEST 20 — Missing optional data safety
✅ [PASS] TEST 21 — Multiple signals deterministic priority ordering
✅ [PASS] TEST 22 — Signal evidence model completeness
✅ [PASS] TEST 23 — Signal human-readable explainability (reason & message)
      ↳ Analysis performance: 0.023 ms
✅ [PASS] TEST 24 — Intelligence analysis performance bound (<1ms per alert)
✅ [PASS] TEST 25 — Phase 2 recentActivity regression verification
✅ [PASS] TEST 26 — Phase 1 EventContext schema regression verification
✅ [PASS] TEST 27 — Legacy parsed result contract non-regression

────────────────────────────────────────────────────────────
📊 TEST RESULTS: 27 Passed | 0 Failed
────────────────────────────────────────────────────────────
```

Executed `node tests/test_recentActivity.js` (Phase 2): 20/20 Passed.  
Executed `node tests/test_eventContext.js` (Phase 1): 6/6 Passed.

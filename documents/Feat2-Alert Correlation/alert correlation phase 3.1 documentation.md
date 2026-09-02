# Feature #2 Phase 3.1 — Correlation Intelligence (Intelligence Foundation) Technical Documentation

## 1. Overview & Objective

**Feature #2 Phase 3.1 (Correlation Intelligence — Intelligence Foundation)** enriches the existing Phase 2 incident object with deterministic operational intelligence (`incident.intelligence`). It provides:
- Strict lifecycle status tracking (`DETECTED` vs `ACTIVE`).
- Chronological event sequence extraction (consuming Phase 1 ascending ordering with defensive fallback sorting).
- Initiating event (`initiatingEvent`) vs rule primary trigger (`primaryTrigger`) separation.
- Supporting events array (`supportingEvents`).
- Continuation and escalation stubs for Phase 3.2 extension.
- Operational explanation summary.

Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.

---

## 2. Architecture & Data Flow

`IncidentIntelligenceEngine` (`services/incidentIntelligenceEngine.js`) is integrated into `IncidentGroupingEngine.group()` to enrich the classified `incident` object before returning.

```text
                  EventContext (Feature #1)
                             │
                             ▼
                AlertCorrelationEngine (Phase 1)
                             │
                             ▼
                IncidentGroupingEngine (Phase 2)
                             │
                             ▼
            IncidentIntelligenceEngine (Phase 3.1)
                             │
                             ▼
        context.alertCorrelation.incident.intelligence = {
          status: "ACTIVE",
          lifecycle: { status: "ACTIVE", startedAt, latestAt, durationSeconds },
          sequence: ["harsh_acceleration", "speeding", "harsh_braking"],
          initiatingEvent: "harsh_acceleration",
          primaryTrigger: "speeding",
          supportingEvents: ["speeding", "harsh_braking"],
          escalation: { detected: false, previousIncidentType: null },
          continuation: { isContinuation: false, previousIncidentId: null },
          summary: { explanation: "..." }
        }
```

---

## 3. Semantic Definitions & Contracts

### A. Initiating Event vs Primary Trigger
- **`initiatingEvent`**: The chronological first event in the correlated sequence (`sequence[0]`).
- **`primaryTrigger`**: The rule-matched primary alert type that triggered the incident pattern.
- **`supportingEvents`**: All subsequent events in the sequence after excluding the single initiating event instance.

### B. Lifecycle Status Semantics
- **`DETECTED`**: Single-event correlations (`!isCorrelated || eventCount <= 1`), representing a newly identified standalone alert.
- **`ACTIVE`**: Multi-event correlated incidents (`isCorrelated === true && eventCount > 1`), representing an active continuing alert stream.
- **`RESOLVED`**: Explicitly reserved for Phase 3.2 extension (never faked in Phase 3.1).

### C. Sequence Ordering Contract
- `IncidentIntelligenceEngine` consumes chronological ascending events guaranteed by `AlertCorrelationEngine` and applies defensive sorting as a safety invariant.

---

## 4. Test Suite & Results

- **Intelligence Suite (`test_incidentIntelligence.js`):** **24 / 24 PASSED** ✅
- **Incident Grouping Suite (`test_incidentGrouping.js`):** **28 / 28 PASSED** ✅
- **Correlation Suite (`test_alertCorrelation.js`):** **15 / 15 PASSED** ✅
- **Phase 4 Regression Suite (`test_phase4_validation.js`):** **71 / 71 PASSED** ✅
- **Total Automated Test Baseline (`npm test`):** **138 / 138 PASSED** ✅

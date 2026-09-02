# Feature #2 Phase 3.2 — Continuation, Escalation & Incident Lifecycle Technical Documentation

## 1. Overview & Scope

**Feature #2 Phase 3.2 (Continuation, Escalation & Incident Lifecycle)** extends the intelligence foundation of Phase 3.1 by introducing a dedicated engine (`IncidentLifecycleEngine`) to evaluate:
- **Incident Continuation & Merging:** Detects active continuation streams (`isContinuation: true`), preserves stable incident identifiers (`previousIncidentId`), and tracks merged event counts.
- **Escalation Detection:** Identifies severity escalations (e.g. `LOW` $\rightarrow$ `HIGH` $\rightarrow$ `CRITICAL`) and pattern escalations (e.g., `AGGRESSIVE_DRIVING` $\rightarrow$ `ACCIDENT_EVENT`, `CONNECTIVITY_DISRUPTION` $\rightarrow$ `DEVICE_SECURITY_INCIDENT`).
- **Explicit Recovery Resolution:** Transitions status to `RESOLVED` ONLY upon explicit recovery alerts (`gps_restored`, `lte_restored`, `ignition_off` for driving session incidents). Emergency incidents (`ACCIDENT_EVENT`, `DEVICE_SECURITY_INCIDENT`, `DEVICE_TAMPERING`, `SOS_EMERGENCY`) are NOT falsely resolved by `ignition_off`.

Strictly NO AI, NO LLM, NO Machine Learning, NO Risk Scoring, NO Confidence percentages.

---

## 2. Architecture & Data Flow

`IncidentLifecycleEngine` (`services/incidentLifecycleEngine.js`) is instantiated inside `IncidentIntelligenceEngine` (`services/incidentIntelligenceEngine.js`).

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
             IncidentLifecycleEngine (Phase 3.2)
                             │
                             ▼
        context.alertCorrelation.incident.intelligence = {
          status: "ACTIVE", // DETECTED, ACTIVE, or RESOLVED
          lifecycle: {
            status: "ACTIVE",
            startedAt: "...",
            latestAt: "...",
            durationSeconds: 360,
            resolutionReason: null
          },
          sequence: ["speeding", "harsh_acceleration", "harsh_braking"],
          initiatingEvent: "speeding",
          primaryTrigger: "speeding",
          supportingEvents: ["harsh_acceleration", "harsh_braking"],
          escalation: {
            detected: true,
            previousIncidentType: "AGGRESSIVE_DRIVING",
            reason: "Escalated to ACCIDENT_EVENT from AGGRESSIVE_DRIVING due to critical collision alert."
          },
          continuation: {
            isContinuation: true,
            previousIncidentId: "CORR-PLATE-D31498-1772532000000",
            mergedEventCount: 3
          },
          summary: { explanation: "..." }
        }
```

---

## 3. Key Rules & Semantics

### A. Incident Continuation & Merging
- **`continuation.isContinuation`**: `true` when a multi-event correlation stream (`isCorrelated === true && eventCount > 1`) is active for the vehicle key.
- **`continuation.previousIncidentId`**: Stable `correlationId` identifier of the active stream.
- **`continuation.mergedEventCount`**: Count of events merged into the active window.

### B. Escalation Detection
- **Pattern Escalation:**
  - `speeding` / `harsh_acceleration` / `harsh_braking` $\rightarrow$ `accident` $\Rightarrow$ `previousIncidentType: 'AGGRESSIVE_DRIVING'`, `reason`: collision escalation.
  - `gps_lost` / `lte_jamming` $\rightarrow$ `tampering` $\Rightarrow$ `previousIncidentType: 'CONNECTIVITY_DISRUPTION'`, `reason`: tampering escalation.
- **Severity Escalation:**
  - Upgrades from lower severity (`LOW` / `MEDIUM`) to higher severity (`HIGH` / `CRITICAL`) within the active stream.
  - Duplicate processing of the identical event ID does NOT trigger false escalation.

### C. Explicit Recovery Resolution
- **Status Transitions:**
  - `gps_restored` $\rightarrow$ `RESOLVED` (`"Explicit recovery alert received: GPS signal restored"`).
  - `lte_restored` $\rightarrow$ `RESOLVED` (`"Explicit recovery alert received: LTE signal restored"`).
  - `ignition_off` after active driving stream $\rightarrow$ `RESOLVED` (`"Explicit recovery alert received: Driving session ended"`).
  - Emergency incidents (`ACCIDENT_EVENT`, `DEVICE_SECURITY_INCIDENT`, `DEVICE_TAMPERING`, `SOS_EMERGENCY`) remain `ACTIVE` even when `ignition_off` occurs.
  - Multi-event stream without recovery event $\rightarrow$ `ACTIVE`.
  - Standalone single event $\rightarrow$ `DETECTED`.

---

## 4. Test Coverage & Benchmark Results

- **Lifecycle Suite (`test_incidentLifecycle.js`):** **36 / 36 PASSED** ✅
- **Intelligence Suite (`test_incidentIntelligence.js`):** **24 / 24 PASSED** ✅
- **Incident Grouping Suite (`test_incidentGrouping.js`):** **28 / 28 PASSED** ✅
- **Alert Correlation Suite (`test_alertCorrelation.js`):** **15 / 15 PASSED** ✅
- **Phase 4 Regression Suite (`test_phase4_validation.js`):** **71 / 71 PASSED** ✅
- **Total Automated Test Baseline (`npm test`):** **174 / 174 PASSED** ✅

# Feature #4 — Phase 3: Fleet-Wide / Multi-Alert AI Synthesis & Prioritization Documentation

## Executive Summary

Feature #4 Phase 3 extends the `vehicle-alert-bot` AI intelligence layer from single-alert briefings to **Fleet-Wide / Multi-Alert Executive AI Synthesis & Prioritization**.

Phase 3 aggregates deterministic multi-alert context across active vehicles to produce a manager-facing fleet executive briefing answering:
1. What is happening across the fleet right now?
2. Which vehicles and incidents require manager attention first?
3. What are the dominant operational, safety, or hardware patterns?
4. Which vehicle risks are escalating or repeating?
5. What should the fleet manager focus on first?

**Status**: **COMPLETE / FROZEN 🔒 (Phase 3.1.1 Corrective Hardened)**  
**Date Completed**: 2026-09-02  
**Provider Status**: Mock-only runtime in current build (`createAIProvider` factory ready); live vendor API integration deferred to Phase 5.  
**Dedicated Phase 3 & 3.1.1 Test Suites**: 36 / 36 PASSED ✅ (10 Intelligence + 10 Hardening + 10 Synthesis + 6 Integration)  
**Full System Regression Baseline**: 488 / 488 PASSED ✅ (100%)

---

## 1. Golden Rule & Architectural Hierarchy

> **LLM = COMMUNICATOR & EXECUTIVE ANALYST, NOT CALCULATOR OR DECISION ENGINE.**

```text
Feature #1 (Event Context) + Feature #2 (Incidents) + Feature #3 (Dynamic Risk)
                                 │
                                 ▼
       FleetIntelligenceEngine (Universal Read-Only Evaluation)
                                 │
                                 ▼
                    AIFleetGroundTruthBuilder
                                 │
                                 ▼
                     AIFleetExecutiveSynthesis
             (AIRequestBuilder -> Provider -> Validator -> Fallback)
                                 │
                                 ▼
               MessageFormatter.formatFleetExecutiveBriefing
                                 │
                                 ▼
         DailySummary / Controlled Fleet Snapshot (WhatsApp)
```

---

## 2. Universal Chronological Risk Evaluation & Read-Only State Isolation (Phase 3.1.1)

1. **Universal Chronological Evaluation**: Records for each vehicle are sorted chronologically and processed sequentially through an isolated `EventContextBuilder` / `RiskEngine` instance over the window. The vehicle's cumulative `score`, `level`, `trend`, and `recommendation` universally reflect the full 24-hour alert history regardless of whether records already had single-record context attached.
2. **Read-Only Risk State Isolation**: `FleetIntelligenceEngine.evaluateFleet()` uses `new RiskEngine({ persist: false })`, guaranteeing that generating fleet executive reports is **100% READ-ONLY** and NEVER mutates persistent `risk_state.json` or modifies production risk state.

---

## 3. Strict Categorical Priority Hierarchy

Vehicles are assigned a **Strict Categorical Priority Tier (1 to 9)**:
- **Tier 1**: `CRITICAL` risk level
- **Tier 2**: `IMMEDIATE_ACTION` recommendation urgency
- **Tier 3**: Escalated active incident (`isEscalated === true`)
- **Tier 4**: `HIGH` risk level + `RISING` trend
- **Tier 5**: `HIGH` risk level
- **Tier 6**: Repeated unsafe behaviors (`repeatedTypes.length >= 1`)
- **Tier 7**: `ELEVATED` risk level
- **Tier 8**: `MEDIUM` risk level
- **Tier 9**: `LOW` risk level

### Deterministic Categorical Comparator:
1. `priorityTier` ascending (Tier 1 `CRITICAL` can NEVER be overtaken by any lower tier under any circumstances).
2. `riskScore` descending (higher score wins tie-break within same Tier).
3. `riskTrend` rank descending (`RISING` > `STABLE` > `IMPROVING`).
4. `alertCount` descending.
5. `plate` string ascending (lexicographical deterministic final tie-breaker).

---

## 4. Incident Map Window Aggregation

When an incident key exists, subsequent matching alerts in the window update:
- `eventCount`: Aggregates total matched events across the aggregation window.
- `isEscalated`: Set to `true` if any event in the window detects escalation.
- `highestSeverity`: Escalates if a higher severity event arrives.
- `status`: Updates to latest active status.

---

## 5. Schema & Output Contract

### AIFleetGroundTruthContract (`schemaVersion: '1.0'`)
- `fleet`: `{ totalFleetVehicles, vehicleCount, activeVehicleCount, alertCount, tripCount, incidentCount, criticalCount, highRiskVehicleCount }`
- `vehicles`: `[ { entityKey, plate, driver, risk, trend, recommendation, alertCount, incidentCount } ]`
- `incidents`: `[ { incidentId, vehicleKey, plate, type, severity, status, isEscalated, eventCount } ]`
- `patterns`: `[ { type, label, count, affectedVehicles } ]`
- `priorities`: `[ { vehicleKey, plate, driver, priorityRank, priorityTier, priorityReason, riskScore, riskLevel, trend, urgency, directive } ]`

---

## 6. Security & Isolation Bounds

- **Prompt-Injection Defense**: Raw email content is stored strictly inside `untrustedData.rawEmailText`. Privileged system instructions explicitly command the LLM to ignore embedded commands.
- **Validator Enforcement**: `AIFleetOutputValidator` rejects score/level overrides, invented vehicles, or priority re-ordering.
- **Zero Notification Spam**: Single alerts continue to use Phase 2 single-alert synthesis. Phase 3 Fleet Synthesis only runs at scheduled aggregation boundaries (e.g. `dailySummary.js`).

---

## 7. Full System Regression Baseline

- **Total Regression Test Count**: **488 / 488 PASSED (100%)**
- **Frozen Feature Changes**: **NONE** (Features #1–#3, Phase 1, and Phase 2 remain 100% frozen and untouched).

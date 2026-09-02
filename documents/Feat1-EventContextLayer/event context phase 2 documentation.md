# Event Context Layer — Phase 2: Recent Event Context Architecture

**Implementation Date:** 02 September 2026  
**Module:** `services/recentActivityEngine.js` & `services/eventContext.js`  
**Repository:** `vehicle-alert-bot`  
**Phase:** 2 of 4 (Recent Event Context / Recent Activity Engine)  

---

## 1. Executive Purpose

Phase 2 builds directly upon the Phase 1 `EventContext` foundation by providing factual **Recent Activity Context** for every incoming event. While Phase 1 answers *"What is this event?"*, Phase 2 answers *"What happened around this vehicle recently?"*

Phase 2 executes **zero decision-making, zero risk scoring, and zero notification changes**. It provides an $O(\text{recent})$ performant, vehicle-isolated activity engine capturing factual counts, repetitions, and time-sliced event summaries across 5-minute, 15-minute, 30-minute, and 60-minute windows.

---

## 2. Phase 2 `recentActivity` Schema Specification

Phase 2 extends the Phase 1 `EventContext` by adding a top-level `recentActivity` property:

```json
{
  "eventId": "UID-118228",
  "alertType": "distraction",
  "alertLabel": "Distraction / Phone Use",
  "severity": "HIGH",
  "timestamp": "2026-09-01T17:13:28.000Z",
  "source": "track9999",

  "vehicle": {
    "plate": "CC-48315",
    "model": null,
    "imei": "864201040123456",
    "driver": null
  },

  "telemetry": {
    "speed": 70.9,
    "speedLimit": null,
    "excessSpeed": null,
    "idleTime": null,
    "idleLimit": null,
    "overIdleTime": null
  },

  "location": {
    "address": null,
    "latitude": null,
    "longitude": null,
    "mapsUrl": null,
    "trackUrl": "http://track9999.com/position?id=99"
  },

  "trip": {
    "active": true,
    "ignitionState": "ON",
    "lastIgnitionOnTime": "2026-09-01T14:10:00.000Z",
    "lastIgnitionOffTime": "2026-09-01T10:00:00.000Z"
  },

  "metadata": {
    "emailUid": 118228,
    "receivedAt": "2026-09-01T17:13:28.000Z",
    "emailSubject": "Tracker Event Notification[Distraction Alert(70.9km/h)][CC-48315]",
    "rawSource": "track9999"
  },

  "recentActivity": {
    "generatedAt": "2026-09-01T17:13:28.000Z",
    "vehicleKey": "IMEI:864201040123456",
    "windows": {
      "5m": {
        "totalEvents": 1,
        "countsByAlertType": {
          "distraction": 1
        },
        "events": [
          {
            "eventId": "UID-118228",
            "alertType": "distraction",
            "alertLabel": "Distraction / Phone Use",
            "severity": "HIGH",
            "timestamp": "2026-09-01T17:13:28.000Z",
            "source": "track9999",
            "speed": 70.9,
            "address": null
          }
        ]
      },
      "15m": {
        "totalEvents": 2,
        "countsByAlertType": {
          "distraction": 1,
          "speeding": 1
        },
        "events": [
          {
            "eventId": "UID-118228",
            "alertType": "distraction",
            "alertLabel": "Distraction / Phone Use",
            "severity": "HIGH",
            "timestamp": "2026-09-01T17:13:28.000Z",
            "source": "track9999",
            "speed": 70.9,
            "address": null
          },
          {
            "eventId": "UID-118220",
            "alertType": "speeding",
            "alertLabel": "Over Speed",
            "severity": "HIGH",
            "timestamp": "2026-09-01T17:03:00.000Z",
            "source": "system1",
            "speed": 115,
            "address": "Al Quoz, Dubai"
          }
        ]
      },
      "30m": {
        "totalEvents": 2,
        "countsByAlertType": {
          "distraction": 1,
          "speeding": 1
        },
        "events": [ /* ... newest to oldest ... */ ]
      },
      "60m": {
        "totalEvents": 2,
        "countsByAlertType": {
          "distraction": 1,
          "speeding": 1
        },
        "events": [ /* ... newest to oldest ... */ ]
      }
    },
    "latestEvent": {
      "eventId": "UID-118228",
      "alertType": "distraction",
      "alertLabel": "Distraction / Phone Use",
      "severity": "HIGH",
      "timestamp": "2026-09-01T17:13:28.000Z"
    },
    "ignition": {
      "state": "ON",
      "active": true
    },
    "trip": {
      "active": true
    }
  }
}
```

---

## 3. Architecture & Performance Strategy

### A. $O(\text{recent})$ In-Memory Vehicle Cache
Scanning `history.json` (90,000+ records) on every incoming event is computationally unsustainable. `RecentActivityEngine` maintains an in-memory `Map<vehicleKey, Array<CompactSummary>>`:

1.  **Vehicle Identity (`deriveVehicleKey`):**
    *   Primary: `IMEI:<imei>` if IMEI is available.
    *   Secondary: `PLATE:<normPlate>` where plate is normalized (`(plate).toUpperCase().replace(/[\s\/\-]/g, '')`).
    *   Isolation: Vehicle A and Vehicle B maintain strictly separate arrays.
2.  **Memory Eviction:**
    *   Maximum required window: 60 minutes.
    *   Retention grace period: 15 minutes (to accommodate late/out-of-order arrivals).
    *   Total retention: 75 minutes. Any event older than 75 minutes relative to the vehicle's latest event is automatically evicted from memory.
3.  **Startup Rehydration:**
    *   On startup, `RecentActivityEngine.rehydrate()` scans `HistoryStore._records` backwards from the newest entry until reaching the 75-minute cutoff.
    *   Populates the in-memory cache in $\sim 0.2\text{ms}$ ONCE at boot time.
    *   Subsequent queries complete in $\sim 0.065\text{ms}$ per alert.

---

## 4. Key Mechanisms

### 1. Timestamp Priority & Ordering
*   **Timestamp Selection:** Uses `fields.alertTime` or `eventTime`; falls back to `receivedAt` or `mail.date`.
*   **Deterministic Sorting:** Events in each window (`5m`, `15m`, `30m`, `60m`) are sorted strictly **newest to oldest** (`newDate(b.timestamp) - newDate(a.timestamp)`).

### 2. Out-of-Order & Late Event Resiliency
If emails arrive out of chronological sequence (e.g. 10:00 event arrives after a 10:05 event), `_addSummaryToCache` inserts the event into the vehicle array and re-sorts by event timestamp. Window membership is evaluated against event time, not arrival time.

### 3. Current Event & Duplicate Deduplication
*   Events are deduplicated using `eventId` (e.g., `UID-118228`).
*   Current event is registered into the vehicle cache during `buildRecentActivity()` and appears **exactly once** in applicable time windows. Re-querying or duplicate email processing does not inflate event counts.

---

## 5. Explicit Phase 2 / Phase 3 Boundary

The following features are **explicitly excluded** from Phase 2 and reserved for Phase 3:
*   ❌ No Risk Scoring / Driver Risk Index
*   ❌ No Pattern Detection / Violation Sequence Rules
*   ❌ No Event Clustering / Anomaly Detection
*   ❌ No AI / LLM / Machine Learning Model Calls
*   ❌ No WhatsApp Notification or Escalation Changes

Phase 2 collects and presents **pure factual recent activity**. Phase 3 will consume `context.recentActivity` to trigger intelligent warnings and pattern alerts.

---

## 6. Verification Results

All 20 required unit and benchmark tests passed in `tests/test_recentActivity.js`:

```text
────────────────────────────────────────────────────────────
🧪 RUNNING EVENT CONTEXT LAYER PHASE 2 VERIFICATION TESTS
────────────────────────────────────────────────────────────

✅ [PASS] TEST 1 — No recent events
✅ [PASS] TEST 2 — Single recent event within 5 minutes
✅ [PASS] TEST 3 — 5-minute boundary precision
✅ [PASS] TEST 4 — 15-minute boundary precision
✅ [PASS] TEST 5 — 30-minute boundary precision
✅ [PASS] TEST 6 — 60-minute boundary precision
✅ [PASS] TEST 7 — Outside 60 minutes exclusion
✅ [PASS] TEST 8 — Multiple events across time windows
✅ [PASS] TEST 9 — Same alert repetition count calculation
✅ [PASS] TEST 10 — Different alert types breakdown
✅ [PASS] TEST 11 — Vehicle isolation (Vehicle A vs Vehicle B)
✅ [PASS] TEST 12 — Plate normalization consistency
✅ [PASS] TEST 13 — Current event single inclusion (no double count)
✅ [PASS] TEST 14 — Duplicate event handling by eventId
✅ [PASS] TEST 15 — Out-of-order event sorting by event timestamp
✅ [PASS] TEST 16 — Missing timestamp safety fallback
✅ [PASS] TEST 17 — Missing vehicle identity safety
✅ [PASS] TEST 18 — Startup rehydration from HistoryStore
      ↳ Rehydrate 100,000 records: 0.21 ms
      ↳ Recent query performance: 0.065 ms
✅ [PASS] TEST 19 — Large history O(recent) performance benchmark
✅ [PASS] TEST 20 — Non-regression of Phase 1 and legacy properties

────────────────────────────────────────────────────────────
📊 TEST RESULTS: 20 Passed | 0 Failed
────────────────────────────────────────────────────────────
```

# Feature #2 Phase 1 — Alert Correlation Foundation Technical Documentation

## 1. Overview & Objective

**Feature #2: Alert Correlation** connects multiple individual vehicle alerts that belong to the same underlying driving incident or operational timeframe.

**Phase 1 (Correlation Foundation)** establishes a standardized, in-memory correlation primitive (`AlertCorrelationEngine`) that aggregates alerts occurring within a 15-minute sliding window (with a 5-second timestamp grace tolerance) for a single isolated vehicle identity.

---

## 2. Architecture & Data Flow

Feature #2 Phase 1 strictly consumes existing Feature #1 primitives (`EventContext`, `RecentActivityEngine`, vehicle keys, event deduplication) without modifying upstream email monitoring, parsing, or WhatsApp notification formatting.

```text
               TRACKING PLATFORM
                       │
                       ▼
                   Raw Email
                       │
                       ▼
                 Email Monitor
                       │
                       ▼
                  Alert Parser
                       │
                       ▼
            EventContext Builder 
            ┌──────────┴──────────┐
            ▼                     ▼
     Recent Activity     Context Intelligence
            │                     │
            └──────────┬──────────┘
                       ▼
           AlertCorrelation Engine  <-- FEATURE #2 PHASE 1
                       │
                       ▼
         { alertDef, fields, context }
          ↳ context.alertCorrelation
                       │
                       ▼
             Message Formatter
                       │
                       ▼
             WhatsApp Bot / DMs
```

---

## 3. Correlation Schema

Every parsed alert carries `context.alertCorrelation` matching the following schema:

```json
{
  "correlationId": "CORR-PLATE:D31498-UID-101",
  "vehicleKey": "PLATE:D31498",
  "vehicle": {
    "plate": "D/31498",
    "model": "Toyota Hilux",
    "imei": null,
    "driver": "John Doe"
  },
  "status": "CORRELATED",
  "isCorrelated": true,
  "eventCount": 3,
  "eventIds": ["UID-101", "UID-102", "UID-103"],
  "eventTypes": ["speeding", "harsh_acceleration", "harsh_braking"],
  "events": [
    {
      "eventId": "UID-101",
      "alertType": "speeding",
      "alertLabel": "Over Speed",
      "severity": "HIGH",
      "timestamp": "2026-09-02T10:00:00.000Z",
      "speed": 110,
      "address": "Dubai, UAE"
    },
    {
      "eventId": "UID-102",
      "alertType": "harsh_acceleration",
      "alertLabel": "Harsh Acceleration",
      "severity": "MEDIUM",
      "timestamp": "2026-09-02T10:03:00.000Z",
      "speed": 85,
      "address": "Dubai, UAE"
    },
    {
      "eventId": "UID-103",
      "alertType": "harsh_braking",
      "alertLabel": "Harsh Braking",
      "severity": "HIGH",
      "timestamp": "2026-09-02T10:06:00.000Z",
      "speed": 40,
      "address": "Dubai, UAE"
    }
  ],
  "startTime": "2026-09-02T10:00:00.000Z",
  "latestTime": "2026-09-02T10:06:00.000Z",
  "durationMs": 360000,
  "windowMinutes": 15,
  "generatedAt": "2026-09-02T10:06:00.000Z"
}
```

---

## 4. Key Rules & Invariants

1. **Vehicle Isolation:** Correlations are strictly isolated per vehicle key (`IMEI:{imei}` prioritized over `PLATE:{normPlate}`). Events from Vehicle A never cross into Vehicle B.
2. **Temporal Window:** Configurable correlation window (default: 15 minutes). Events older than `currentTimestamp - 15m` relative to the latest event are excluded.
3. **Deduplication:** Uses `eventId` (`UID-{uid}` or `EVT-{timestamp}`) as primary key. Duplicate submissions yield `eventCount = 1`.
4. **Chronological Ordering:** Events are sorted chronologically ascending (`startTime` <= `latestTime`) regardless of arrival order.
5. **Stable Correlation ID:** Base ID formatted as `CORR-{vehicleKey}-{earliestEventId}`, maintaining group stability across multi-event streams.
6. **Non-blocking Error Isolation:** Exceptions during correlation evaluation return a safe fallback (`status: "NONE"`) so the core email and alert forwarding loop is never interrupted.

---

## 5. Explicit Phase 1 Boundaries

- ❌ No AI / LLM / machine learning.
- ❌ No incident classification (e.g., Aggressive Driving, Driver Distraction grouping belong to Phase 2).
- ❌ No combined severity calculation or risk scoring (Phase 3).
- ❌ No change to WhatsApp notification formatting or routing. Group messages remain clean and untouched.

---

## 6. Test Suite & Results

- **Dedicated Test Suite:** `tests/test_alertCorrelation.js` (14/14 PASSED ✅)
- **Regression Suite:** `tests/test_phase4_validation.js` (71/71 PASSED ✅)

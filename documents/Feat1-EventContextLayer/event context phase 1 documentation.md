# Event Context Layer — Phase 1: Context Foundation

**Implementation Date:** 02 September 2026  
**Module:** `services/eventContext.js`  
**Repository:** `vehicle-alert-bot`  
**Phase:** 1 of 4 (Context Foundation)  

---

## 1. Executive Overview

Phase 1 introduces a **standardized EventContext foundation** into the existing Vehicle Alert Bot pipeline. Before Phase 1, raw telematics data parsed from MIME emails flowed directly into business rules as loosely coupled dictionaries (`{ alertDef, fields }`). 

With Phase 1, every parsed alert is automatically normalized into a clean, strongly typed `EventContext` object containing standardized vehicle, telemetry, location, trip/ignition state, and metadata fields.

### Pipeline Transformation

```text
BEFORE PHASE 1:
Tracking Platform → Email → EmailMonitor → AlertParser → { alertDef, fields } → Business Rules → Formatter → WhatsApp

AFTER PHASE 1:
Tracking Platform → Email → EmailMonitor → AlertParser → { alertDef, fields, context } → Business Rules → Formatter → WhatsApp
```

---

## 2. EventContext Schema Specification

The `EventContext` object created by `EventContextBuilder` (`services/eventContext.js`) adheres to the following structure:

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
  }
}
```

### Field Conventions & Null Safety
*   **Missing Optional Fields:** Any parameter not present in the incoming email or parser result is explicitly assigned `null`. The builder never throws on missing fields.
*   **Correlation Identifier (`eventId`):** Uses `UID-<emailUid>` when IMAP message UID is available; falls back to `EVT-<timestamp>`.
*   **Source Normalization:** Preserves exact platform source (`system1` for TouchTrack, `track9999` for Track9999).
*   **Calculated Telemetry:**
    *   `excessSpeed`: Numeric $\text{speed} - \text{speedLimit}$ if both are available, otherwise `null`.
    *   `overIdleTime`: Numeric $\text{idleTime} - \text{idleLimit}$ if both are available, otherwise `null`.

---

## 3. Architecture & Integration Points

### A. Module Structure
*   **`services/eventContext.js`**: Contains the `EventContextBuilder` class. Accepts an optional `historyStore` instance.
*   **`services/alertParser.js`**: Instantiates `EventContextBuilder`. Provides `setHistoryStore(store)` method. On every successful parse (`System 1` or `Track9999`), it generates `context` and attaches it to the return object: `{ alertDef, fields, context }`.
*   **`services/emailMonitor.js`**: Preserves IMAP `msg.uid` on the parsed email object (`parsed.uid = msg.uid`).
*   **`index.js`**: Binds `history` store to `emailMonitor.alertParser.setHistoryStore(history)` during initialization.

### B. Single Source of Truth for Ignition / Trip State
The `EventContextBuilder._deriveTripContext(plate)` method queries the existing `HistoryStore` methods (`getLastIgnitionOn(plate)` and `getLastIgnitionOff(plate)`). No secondary or duplicate ignition state memory is created.

---

## 4. Phase 1 Scope Boundary (What is NOT Implemented)

To guarantee zero regression and maintain strict architectural boundaries, Phase 1 explicitly **does NOT include**:
1.  **No Time Windows:** 5-min, 15-min, 30-min, or 60-min event aggregation windows (deferred to Phase 2).
2.  **No Pattern / Sequence Analysis:** Alert sequences, repeated-event detection, or clustering (deferred to Phase 3).
3.  **No Risk Scoring / Anomaly AI:** Rule-based or AI risk scoring models (deferred to Phase 3 / Future AI Layer).
4.  **No Schema Migrations:** Existing persistent files (`history.json`, `trips.json`, `state.json`) remain unchanged. `EventContext` operates as an internal runtime object.
5.  **No WhatsApp Routing / Formatting Changes:** Notification routing, group message templates, and critical DM rules remain 100% identical.

---

## 5. Extensibility for Phase 2

Phase 1 provides a clean interface for Phase 2 (Recent Event Context):
*   Phase 2 will be able to consume `context.vehicle.plate` and `context.timestamp` to query recent event slices from `HistoryStore`.
*   Phase 2 can attach `context.recentActivity` (e.g., last 5/10/15 events) onto the standardized `EventContext` object without touching `AlertParser` or downstream formatters.

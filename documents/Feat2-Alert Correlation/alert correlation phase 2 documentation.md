# Feature #2 Phase 2 — Correlation Rules & Incident Grouping Technical Documentation

## 1. Overview & Objective

**Feature #2 Phase 2 (Correlation Rules & Incident Grouping)** expands the correlation foundation (Phase 1) by classifying correlated event groups into meaningful, deterministic driving episodes and operational incidents (e.g. `AGGRESSIVE_DRIVING`, `DRIVER_DISTRACTION_UNSAFE_DRIVING`, `ACCIDENT_EVENT`, `ENGINE_FAILURE`, `DEVICE_SECURITY_INCIDENT`).

---

## 2. Key Rule Semantics & Corrections

### A. Geofence Rule & False-Positive Prevention
- **`speeding` + `geofence_enter`**: `CORRELATED_ACTIVITY` (`isIncident: false`). Unrelated driving alerts combined with geofence events do NOT automatically form an incident pattern.
- **Pure Geofence Activity**: `geofence_exit` / `geofence_enter` forms `GEOFENCE_EXIT_EVENT` / `GEOFENCE_ENTRY_EVENT` (`isIncident: true`) only when the correlation group consists purely of geofence / location activity.

### B. SOS & Tampering Handling
- **SOS Emergency**: `sos` is inherently critical. Whether occurring standalone or correlated with driving alerts (e.g. `sos` + `speeding`), it classifies as `SOS_EMERGENCY` (`isIncident: true`, `ruleId: "SOS_CORRELATED_V1"`).
- **Device Tampering**: `tampering` correlated with driving alerts classifies as `DEVICE_TAMPERING` (`isIncident: true`, `ruleId: "TAMPERING_CORRELATED_V1"`). If paired with `offline`, `camera_blocked`, or `gps_lost`, it elevates to `DEVICE_SECURITY_INCIDENT`.

---

## 3. Incident Classification Taxonomy & Priority Rules

| Priority | Incident Type | Label | Trigger Rule & Matching Conditions |
| :--- | :--- | :--- | :--- |
| **1** | `ACCIDENT_EVENT` | Collision / Accident Event | Event types contain `accident` or (`sos` + `accident`). |
| **2** | `ENGINE_FAILURE` | Engine Failure / Overheat | Event types contain `engine_failure`. |
| **3** | `DEVICE_SECURITY_INCIDENT` | Device Security Incident | `tampering` + (`offline`, `camera_blocked`, or `gps_lost`). |
| **4** | `AGGRESSIVE_DRIVING` | Aggressive Driving | 2+ distinct events from `['speeding', 'harsh_acceleration', 'harsh_braking', 'ubi_acceleration', 'ubi_deceleration']`. |
| **5** | `DRIVER_DISTRACTION_UNSAFE_DRIVING` | Driver Distraction / Unsafe Driving | 2+ distinct events from `['distraction', 'vibration', 'lane_change', 'fatigue', 'drinking', 'seatbelt', 'smoking', 'voice_alarm']`. |
| **6** | `CONNECTIVITY_DISRUPTION` | Connectivity Disruption | (`gps_lost` + `lte_jamming`) OR (`lte_jamming` + `offline`). |
| **7** | `GPS_INTERRUPTION` | GPS Interruption | `gps_lost` + `gps_restored`. |
| **8** | `GEOFENCE_EXIT_EVENT` / `GEOFENCE_ENTRY_EVENT` | Geofence Exit / Entry | Pure geofence / ignition activity. |
| **9** | `CORRELATED_ACTIVITY` | Correlated Activity | `isCorrelated === true` (multiple alerts in 15m window) where no pattern rule 1–8 matched. (`isIncident: false`). |

---

## 4. Test Suite & Results

- **Incident Grouping Suite:** `tests/test_incidentGrouping.js` (**28 / 28 PASSED** ✅)
- **Correlation Foundation Suite:** `tests/test_alertCorrelation.js` (**15 / 15 PASSED** ✅)
- **Phase 4 Regression Suite:** `tests/test_phase4_validation.js` (**71 / 71 PASSED** ✅)
- **Total Test Cases:** **114 / 114 PASSED** ✅

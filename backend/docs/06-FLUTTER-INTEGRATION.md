# Flutter Integration

What the app has to build to use this backend, and how its existing pieces map
onto the API.

**No Flutter code has been written.** This is the specification the app work
follows.

---

## The prerequisite

**This backend cannot be integrated until the app has a local sample store.**

Today `BandController` holds one nullable field per metric
([`band_controller.dart:79-95`](../../flutter/lib/src/app/band_controller.dart#L79-L95)).
Every 5-minute sample the band delivers is used to overwrite a single "latest"
value and then discarded. There is no history to batch, and a force-stop erases
everything.

That work is already specified in the app repo as
[`docs/fixes/02-local-sample-persistence.md`](../../flutter/docs/fixes/02-local-sample-persistence.md),
and its schema — band id, metric, value, device timestamp, receipt timestamp,
source — is deliberately the same shape this API ingests.

**Build it once; it serves both purposes.** The offline dashboard and the upload
queue are the same table. Adding a separate sync queue later would mean storing
everything twice.

### Suggested schema

```sql
CREATE TABLE samples (
  device_id   TEXT    NOT NULL,
  stream      TEXT    NOT NULL,   -- registry id: 'hr', 'bp', 'spo2', …
  device_ts   INTEGER NOT NULL,   -- epoch ms, from the band's own clock
  value       REAL    NOT NULL,   -- channel 0, in API units
  value1      REAL,               -- channel 1 (bp diastolic)
  quality     INTEGER NOT NULL DEFAULT 1,
  source      INTEGER NOT NULL,   -- 1 live · 2 auto · 3 poll · 4 manual · 5 platform
  tz_offset   INTEGER NOT NULL,   -- minutes EAST of UTC, at capture
  received_at INTEGER NOT NULL,
  synced_at   INTEGER,            -- NULL = pending upload
  PRIMARY KEY (device_id, stream, device_ts)
);
CREATE INDEX samples_pending ON samples (synced_at, device_ts DESC)
  WHERE synced_at IS NULL;
```

The primary key gives idempotent local upserts, which matters because BLE
history reads overlap by design. The partial index makes "what still needs
uploading, newest first" a cheap query.

`drift` or `sqflite` both work; `drift` gives typed queries and runs on both
platforms.

---

## Metric mapping

The bridge already emits these on `onMetric`. The right-hand column is what to
send.

| Bridge payload | Registry stream | Conversion |
|---|---|---|
| `heartRate.bpm` | `hr` | none |
| `bloodPressure.systolic` / `.diastolic` | `bp` | `v` = systolic, `v1` = diastolic |
| `oxygen.percent` | `spo2` | none |
| `hrv.milliseconds` | `hrv` | none |
| `bodyTemp.celsius` | `temp` | none |
| `steps.steps` | `steps` **or** `counters` | see below |
| `steps.calories` | `calories` / `counters.kcal` | kcal |
| `steps.distanceKm` | `distance` / `counters.distanceM` | **× 1000 → metres** |
| `battery.percent` | `battery` + a `battery` event | only when `isPercent()` |
| `sleep.*` | `sleep[]` session | wake date, not sync date |
| `syncProgress` | — | local UI only, never uploaded |

### Steps need care

Two different things arrive under the same name:

- `OriginData.stepValue` is a **five-minute bucket**. Send as `series` with
  `stream: "steps"`, `source: "auto"`.
- `readSportStep().step` is the **running daily total**. Send as `counters`, not
  as a sample — it would otherwise be summed into the bucket total and roughly
  double the day.

The Kotlin bridge currently blends both in `publishCurrentSteps`. When wiring
the store, keep them apart: buckets to `samples`, totals to a `counters` row.
The backend merges counters by `max`, which preserves the same protection
against the transient-zero step register that `publishCurrentSteps` provides.

### Streams the app does not yet forward

`resp_rate`, `glucose`, `cardiac_load`, `hypoxia`, `apnea`, `sleep_state` and
`activity_state` all arrive inside `OriginData3` on every history sync and are
dropped in `publishOrigin3`. The backend already accepts them. Forwarding is a
Kotlin change in the bridge plus a Dart model change — no backend work.

---

## Client architecture

```
BandConnection (platform channel)
        │  onMetric
        ▼
SampleRepository            ← new; the one place samples are written
        ├─ upsert into SQLite
        ├─ hydrate BandController on startup       (offline dashboard)
        └─ notify SyncEngine                       (debounced)
                │
                ▼
        SyncEngine          ← new
        ├─ GET  /v1/sync/state
        ├─ page unsynced rows newest-first
        ├─ POST /v1/ingest (columnar)
        ├─ mark synced, persist watermarks
        └─ WorkManager / BGTaskScheduler for background runs
```

`BandController` keeps its current shape and reads from `SampleRepository`
instead of holding metrics itself. Screens are unaffected.

---

## Auth

```dart
final token = await FirebaseAuth.instance.currentUser?.getIdToken();
// Authorization: Bearer $token
```

Tokens last one hour and `getIdToken()` refreshes near expiry. During a long
backfill, re-read it between batches. On `token_expired`, call
`getIdToken(true)` and **retry the same batch** — do not discard it.

⚠️ **[`flutter/firebase.json`](../../flutter/firebase.json) declares two Firebase
projects**: `hypr-8064c` for Android and Dart, `pulse-hypr` for the iOS default
platform. ID tokens are project-scoped. Until these are consolidated, iOS builds
issuing `pulse-hypr` tokens will be rejected with an audience mismatch (ADR-020).

---

## Upload payload

Build columnar `series`, one entry per stream:

```dart
Future<Map<String, dynamic>> buildBatch(List<SampleRow> rows) async {
  final byStream = <String, List<SampleRow>>{};
  for (final row in rows) {
    byStream.putIfAbsent(row.stream, () => []).add(row);
  }

  return {
    'batchId': _batchId,                 // persisted with the rows
    'deviceId': deviceId,
    'tzOffsetMin': DateTime.now().timeZoneOffset.inMinutes,  // east of UTC
    'source': 'auto',
    'series': [
      for (final entry in byStream.entries)
        {
          'stream': entry.key,
          't': [for (final r in entry.value) r.deviceTs],
          'v': [for (final r in entry.value) r.value],
          if (entry.value.any((r) => r.value1 != null))
            'v1': [for (final r in entry.value) r.value1],
          'q': [for (final r in entry.value) r.quality],
        },
    ],
  };
}
```

`DateTime.timeZoneOffset.inMinutes` is already the sign convention the API wants
(minutes east of UTC). No conversion.

---

## Startup sequence

```dart
Future<void> onSignedIn() async {
  // 1. Hydrate from the local store first — instant, works offline.
  await sampleRepository.hydrateController(bandController);

  // 2. Restore server state. Failures here are non-fatal.
  try {
    final profile = await api.getProfile();
    appSettings.applyFrom(profile);
    await bandController.pushPersonInfoToBand(profile);   // syncPersonInfo

    if (sampleRepository.isEmpty) {
      final latest = await api.getLatestMetrics();        // fresh install
      bandController.hydrateFrom(latest);
    }
  } on ApiException catch (e) {
    debugPrint('Backend unavailable, continuing offline: ${e.code}');
  }

  // 3. Normal band flow.
  await bandController.autoConnect();
}
```

The order is deliberate: local first so the UI is never blocked on the network,
server second to fill gaps, band last.

---

## Closing an existing gap: `syncPersonInfo`

[`onboarding_screen.dart:25-27`](../../flutter/lib/src/screens/onboarding_screen.dart#L25-L27)
collects height, weight and age and discards them. They are never persisted and
never reach `syncPersonInfo`, so the band computes calories and distance from
defaults.

With this backend the fix is straightforward:

1. Onboarding writes to `PUT /v1/profile`.
2. After every successful password handshake, read the profile and call
   `syncPersonInfo(sex, heightCm, weightKg, age, stepGoal)`.
3. `age` is derived server-side from `birthDate`, so it stays correct without the
   user re-entering it each year.

This is listed as fix 06 in the app repo (P1, 95% confidence) and is the
cheapest accuracy improvement available.

---

## Background sync

**Android** — WorkManager, so the OS batches the wake-up:

```kotlin
PeriodicWorkRequestBuilder<SyncWorker>(2, TimeUnit.HOURS)
    .setConstraints(
        Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build())
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
    .build()
```

**iOS** — `BGProcessingTaskRequest` with `requiresNetworkConnectivity = true`;
add `requiresExternalPower = true` for large backfill. iOS grants these at its
own discretion, so the foreground debounce carries most of the load.

Both intervals come from `/v1/config` (ADR-014), so they can be retuned without
a release.

---

## Error handling

```dart
switch (error.code) {
  case 'token_expired':
    await FirebaseAuth.instance.currentUser?.getIdToken(true);
    return retrySameBatch();                    // same batchId

  case 'invalid_payload':
  case 'bad_request':
    await markRowsDead(rows);                   // never requeue
    await reportToCrashlytics(error);
    return;

  case 'payload_too_large':
    return retryAsTwoBatches(rows);             // new batchIds

  default:
    if (error.retryable) return scheduleBackoff();
    await markRowsDead(rows);
}
```

The rule that matters: **never retry a non-retryable batch.** A poison batch
looping forever is the worst battery outcome this system can produce, and it is
exactly what the offline dashboard work is meant to prevent.

---

## Testing without a band

```bash
TOKEN=$(...)   # a real Firebase ID token from a signed-in test build

curl -X POST https://pulse-hypr-api.workers.dev/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "batchId": "test-'$(date +%s)'",
    "deviceId": "AA:BB:CC:DD:EE:FF",
    "tzOffsetMin": 300,
    "series": [{ "stream": "hr", "t": [1754697600000, 1754697900000], "v": [64, 66] }]
  }'

curl "https://pulse-hypr-api.workers.dev/v1/metrics/latest" -H "Authorization: Bearer $TOKEN"
```

Sending the same `batchId` twice must return `duplicate: true` and change
nothing. That is the first integration test worth writing.

---

## Suggested order

| Step | Depends on | Delivers |
|---|---|---|
| 1. Local sample store (fix 02) | — | Offline dashboard. **Prerequisite for everything below** |
| 2. `SyncEngine` upload path | 1 | Data reaches the cloud; history survives reinstall |
| 3. Profile round-trip + `syncPersonInfo` (fix 06) | — | Correct calories and distance on the band |
| 4. Hydrate from `/metrics/latest` | 2 | Correct dashboard on a fresh install |
| 5. Manifest repair pass | 2 | Self-healing after failed uploads |
| 6. Forward the dropped `OriginData3` fields | 1 | Respiratory rate, sleep stages, glucose — backend already accepts them |

Steps 1 and 3 are already on the app's own P0/P1 fix list, so this backend does
not add work so much as give that work somewhere to land.

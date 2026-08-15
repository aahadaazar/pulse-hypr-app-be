# Phase 2 Brief — Cloud Sync

A self-contained handoff for whoever (human or agent) implements Phase 2.
You should not need this session's conversation history — everything you
need to start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-2--cloud-sync) first** for the phase's
goal and how it fits the roadmap. This document goes one level deeper: the
exact API contracts, the client architecture already specified for it, and
a per-task execution checklist.

**Verified against the repo at commit `61883b4`** (flutter) — if `git log -1`
shows something newer, re-check the "Verified current state" notes below
before trusting them. As of that commit: **zero sync-related code exists**
— no `workmanager`/`dio`/`http` dependency in `pubspec.yaml`, no file
matching `*sync*`, `*repository*`, or `*api*` under `lib/`, and
`BandController` has no networking references at all. This phase starts
from nothing.

---

## Before you touch anything

1. **Phase 1 must actually be complete — not just "mostly."** See
   [`PHASE-1-CORE-ANDROID-RELIABILITY.md`](PHASE-1-CORE-ANDROID-RELIABILITY.md)
   for that phase's own brief. Specifically:
   - **Task 1.1 (local sample store) is the literal prerequisite.** This
     phase's `SyncEngine` reads unsynced rows from the table 1.1 creates —
     there is nothing to sync without it.
   - **Task 1.3 (profile → band sync) must ship before you enable real
     uploads.** Onboarding currently discards height/weight/age, so the band
     computes calories/distance from a factory-default profile. Once this
     phase's ingest path is live, those wrong numbers become **permanent**
     monthly rollups computed server-side from data the band itself got
     wrong — no later fix can recompute them. If Task 1.3 hasn't shipped,
     **stop and flag it** rather than proceeding; do not enable background
     upload against production data until it has.
2. **No backend work is needed anywhere in this phase.** Every endpoint
   below is already deployed and live at
   `https://pulse-hypr-api.aahadaazar.workers.dev`. Do not modify anything
   under `backend/`.
3. **This does not touch `flutter/AGENTS.md`'s do-not-touch zone**, but Task
   2.3 does edit `BandConnectionManager.kt` (the same file that zone lives
   in) for polling cadence. That's fine — the protected invariants are
   specifically process isolation, SDK version, and GATT-before-password
   handshake ordering, not "don't touch this file." Read `AGENTS.md` anyway
   before editing it, so you recognize the boundary when you're near it.

---

## Order

```
2.1 Sync engine (upload path)  ─┐
2.3 Step polling cadence        ├─ same battery-policy code area; do together
2.2 Hydrate from /metrics/latest ── build after 2.1 (reuses its auth/HTTP client)
```

**2.1 and 2.3 are bundled deliberately, not just adjacent in numbering.**
The sync engine is where battery policy actually gets decided —
WorkManager constraints, the `/v1/config` battery floor — and a 5-second BLE
poll that keeps running with the screen off is the same power-budget
conversation. Do it while you're already in that code.

**2.2 technically has no hard dependency on 2.1** — `GET /v1/metrics/latest`
is just an API call — but it needs the same auth-header injection and error
handling 2.1 builds, so building it after avoids writing that plumbing
twice.

---

## Task 2.1 — Sync engine (upload path)

**Sources (all already written, full detail):**
[`backend/docs/06-FLUTTER-INTEGRATION.md`](../backend/docs/06-FLUTTER-INTEGRATION.md) (client architecture, payload shape, startup sequence, error handling — read this one in full) ·
[`backend/docs/04-SYNC-PROTOCOL.md`](../backend/docs/04-SYNC-PROTOCOL.md) (battery/memory/network budget, retry policy, watermarks vs. manifest — read this one in full too) ·
[`backend/docs/03-API.md`](../backend/docs/03-API.md) `GET /v1/sync/state`, `POST /v1/ingest`

### Client architecture (from the integration guide)

```
BandConnection (platform channel)
        │  onMetric
        ▼
SampleRepository            ← built in Phase 1 task 1.1
        ├─ upsert into SQLite
        ├─ hydrate BandController on startup       (offline dashboard)
        └─ notify SyncEngine                       (debounced)
                │
                ▼
        SyncEngine          ← new, this task
        ├─ GET  /v1/sync/state
        ├─ page unsynced rows newest-first
        ├─ POST /v1/ingest (columnar)
        ├─ mark synced, persist watermarks
        └─ WorkManager / BGTaskScheduler for background runs
```

### What to build

1. **Auth.** `FirebaseAuth.instance.currentUser?.getIdToken()` →
   `Authorization: Bearer $token`. Tokens last one hour; on `token_expired`,
   call `getIdToken(true)` and **retry the same batch** — do not discard it.
2. **Steady-state loop**, on debounce (~20s, from `config.sync.foregroundDebounceSeconds`)
   after a BLE sync completes:
   - `GET /v1/sync/state?deviceId=…` → per-stream watermarks (newest device
     timestamp the server already holds).
   - Select local rows newer than each stream's watermark. Every known
     stream is present in the response, `0` if never seen — no first-sync
     special case needed.
   - If nothing to send, do nothing (never wake the radio to poll empty).
   - Otherwise `POST /v1/ingest` with a columnar batch (see shape below),
     mark those rows `synced_at`, persist the returned watermarks.
3. **Columnar batch shape** — one entry per stream, not one object per
   point (~40% smaller):
   ```jsonc
   {
     "batchId": "<uuid-v4, persisted with the queued rows>",
     "deviceId": "AA:BB:CC:DD:EE:FF",
     "tzOffsetMin": 300,           // DateTime.now().timeZoneOffset.inMinutes — no conversion needed
     "source": "auto",
     "series": [
       { "stream": "hr", "t": [t0, t1, …], "v": [64, 66, …], "q": [1, 1, …] }
     ]
   }
   ```
4. **Batching limits:** ≤ `config.sync.maxSamplesPerRequest` (5,000) samples
   per request, ≤ 62 days per request. **Newest day first** — a reinstall
   with months of backlog should show a correct dashboard within one
   request, not after the whole backlog lands. The server does not enforce
   ordering; it's a client-side quality decision.
5. **`batchId` is a UUID v4, generated once and persisted with the queued
   rows** — not regenerated on retry. Replaying the same `batchId` is always
   safe: the server returns the stored result and writes nothing (see
   `ingest.ts`'s receipt-hit path, already exercised by this project's own
   Step 3.3 smoke test).
6. **Error handling** — branch on `error.code`, not HTTP status:

   | `error.code` | Action |
   |---|---|
   | `token_expired` | Refresh token, retry **same batchId** immediately |
   | `invalid_payload` / `bad_request` | **Do not requeue.** Mark rows dead, log/report. Never retry a non-retryable batch — a poison batch looping forever is the worst battery outcome this system can produce |
   | `payload_too_large` | Halve the batch, retry as **two new** batchIds |
   | `retryable: true` (409/429/5xx) | Backoff: 30s → 60s → 120s → … cap 3600s, same batchId |

7. **Background runs.** Android: WorkManager, `PeriodicWorkRequestBuilder`
   at `config.sync.backgroundIntervalMinutes` (120 default), constraints
   `NetworkType.CONNECTED` + `setRequiresBatteryNotLow(true)`, exponential
   backoff. iOS: `BGProcessingTaskRequest`,
   `requiresNetworkConnectivity = true`, add `requiresExternalPower = true`
   for large backfill. Both intervals come from `GET /v1/config` — cache it,
   treat it as advisory, keep working from the cached copy offline.
8. **Battery/memory discipline** (from the sync-protocol doc):
   - Skip background upload below `minBatteryPercent` (20%) unless
     charging.
   - Defer backfill larger than `unmeteredBackfillThreshold` (5,000
     samples) to unmetered + charging.
   - **Stream from the local DB in pages** — never load an entire unsynced
     backlog into memory. Peak memory should be one batch, not the queue.
   - One `HttpClient` for the app's lifetime (TLS handshake cost). Ensure
     `Accept-Encoding: gzip`. Bound request timeout to 30s.
9. **Steps need care** — two different things arrive under the same name;
   getting this wrong silently doubles a day's step count:
   - `OriginData.stepValue` is a **five-minute bucket** → send as `series`,
     `stream: "steps"`.
   - `readSportStep().step` is the **running daily total** → send as
     `counters` (a separate payload field, not a `steps` sample) — the
     backend merges counters by `max`, which is what protects against the
     step register's documented transient-zero read.

### Files

New: `lib/src/sync/sync_engine.dart`, `lib/src/sync/api_client.dart` (or
similar). Android WorkManager registration. iOS `BGProcessingTaskRequest`
registration. Reads from whatever `SampleRepository` Task 1.1 built.

### Definition of done

(Matches [`SETUP-AND-WIRING.md` Step 7.2](SETUP-AND-WIRING.md#72-full-pipeline-acceptance), which is the authoritative acceptance table for this — re-run it here, not a paraphrase.)

- Airplane mode → record → back online: queued rows upload, no data lost.
- Replaying a `batchId` against the **real deployed Worker** (not just
  curl from a terminal — from the app) returns `duplicate: true` and writes
  nothing.
- A day's step total matches the band's own display exactly — this is the
  test that catches the steps-bucket-vs-counter trap above. If daily totals
  come out roughly double, cumulative values are being sent as `steps`
  samples instead of `counters`.
- Pull-to-refresh twice with the band idle: local row count stable, ingest
  reports `inserted: 0`.

---

## Task 2.3 — Lifecycle-aware step polling cadence

**Source:** [`flutter/docs/fixes/13-lifecycle-aware-steps-polling.md`](../flutter/docs/fixes/13-lifecycle-aware-steps-polling.md) (fix 13, full detail)

### Verified current state

`BandConnectionManager.kt`'s `STEPS_POLL_INTERVAL_MS = 5000L` is a fixed
constant; `startStepsPolling` reposts forever regardless of app visibility.
Confirmed: no `WidgetsBindingObserver` exists anywhere in `lib/` — nothing
observes app lifecycle today, so the 5-second BLE read loop runs even with
the screen off or the app backgrounded.

### What to build

1. Add a `WidgetsBindingObserver` (on the controller or app shell). On
   `resumed` → fast cadence (5s, current default). On `inactive`/`paused` →
   slow cadence (suggest 60–300s) or pause entirely — the band records
   steps regardless, and history sync reconstructs today's total.
2. Extend the method channel to accept a cadence parameter
   (`setStepsPollingCadence(fast|slow)` or similar); native applies it to
   the existing polling runnable. Keep the existing pause-during-sync guard
   (`fetchSteps` already checks `syncInFlight` — don't disturb that).
3. On resume from background, trigger one immediate step read so the
   dashboard is fresh the moment it's visible again.
4. iOS mirror (`stepsTimer` in `VeepooBandChannel.swift`) belongs with
   Phase 3's iOS work, not this task — Android only here.

### Files

`lib/src/app/band_controller.dart` (or `lib/src/screens/app_shell.dart`) —
lifecycle observer · `lib/src/band/veepoo/veepoo_band_connection.dart` —
cadence parameter · `android/.../VeepooBandChannel.kt`,
`android/.../BandConnectionManager.kt` — interval plumbing.

### Definition of done

- App backgrounded 10 minutes: BLE traffic shows the slow cadence (verify
  via logcat or HCI snoop).
- Returning to the dashboard shows a step value no older than a few
  seconds.
- Sync's existing pause/resume of the poller is unchanged.

---

## Task 2.2 — Hydrate dashboard from `/metrics/latest`

**Sources:** [`backend/docs/06-FLUTTER-INTEGRATION.md`](../backend/docs/06-FLUTTER-INTEGRATION.md) "Startup sequence" section · [`backend/docs/03-API.md`](../backend/docs/03-API.md) `GET /v1/metrics/latest`

### The contract

```jsonc
// GET /v1/metrics/latest?lookbackDays=7
{
  "today": "2026-08-09", "lookbackDays": 7,
  "streams": {
    "hr": { "unit": "bpm", "values": { "bpm": 74 },
            "measuredAt": 1754697300000, "date": "2026-08-09", "n": 271 }
  }
}
```

`measuredAt` is the sample's **device** time, never a fetch time — this is
what lets the UI say "last measured 8 minutes ago" honestly instead of
implying the value is live. Never render this as a live reading.

### What to build

On sign-in, **only if the local store is empty** (fresh install or a
reinstall — Task 1.1's `SampleRepository.isEmpty`), call
`GET /v1/metrics/latest` and hydrate `BandController`'s tiles from it,
**before any Bluetooth traffic starts.** This is the exact ordering from
the integration guide's startup sequence:

```dart
Future<void> onSignedIn() async {
  // 1. Hydrate from the local store first — instant, works offline.
  await sampleRepository.hydrateController(bandController);

  // 2. Restore server state. Failures here are non-fatal.
  try {
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

Local-first, server-second, band-last is deliberate — the UI must never
block on the network, and the server call is a gap-filler, not a
dependency. A backend-unavailable error here must be swallowed, not
surfaced as a blocking failure.

**Adjacent but out of this task's scope** (mentioned here so you don't
accidentally half-implement them): the same startup moment also naturally
wants `GET /v1/profile` (restore goals/units, push to band via
`syncPersonInfo` — that's Task 1.3's job, already done by the time you get
here) and `GET /v1/devices` (restore known bands so reconnect works before
BLE traffic — not currently scoped to any Phase 2 task; flag it as a gap if
you notice reconnect-before-sync feels broken, but don't silently build it
under this task's name).

### Files

Wherever sign-in / app-startup orchestration lives (likely `main.dart` or
an app-init service) · the `api` client built in Task 2.1.

### Definition of done

- Sign out, reinstall (or clear local storage), sign in: dashboard tiles
  populate from `/v1/metrics/latest` **before any BLE connection attempt**,
  with honest `measuredAt`-based "last measured" timestamps, not fabricated
  live values.
- A local store that already has data is not overwritten by this path —
  it only fires when the store is empty.
- Backend unavailable at sign-in: app continues offline, no crash, no
  blocking spinner.

---

## Phase exit criteria (from `PHASES.md`, repeated here for convenience)

All of [Step 7.2](SETUP-AND-WIRING.md#72-full-pipeline-acceptance) in
`SETUP-AND-WIRING.md`, specifically:

- Airplane mode → record → back online: queued rows upload, no data lost.
- Replaying a `batchId` against the real deployed Worker (from the app, not
  curl) returns `duplicate: true` and writes nothing.
- Sign out, reinstall, sign in: dashboard populates from
  `/v1/metrics/latest` before any BLE traffic.
- A day's step total matches the band's own display exactly.
- Step polling cadence drops when the app is backgrounded.

When all of these are true, update `PHASES.md`'s Phase 2 status to `Done`.

## Testing without a band

You don't need physical hardware to exercise the ingest side of the sync
engine — the deployed Worker is real and live:

```bash
TOKEN=$(...)   # a real Firebase ID token from a signed-in test build

curl -X POST https://pulse-hypr-api.aahadaazar.workers.dev/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "batchId": "test-'$(date +%s)'",
    "deviceId": "AA:BB:CC:DD:EE:FF",
    "tzOffsetMin": 300,
    "series": [{ "stream": "hr", "t": [1754697600000, 1754697900000], "v": [64, 66] }]
  }'

curl "https://pulse-hypr-api.aahadaazar.workers.dev/v1/metrics/latest" -H "Authorization: Bearer $TOKEN"
```

Sending the same `batchId` twice must return `duplicate: true` and change
nothing — this is the first integration test worth writing, before
anything band-dependent.

## What NOT to do in this phase

- Don't start before Phase 1 (specifically 1.1 and 1.3) has actually
  shipped — see "Before you touch anything" above.
- Don't build a separate sync-queue table. `SampleRepository`'s table
  (Task 1.1) **is** the upload queue — a `synced_at` column, not a second
  copy of the data. Storing it twice was explicitly rejected in the
  integration guide.
- Don't retry a non-retryable batch (`invalid_payload`, `bad_request`)
  forever. Mark it dead once and move on.
- Don't send `readSportStep()`'s running total as a `steps` sample — it
  silently doubles the day's count. It goes in `counters`.
- Don't upload on every BLE callback — debounce to one request per sync.
- Don't do backend work. Nothing here requires it.

# Sync Protocol

How the phone and the backend agree on what to move, and how mobile resource
cost is kept low.

The controlling fact: **radio time is the dominant battery cost in this system**,
on both links. The BLE side already gets this wrong — history reads are built
with the band's full `watchDataDay` window and there are no cursors, so every
sync re-downloads everything the band retains. The phone-to-cloud link is
designed not to repeat that.

---

## The three-link picture

```
   Band ──BLE──► Phone ──HTTPS──► Backend
        (~5 min)      (batched)
```

| | Band → Phone | Phone → Backend |
|---|---|---|
| Trigger | connect, pull-to-refresh | debounce after BLE sync, or background timer |
| Cost | BLE radio + band battery | cellular/Wi-Fi radio + phone battery |
| Cursors today | **none** — full window every time | watermarks + manifest |
| Idempotency | n/a | `batchId` receipt + slot merge |

The band's window is small (3 days on the KR96 PRO), so a phone offline for a
week loses data permanently unless it has already stored it locally. **The local
store is not an optimisation — it is the only thing between the band's 3-day
memory and the backend.**

---

## Steady-state loop

```
BLE history sync completes
        │
        ├─ write samples to the local store           (already needed for the offline dashboard)
        │
        ▼
debounce ~20 s   (config.sync.foregroundDebounceSeconds)
        │
        ├─ GET /v1/sync/state?deviceId=…              → watermarks + limits
        ├─ select local samples newer than watermark
        ├─ any? ──no──► done, no request
        │      └─yes─► POST /v1/ingest (columnar, ≤ maxSamplesPerRequest)
        │
        └─ on success: mark those rows synced, store returned watermarks
```

The debounce matters. A BLE sync emits six stages of callbacks over several
seconds; uploading on each would mean six radio wake-ups for data that could
have gone in one request. One request per sync is the target.

---

## Choosing what to upload

Two mechanisms, used at different times.

### 1. Watermarks — the fast path

`GET /v1/sync/state` returns the newest device timestamp the server holds per
stream. Upload only local samples newer than that. Every known stream is present
(`0` when never seen), so a first sync needs no special case.

This handles the ~99% case in one round-trip.

### 2. Manifest — the repair path

Watermarks cannot detect a *hole*: a day in the middle that failed to commit, or
data that arrived from the band out of order after the watermark moved past it.

`GET /v1/sync/manifest?from=&to=` returns per-day, per-stream `n` and `lastTs`.
Compare against local counts:

```dart
for (final day in manifest.days) {
  for (final stream in localStreamsFor(day.date)) {
    final localCount  = countLocal(day.date, stream);
    final serverCount = day.streams[stream]?.n ?? 0;
    if (localCount > serverCount) enqueueDay(day.date, stream);
  }
}
```

Run it on a slow cadence — daily, on app upgrade, and after any failed upload.
Two months of coverage costs 62 document reads.

---

## Batching

| Rule | Value | Why |
|---|---|---|
| Preferred payload | `series` (columnar) | ~40% smaller than row form; one entry per stream per batch |
| Samples per request | ≤ `config.sync.maxSamplesPerRequest` (5,000) | Bounded server work and phone memory |
| Days per request | ≤ 62 | Each day is a separate read-merge-commit cycle |
| Order | **newest day first** | The dashboard is correct before the archive finishes |
| `batchId` | UUID v4, persisted with the queued rows | Survives process death; makes retry free |

### Why newest-first

A user reinstalling after months away has a large backlog. Uploading oldest-first
means their dashboard is wrong until the whole backlog lands. Newest-first makes
today correct within one request and backfills history in the background.

The server does not enforce this — it is a client-side quality decision.

### Columnar payloads

```jsonc
// Preferred: one entry per stream
{ "stream": "hr", "t": [t0, t1, t2], "v": [64, 66, 71] }

// Avoid: repeats the stream name and object scaffolding per point
{ "stream": "hr", "t": t0, "v": 64 }
```

---

## Retry

```
attempt 1 ──fail──► wait 30 s  ──► attempt 2 ──► 60 s ──► 120 s … cap 3600 s
```

Branch on `error.retryable`, not on the HTTP status:

| Response | Action |
|---|---|
| `2xx` | Mark rows synced. Store `watermarks` from the response |
| `retryable: true` (409/429/5xx) | Backoff and retry **the same `batchId`** |
| `token_expired` | Refresh the ID token, retry the same batch immediately |
| `invalid_payload` / `bad_request` | **Do not requeue.** Log, mark the rows dead, alert |
| `payload_too_large` | Halve the batch and retry as two new batches |

Retrying with the same `batchId` is always safe: a replay returns the stored
result and touches nothing. This is what makes aggressive batching safe.

A permanently failing batch must be dropped after a bounded number of attempts.
A poison batch retried forever is the single worst battery outcome available to
this system.

---

## Mobile resource management

### Battery

| Rule | Source |
|---|---|
| Skip background upload below `minBatteryPercent` (20%) unless charging | `/v1/config` |
| Defer backfill larger than `unmeteredBackfillThreshold` (5,000 samples) to unmetered + charging | `/v1/config` |
| Never wake the radio purely to poll — upload only when there is something to send | protocol |
| One request per BLE sync, not one per callback | debounce |

On Android, express these as WorkManager constraints so the OS batches the
wake-up with other work rather than the app holding a wake lock:

```kotlin
Constraints.Builder()
    .setRequiredNetworkType(NetworkType.CONNECTED)   // UNMETERED for large backfill
    .setRequiresBatteryNotLow(true)
    .build()
```

On iOS, `BGProcessingTaskRequest` with
`requiresNetworkConnectivity = true` and, for backfill,
`requiresExternalPower = true`.

### Memory

The band's history window (3 days on the KR96 PRO) is small, but a reinstall or a
long offline period can queue tens of thousands of rows.

- **Stream from the local DB in pages.** Never `SELECT *` an unsynced backlog
  into a list — build one batch, send it, release it. Peak memory should be one
  batch, not the queue.
- **Cap at 5,000 samples per request** (≈ 300 KB of JSON). At `maxSamplesPerBatch`
  (20,000) a payload approaches 1 MB, which is a lot to hold and encode on a
  low-end phone.
- **Do not decode responses you do not need.** Ingest responses are small; series
  responses are not — request only the range being displayed.

### Network

- **gzip.** Cloudflare negotiates it; ensure the HTTP client sends
  `Accept-Encoding: gzip` and does not disable request compression.
- **Reuse the connection.** One `HttpClient` for the app's lifetime. TLS
  handshakes cost more than the payloads here.
- **Bound the timeout** (30 s). A stalled request holding the radio open is worse
  than a failed one that retries later.

---

## First run and reinstall

The same endpoints solve the reverse direction — a fresh install with an empty
local store.

```
sign in
   │
   ├─ GET /v1/profile          → restore goals, units, body profile
   │      └─ push profile to the band via syncPersonInfo
   ├─ GET /v1/metrics/latest   → dashboard tiles populate immediately,
   │                             with honest measuredAt timestamps
   ├─ GET /v1/devices          → known bands, so reconnect works before any BLE traffic
   └─ GET /v1/sync/state       → watermarks, so the first upload sends only genuinely new data
```

The user sees a correct dashboard before Bluetooth is even connected. Without a
backend this is impossible: the band holds three days and the app holds nothing.

---

## Multiple devices

A user may have two phones, or an Android and an iOS build of the same band
(different `deviceId` — MAC vs CoreBluetooth UUID).

- Watermarks are **per device**, so each phone tracks its own progress.
- Ingest is idempotent, so overlapping uploads converge rather than duplicate.
- Source precedence decides genuine disagreements
  (`manual > live > auto > poll > platform_health > derived`).
- Concurrent writes to the same day are the main source of `409 conflict`. The
  server retries internally three times; the client should treat a surfaced
  conflict as an ordinary retryable error.

---

## Diagnosing a misbehaving client

| Symptom | Meaning |
|---|---|
| `skipped` high, `inserted` 0 | Re-uploading data the server has — watermarks are being ignored |
| `merged` high | Genuine value changes, or two devices disagreeing on the same slots |
| `rejected` with `implausible_timestamp` | Band clock unset — timestamps land outside 2015 → now+48 h |
| `409 conflict` frequently | Two clients syncing one account concurrently |
| `duplicate: true` often | Client retrying successful batches — it is not recording success |

`inserted + merged + skipped` should equal `accepted` on every response. A
healthy steady-state sync has small `inserted`, near-zero `skipped`.

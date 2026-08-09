# API Reference

Base URL: `https://pulse-hypr-api.<subdomain>.workers.dev`
All endpoints are under `/v1` and require authentication.

---

## Authentication

```
Authorization: Bearer <firebase-id-token>
```

The token is the Firebase ID token the app already holds after Google sign-in:

```dart
final token = await FirebaseAuth.instance.currentUser?.getIdToken();
```

It is verified in-process against Google's published signing keys (`aud`, `iss`,
`exp`, `iat`, `sub`, 60 s clock skew). **`uid` is taken only from the verified
token** — no endpoint accepts a user id in a path, query or body.

Firebase ID tokens last one hour. `getIdToken()` refreshes automatically when
near expiry; long backfills should re-read it between batches.

---

## Errors

Every failure returns the same envelope:

```jsonc
{
  "error": {
    "code": "token_expired",
    "message": "The Firebase ID token has expired.",
    "retryable": false,
    "requestId": "0b3f…",
    "details": { }        // optional
  }
}
```

| Code | HTTP | Retryable | Client action |
|---|---|---|---|
| `bad_request` | 400 | no | Fix the request |
| `invalid_payload` | 422 | no | Fix the payload; **do not requeue** |
| `unauthenticated` | 401 | no | Re-authenticate |
| `token_expired` | 401 | no | Refresh the token, **retry the same batch** |
| `forbidden` | 403 | no | — |
| `not_found` | 404 | no | — |
| `conflict` | 409 | **yes** | Retry with backoff |
| `payload_too_large` | 413 | no | Split the batch |
| `rate_limited` | 429 | **yes** | Back off |
| `upstream_error` | 502 | **yes** | Retry with backoff |
| `internal_error` | 500 | **yes** | Retry with backoff |

`retryable` is the field to branch on. `token_expired` is deliberately separate
from `unauthenticated` so a client whose token expired mid-backlog refreshes and
retries rather than discarding queued data.

`requestId` is echoed in the `x-request-id` response header and appears in
Workers logs. Send your own `x-request-id` to correlate across systems.

---

## `POST /v1/ingest`

The single write path for band data. Idempotent on `batchId`.

### Request

```jsonc
{
  "batchId": "9f1c…",          // required, client-generated, unique per batch
  "deviceId": "AA:BB:CC:DD:EE:FF",
  "tzOffsetMin": 300,          // required, minutes EAST of UTC
  "source": "auto",            // default for everything in this batch

  // Columnar — the shape the app should send. One entry per stream.
  "series": [
    {
      "stream": "hr",
      "source": "auto",                                  // optional override
      "t": [1754697600000, 1754697900000, 1754698200000],
      "v": [64, 66, 71],
      "q": [1, 1, 1]                                     // optional quality bits
    },
    {
      "stream": "bp",
      "t": [1754697600000],
      "v":  [120],                                       // channel 0 — systolic
      "v1": [80]                                         // channel 1 — diastolic
    }
  ],

  // Row form — convenience for one-off writes.
  "samples": [
    { "stream": "spo2", "t": 1754697600000, "v": 97, "source": "manual" }
  ],

  // Device cumulative daily totals from readSportStep. Merged by max.
  "counters": [
    { "date": "2026-08-09", "steps": 8432, "kcal": 412.5,
      "distanceM": 6120, "at": 1754697300000 }
  ],

  "sleep": [
    {
      "date": "2026-08-09",              // WAKE date
      "startTs": 1754607600000, "endTs": 1754633460000,
      "totalMinutes": 431, "deepMinutes": 96, "lightMinutes": 335,
      "remMinutes": 0, "awakeMinutes": 12, "wakeCount": 3, "quality": 78,
      "segments": [
        { "offsetMin": 0,  "durationMin": 22, "state": 1 },
        { "offsetMin": 22, "durationMin": 41, "state": 2 }
      ]
    }
  ],

  // Whole-day values that arrive complete, e.g. onDayHrvScore.
  "scores": [ { "date": "2026-08-09", "key": "hrvDaily", "value": 68 } ],

  // Discrete records. `id` defaults to `{type}-{t}`, so replays cannot duplicate.
  "events": [
    { "type": "battery", "t": 1754697600000,
      "data": { "percent": 72, "charging": false } }
  ]
}
```

**`tzOffsetMin`** is minutes east of UTC — Dart's
`DateTime.now().timeZoneOffset.inMinutes`. Note this is the *opposite* sign to
JavaScript's `getTimezoneOffset()`. Must be a multiple of 15 between −720 and
840.

**Values are in API units** (see [02-DATA-MODEL.md](02-DATA-MODEL.md) §3):
temperature in °C, distance in **metres** (the SDK reports km — convert),
calories in kcal.

At least one of `series`, `samples`, `counters`, `sleep`, `scores`, `events`
must be non-empty.

### Limits

| Limit | Value | Configurable |
|---|---|---|
| Samples per batch | 20,000 | `MAX_SAMPLES_PER_BATCH` |
| Local days per batch | 62 | no |
| Series entries per batch | 200 | no |
| Events per batch | 500 | no |
| Sleep segments per night | 2,000 | no |

`GET /v1/sync/state` reports the live values; read them rather than hardcoding.

### Response — `201 Created` (or `200 OK` on replay)

```jsonc
{
  "batchId": "9f1c…",
  "duplicate": false,     // true = replay; nothing was written
  "accepted": 1440,       // points that passed validation
  "inserted": 1200,       // slots written for the first time
  "merged":    240,       // occupied slots whose value changed
  "skipped":     0,       // identical re-uploads — no write issued
  "rejected": [ { "stream": "hr", "index": 42, "reason": "implausible_timestamp" } ],
  "days": ["2026-08-08", "2026-08-09"],
  "watermarks": { "hr": 1754698200000, "spo2": 1754697600000 }
}
```

`skipped` high and `inserted` zero means the client is re-uploading data the
server already has — the sync protocol is not being followed. See
[04-SYNC-PROTOCOL.md](04-SYNC-PROTOCOL.md).

`rejected` reasons: `unknown_stream`, `implausible_timestamp` (outside 2015 →
now + 48 h), `no_value`.

Out-of-range values are **not** rejected. They are clamped to the metric's bound
and flagged with the `clamped` quality bit (ADR-010).

---

## `GET /v1/ingest/schema`

The registry, served live: every stream with its unit, channels, plausible
ranges, aggregation, categorical codes, and the SDK field it originates from.
Also the source and quality-bit vocabularies.

Use it to assert at app startup that the client and server agree, rather than
discovering a mismatch as silently rejected samples.

---

## `GET /v1/sync/state`

What the server already has, and what this deployment allows.

**Query:** `deviceId` (optional — watermarks are per device)

```jsonc
{
  "deviceId": "AA:BB:CC:DD:EE:FF",
  "serverTime": 1754698000000,
  "lastIngestAt": 1754697900000,
  "watermarks": { "hr": 1754697900000, "spo2": 1754697600000, "hrv": 0, … },
  "limits":    { "maxSamplesPerBatch": 20000, "maxDaysPerBatch": 62,
                 "maxManifestDays": 62 },
  "retention": { "rawDays": 90, "hourlyDays": 730, "dailyDays": null }
}
```

Every known stream appears, with `0` for streams never seen, so "upload
everything newer than the watermark" needs no first-sync special case.

---

## `GET /v1/sync/manifest`

Per-day coverage the server holds, so the client can upload only gaps.

**Query:** `from`, `to` (`YYYY-MM-DD`, default: last 14 days, max 62)

```jsonc
{
  "from": "2026-07-27", "to": "2026-08-09",
  "days": [
    {
      "date": "2026-08-09",
      "exists": true,
      "updatedAt": 1754697600000,
      "hasSleep": true,
      "streams": {
        "hr":    { "n": 271, "lastTs": 1754697300000 },
        "steps": { "n": 288, "lastTs": 1754697300000 }
      }
    },
    { "date": "2026-08-08", "exists": false, "streams": {} }
  ]
}
```

Costs one document read per day regardless of sample count.

---

## `GET /v1/metrics/series`

The chart endpoint.

**Query**

| Param | Required | Notes |
|---|---|---|
| `stream` | yes | One id or comma-separated, max 8 |
| `resolution` | no | `raw` (default) · `hour` · `day` |
| `from`, `to` | no | `YYYY-MM-DD`. Defaults: 7 d raw, 30 d hourly, 365 d daily |

**Range caps:** raw ≤ 31 days · hour ≤ 92 days · day ≤ 36 months. Exceeding one
returns `400` naming the resolution to use instead.

### `resolution=raw`

```jsonc
{
  "from": "2026-08-08", "to": "2026-08-09", "resolution": "raw",
  "series": [{
    "stream": "hr", "unit": "bpm", "channels": ["bpm"],
    "days": [{
      "date": "2026-08-09",
      "tzOffsetMin": 300,
      "startTs": 1754611200000,   // UTC instant of local midnight
      "slotSec": 300, "slots": 288,
      "values":  { "bpm": [null, null, 62, 64, …] },   // 288 entries
      "sources": [null, null, "auto", "auto", …],
      "quality": [null, null, ["worn"], ["worn"], …]
    }]
  }]
}
```

Slot *i* covers `startTs + i × 300000`. Days with no data are omitted from
`days` — absent is not the same as all-null.

### `resolution=hour`

```jsonc
{
  "series": [{
    "stream": "hr", "unit": "bpm", "aggregation": "avg",
    "days": [{
      "date": "2026-08-09", "tzOffsetMin": 300, "startTs": …,
      "slotSec": 3600, "slots": 24,
      "channels": { "bpm": [ { "n": 12, "min": 58, "max": 74, "value": 66 }, … ] }
    }]
  }]
}
```

### `resolution=day`

```jsonc
{
  "series": [{
    "stream": "steps", "unit": "steps", "aggregation": "sum",
    "points": [
      { "date": "2026-08-08", "channels": { "steps": { "n": 288, "min": 0, "max": 812, "value": 9120 } } },
      { "date": "2026-08-09", "channels": { "steps": { "n": 271, "min": 0, "max": 640, "value": 8432 } } }
    ]
  }]
}
```

`value` carries the stream's own aggregation: `sum` for steps/calories/distance,
`avg` for vitals, `max` for apnea, `last` for battery, `mode` for state streams.

---

## `GET /v1/metrics/day/:date`

One local day, fully summarised, in one document read.

```jsonc
{
  "date": "2026-08-09", "exists": true, "tzOffsetMin": 300,
  "deviceIds": ["AA:BB:CC:DD:EE:FF"],
  "streams": {
    "hr": {
      "n": 271, "firstTs": …, "lastTs": …, "unit": "bpm", "agg": "avg",
      "ch": [{ "key": "bpm", "n": 271, "min": 52, "max": 141,
               "sum": 18428, "avg": 68, "first": 61, "last": 74, "value": 68 }]
    }
  },
  "counters": { "steps": 8432, "kcal": 412.5, "distanceM": 6120, "at": … },
  "sleep":    { "totalMinutes": 431, "deepMinutes": 96, … },
  "scores":   { "hrvDaily": 68 },
  "updatedAt": 1754697600000
}
```

A day with no data returns `200` with `exists: false`, not `404` — "no data
yet" is a normal state, not an error.

The packed hourly frame is excluded; request it via
`/series?resolution=hour` when the view actually needs it.

---

## `GET /v1/metrics/latest`

Newest stored value per stream, with the timestamp it was **measured** at.

What a freshly installed app hydrates from before its first Bluetooth sync, and
what the dashboard's "now" tiles read.

**Query:** `lookbackDays` (default 7, max 30) · `today` (`YYYY-MM-DD`)

```jsonc
{
  "today": "2026-08-09", "lookbackDays": 7,
  "streams": {
    "hr":    { "unit": "bpm", "values": { "bpm": 74 },
               "measuredAt": 1754697300000, "date": "2026-08-09", "n": 271 },
    "bp":    { "unit": "mmHg", "values": { "systolic": 118, "diastolic": 76 },
               "measuredAt": 1754696000000, "date": "2026-08-09", "n": 14 }
  }
}
```

`measuredAt` is the sample's device time, never a fetch time. `findings.md` is
explicit that an old value must not render as a live one — this is the field
that lets the UI say "last measured 8 minutes ago".

---

## `GET /v1/sleep` · `GET /v1/sleep/:date`

**Query:** `from`, `to` (default last 30 days, max 92) · `segments=false` to omit
stage detail.

```jsonc
{
  "from": "2026-07-11", "to": "2026-08-09",
  "nights": [{
    "date": "2026-08-09",
    "startTs": 1754607600000, "endTs": 1754633460000,
    "totalMinutes": 431, "deepMinutes": 96, "lightMinutes": 335,
    "remMinutes": 0, "awakeMinutes": 12, "wakeCount": 3, "quality": 78,
    "source": 2,
    "segments": [ { "offsetMin": 0, "durationMin": 22, "state": "light" } ]
  }]
}
```

Keyed by **wake** date. `remMinutes` is 0 on Veepoo bands — the protocol does not
separate REM from light sleep. Apple Health does, and lands in the same shape.

`/v1/sleep/:date` returns one night, or `404` if none was recorded.

---

## `GET /v1/profile` · `PUT /v1/profile`

```jsonc
// GET
{
  "uid": "…", "email": "…", "exists": true,
  "profile": { "displayName": "…", "sex": "male", "heightCm": 178,
               "weightKg": 70, "birthDate": "1996-04-11",
               "age": 30,                     // derived, read-only
               "restingHrBaseline": 54 },
  "goals":   { "steps": 8000, "activeKcal": 500, "sleepMinutes": 480, "distanceM": 5000 },
  "units":   { "distance": "km", "temperature": "c" },
  "preferences": { "theme": "dark", "accent": "peach", "onboardingComplete": true },
  "updatedAt": 1754697600000
}
```

`PUT` is field-masked: send only the top-level groups you are changing
(`profile`, `goals`, `units`, `preferences`). Groups you omit are untouched, so
a client that predates a field cannot blank it.

`profile` is what `syncPersonInfo` needs. Height, weight, age and sex feed the
band's own calorie and distance maths; the vendor guide warns that demo values
produce wrong results. Push it to the band after every successful handshake.

---

## `GET /v1/config`

Server-driven client configuration (ADR-014). Cache it; treat it as advisory and
keep working from the cached copy when offline.

```jsonc
{
  "version": 1,
  "sync": {
    "foregroundDebounceSeconds": 20,
    "backgroundIntervalMinutes": 120,
    "minBatteryPercent": 20,
    "unmeteredBackfillThreshold": 5000,
    "maxSamplesPerRequest": 5000,
    "retryBaseSeconds": 30,
    "retryMaxSeconds": 3600
  },
  "features": { "workoutSessions": false, "ecg": false,
                "foodLogging": false, "derivedScores": false }
}
```

Changing sync cadence here retunes every client without an app-store release.

---

## Devices

### `GET /v1/devices`

```jsonc
{ "devices": [ { "id": "AA:BB:CC:DD:EE:FF", "name": "KR96 PRO",
                 "watchDataDay": 3, "batteryPercent": 72,
                 "watermarks": { "hr": 1754697900000 }, … } ] }
```

### `PUT /v1/devices/:deviceId`

Call after the password handshake, when `confirmDevicePwd` has returned the
device number, firmware and capability packages.

```jsonc
{
  "name": "KR96 PRO", "nickname": "My band",
  "model": "…", "firmware": "…", "platform": "android",
  "protocolVersion": 5,       // originProtocolVersion — 3/5 select IOriginData3Listener
  "watchDataDay": 3,          // days of history the band retains
  "batteryPercent": 72, "charging": false, "active": true,
  "capabilities": { "isSupportSpo2h": true, "isSupportHRV": true, … }
}
```

`capabilities` is stored verbatim — the surface is the band's, not ours.

### `DELETE /v1/devices/:deviceId`

Unpairs the band. **Measurements are kept** (ADR-015): they are the user's health
history, not the device's. Response includes `"dataRetained": true`.

---

## Unauthenticated

| Endpoint | Purpose |
|---|---|
| `GET /` | Service identity and version |
| `GET /health` | Liveness. Touches no storage, so uptime checks cost nothing |

---

## CORS

The Flutter app never sends an `Origin`; CORS exists for the web dashboard.
Origins are **allow-listed, not mirrored** — these responses carry personal
health data, and `Access-Control-Allow-Origin: *` with a bearer token is how that
leaks. Edit the list in [`src/index.ts`](../src/index.ts) when the dashboard gets
a domain.

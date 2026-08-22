# Data Model

Firestore layout, the packed frame format, and the metric registry.

Health records are scoped under `users/{uid}`, where `uid` is the Firebase Auth
subject from a verified ID token. The separate `trainerInvites` collection holds
only role and invitation metadata; it never contains health data.

---

## 1. Collections

```
users/{uid}                                  profile, goals, units, retention watermarks
├── devices/{deviceId}                        band identity, capabilities, sync watermarks
├── days/{YYYY-MM-DD}                         daily rollup + packed hourly frames
│   └── streams/{streamId}                    packed 288-slot raw frame   ← 90-day tier
├── months/{YYYY-MM}                          packed 31-slot daily frames ← permanent tier
├── nights/{YYYY-MM-DD}                       sleep session, keyed by wake date
├── events/{eventId}                          discrete, non-slotted records
└── receipts/{batchId}                        ingest idempotency, Firestore TTL 7 days

trainerInvites/{normalized-gmail}             pending/active trainer role and bound Firebase UID
```

`days/{date}` is keyed by the **user's local calendar date**, not a UTC date
(ADR-005). The offset that produced it is stored alongside, so absolute instants
stay reconstructible.

The `streams` subcollection is what retention deletes at 90 days. The hourly
frames live on the *parent* day document precisely so they survive that delete.

---

## 2. Packed frames

The single container behind every resolution tier: a fixed-slot, multi-channel
integer matrix stored as one opaque Firestore `bytesValue`.

| Slots | Meaning | Where |
|---|---|---|
| 288 | one day of 5-minute samples | `days/{date}/streams/{id}.f` |
| 24 | one day of hourly aggregates | `days/{date}.streams_{id}.h` |
| 31 | one month of daily aggregates | `months/{YYYY-MM}.streams_{id}.f` |
| *n* | sleep stage segments | `nights/{date}.segments` |

### Binary layout (little-endian)

```
offset  size  field
0       1     0x50 'P'
1       1     0x48 'H'
2       1     version (currently 1)
3       1     dtype   (1 = int16, 2 = int32)
4       2     slotCount (uint16)
6       1     channelCount
7       1     reserved (0)
8       ..    channelCount contiguous arrays of slotCount elements
```

A slot is **null** when it holds the dtype's minimum value (`-32768` / 
`-2147483648`). Metric ranges keep real readings far from that sentinel, so
"absent" and "zero" are genuinely distinct — a real 0-step five-minute bucket is
stored as 0 and reads back as 0.

### Why bytes and not arrays

Firestore indexes array elements individually. A dozen 288-element arrays per
day would burn thousands of index entries per user per day against a
20,000-per-document ceiling, for indexes no query ever uses. One `bytes` field
costs one entry, is ~4× smaller than the equivalent JSON, and is written
atomically (ADR-012).

This is only viable because no client reads Firestore directly (ADR-001) — the
Worker decodes frames into plain JSON on the way out.

### Raw frame channel layout

For a stream with *V* value channels, the raw frame has *V + 2*:

```
channel 0 .. V-1   values, scaled integers
channel V          quality bitmask
channel V+1        source code
```

Blood pressure, for example, is `[systolic, diastolic, quality, source]` — 4
channels × 288 slots × 2 bytes + 8 = **2,312 bytes** for a full day.

### Aggregate frame channel layout

Hourly and monthly frames carry four sub-channels per value channel, always
`int32` (an hour of scaled calories overflows `int16`):

```
channel 4v + 0   n      sample count
channel 4v + 1   min
channel 4v + 2   max
channel 4v + 3   value  the stream's own aggregation (avg / sum / max / last / mode)
```

---

## 3. Metric registry

Defined in [`src/domain/registry.ts`](../src/domain/registry.ts) and served live
at `GET /v1/ingest/schema`. Every field the Veepoo bridge already receives is
here, including those the app currently drops (ADR-004).

`stored = round(apiValue × scale)`.

| Stream | Unit | Scale | dtype | Agg | Channels | Comes from |
|---|---|---|---|---|---|---|
| `hr` | bpm | 1 | i16 | avg | bpm | `OriginData.rateValue`, or last plausible `OriginData3.ppgs` |
| `bp` | mmHg | 1 | i16 | avg | systolic, diastolic | `OriginData.highValue` / `.lowValue` |
| `spo2` | % | 1 | i16 | avg | percent | `Spo2hOriginData.oxygenValue`, `OriginData3.oxygens` |
| `hrv` | ms | 1 | i16 | avg | ms | `HRVOriginData.hrvValue` |
| `temp` | °C | 100 | i16 | avg | celsius | `OriginData.temperature` |
| `resp_rate` | brpm | 1 | i16 | avg | brpm | `OriginData3.resRates` ★ |
| `glucose` | mmol/L | 100 | i16 | avg | mmolPerL | `OriginData3.bloodGlucose` ★ |
| `cardiac_load` | index | 1 | i16 | avg | index | `OriginData3.cardiacLoads` ★ |
| `hypoxia` | min | 1 | i16 | sum | minutes | `OriginData3.hypoxiaTimes` ★ |
| `apnea` | index | 1 | i16 | max | index | `OriginData3.apneaResults` ★ |
| `steps` | steps | 1 | i32 | sum | steps | `OriginData.stepValue` — a bucket, not a total |
| `calories` | kcal | 100 | i32 | sum | kcal | `OriginData.calValue` bucket |
| `distance` | m | 1 | i32 | sum | meters | `OriginData.disValue` bucket (SDK reports km) |
| `sleep_state` | code | 1 | i16 | mode | state | `OriginData3.sleepStates` ★ |
| `activity_state` | code | 1 | i16 | mode | state | `OriginData3.gesture` + wear ★ |
| `battery` | % | 1 | i16 | last | percent | `BatteryData.batteryPercent` |

★ = arrives from the band today but is not yet forwarded by the Flutter app.

**Categorical codes.** `sleep_state`: 0 awake, 1 light, 2 deep, 3 rem, 4 nap,
5 unknown. `activity_state`: 0 unknown, 1 still, 2 walking, 3 running,
4 cycling, 5 other, 6 not_worn.

### Quality bits (per slot)

| Bit | Name | Meaning |
|---|---|---|
| 1 | `worn` | Wear detection confirmed skin contact |
| 2 | `corrected` | Band applied its own correction (`OriginData3.corrects`) |
| 4 | `clamped` | Outside the plausible range; clamped at ingest (ADR-010) |
| 8 | `derived` | Computed by the backend, not measured |
| 16 | `manual` | User-initiated measurement |

### Source codes (per slot)

| Code | Name | Meaning |
|---|---|---|
| 0 | `unknown` | |
| 1 | `live` | App-driven live detection (`startDetectHeart` etc.) |
| 2 | `auto` | Band-recorded, downloaded by history sync — **the normal case** |
| 3 | `poll` | Register poll (`readSportStep`) |
| 4 | `manual` | User-initiated one-shot |
| 5 | `platform_health` | Apple Health / Health Connect |
| 6 | `derived` | Computed server-side |

Source is both provenance and the merge tie-breaker. `findings.md` is explicit
that a two-hour-old automatic reading must never render like a live one; the
frontend has the information to say so.

---

## 4. Document shapes

### `users/{uid}`

```jsonc
{
  "uid": "firebase-subject",
  "email": "user@example.com",
  "profile": {
    "displayName": "…",
    "sex": "male | female | unspecified",
    "heightCm": 178,
    "weightKg": 70,
    "birthDate": "1996-04-11",
    "restingHrBaseline": 54
  },
  "goals":       { "steps": 8000, "activeKcal": 500, "sleepMinutes": 480, "distanceM": 5000 },
  "units":       { "distance": "km", "temperature": "c" },
  "preferences": { "theme": "dark", "accent": "peach", "onboardingComplete": true },

  // Team membership. Written only by the super-admin API.
  "trainerEmail": "trainer@gmail.com | null",
  "trainerUid": "firebase-subject | null",
  "trainerAssignedAt": 1754697600000,
  "trainerAssignedBy": "super-admin-firebase-subject",

  // Retention watermarks — how far the nightly sweep has already processed.
  "retentionRawThrough":    "2026-05-10",
  "retentionHourlyThrough": "2024-08-09",
  "updatedAt": 1754697600000
}
```

`profile` is not decoration. `syncPersonInfo` feeds height, weight, age and sex
into the band's own calorie, distance and body-composition maths, and the vendor
guide is explicit that demo values produce wrong results. Today the Flutter
onboarding collects all three and discards them, so the band runs on defaults.

### `trainerInvites/{normalized-gmail}`

```jsonc
{
  "email": "trainer@gmail.com",
  "status": "pending | active",
  "uid": "firebase-subject",       // present only after the first verified sign-in
  "invitedAt": 1754697600000,
  "invitedBy": "super-admin-firebase-subject",
  "activatedAt": 1754697700000
}
```

The pending record is intentionally keyed by a normalized Gmail address rather
than a guessed UID. On the trainer's first verified sign-in, the Worker binds
the invitation to that Firebase UID and activates all matching assignments.

### `users/{uid}/devices/{deviceId}`

```jsonc
{
  "deviceId": "AA:BB:CC:DD:EE:FF",   // MAC on Android, CoreBluetooth UUID on iOS
  "name": "KR96 PRO", "nickname": "My band",
  "model": "…", "firmware": "…", "platform": "android",
  "protocolVersion": 5,               // originProtocolVersion — selects the listener
  "watchDataDay": 3,                  // days of history the band retains
  "batteryPercent": 72, "charging": false,
  "capabilities": { /* verbatim from DeviceFunctionPackage1..5 */ },
  "watermarks": { "hr": 1754697900000, "spo2": 1754697600000 },
  "lastIngestAt": 1754698000000,
  "lastTzOffsetMin": 300
}
```

`capabilities` is stored verbatim: the surface is the band's, not ours, and
pinning a schema would mean a migration every time the SDK adds a flag.

The same physical band has different ids on Android and iOS. That is accepted;
the frontend groups by `model` + firmware when it needs to present them as one.

### `users/{uid}/days/{YYYY-MM-DD}`

```jsonc
{
  "v": 1,
  "date": "2026-08-09",
  "tzOffsetMin": 300,
  "deviceIds": ["AA:BB:CC:DD:EE:FF"],

  "streams_hr": {
    "n": 271,                          // populated slots
    "firstTs": 1754611200000,
    "lastTs":  1754697300000,
    "unit": "bpm", "agg": "avg",
    "ch": [{ "key": "bpm", "n": 271, "min": 52, "max": 141,
             "sum": 18428, "avg": 68, "first": 61, "last": 74, "value": 68 }],
    "h": "<bytes: 24-slot hourly frame>"   // stripped after 730 days
  },

  "counters": { "steps": 8432, "kcal": 412.5, "distanceM": 6120, "at": 1754697300000 },
  "sleep":    { "totalMinutes": 431, "deepMinutes": 96, "lightMinutes": 335,
                "remMinutes": 0, "wakeCount": 3, "startTs": …, "endTs": … },
  "scores_hrvDaily": 68,
  "rev": 14,
  "updatedAt": 1754697600000
}
```

Two details worth knowing:

- **`streams_hr`, not `streams.hr`.** Flat keys keep Firestore `updateMask`
  paths unambiguous, so two concurrent ingests carrying different metrics for
  the same day never overwrite each other and need no precondition.
- **`ch` values are in API units, `h` is scaled integers.** The surviving
  long-term tier is therefore independent of any future change to a stream's
  storage scale, and the document reads correctly in the Firestore console.

`counters` are the device's own cumulative daily totals from `readSportStep`,
merged by `max`. That mirrors `publishCurrentSteps` in the Kotlin bridge, which
exists because some devices return a transient zero from the step register — a
raw last-write-wins would show the user a phantom reset to zero.

### `users/{uid}/days/{date}/streams/{streamId}`

```jsonc
{
  "v": 1, "date": "2026-08-09", "stream": "hr",
  "slotSec": 300, "slots": 288, "channels": 3,
  "tzOffsetMin": 300,
  "deviceIds": ["AA:BB:CC:DD:EE:FF"],
  "f": "<bytes: 288 × 3 × int16 + 8-byte header = 1736 bytes>",
  "rev": 14,
  "updatedAt": 1754697600000
}
```

### `users/{uid}/months/{YYYY-MM}`

```jsonc
{
  "v": 1, "month": "2026-08", "slots": 31,
  "streams_hr":    { "channels": 4, "f": "<bytes: 31 × 4 × int32 + 8 = 504>" },
  "streams_steps": { "channels": 4, "f": "<bytes>" },
  "updatedAt": 1754697600000
}
```

~6 KB per user per month for every stream. A year of trend data is one batchGet
of 12 documents.

### `users/{uid}/nights/{YYYY-MM-DD}`

Keyed by **wake** date — the date a user means by "last night".

```jsonc
{
  "v": 1, "date": "2026-08-09", "tzOffsetMin": 300,
  "startTs": 1754607600000, "endTs": 1754633460000,
  "totalMinutes": 431, "deepMinutes": 96, "lightMinutes": 335,
  "remMinutes": 0,          // Veepoo does not separate REM from light
  "awakeMinutes": 12, "wakeCount": 3, "quality": 78,
  "source": 2,
  "segmentCount": 84,
  "segments": "<bytes: 84 slots × 3 int32 channels (offsetMin, durationMin, state)>"
}
```

Sleep is the one measurement delivered whole rather than on the five-minute
schedule, so it gets a session document (ADR-017). The slotted
`OriginData3.sleepStates` signal is stored *as well*, as the `sleep_state`
stream — they are different observations of the same night and both are kept.

### `users/{uid}/receipts/{batchId}`

```jsonc
{
  "batchId": "…", "accepted": 1440, "inserted": 1200, "merged": 240, "skipped": 0,
  "days": ["2026-08-08", "2026-08-09"],
  "watermarks": { "hr": 1754697900000 },
  "createdAt": 1754698000000,
  "expiresAt": "2026-08-16T12:00:00Z"    // Firestore TTL field — see 07-OPERATIONS.md
}
```

---

## 5. Slot arithmetic and timezones

`tzOffsetMin` is **minutes east of UTC** — Dart's
`DateTime.timeZoneOffset.inMinutes` convention (PKT = +300). This is the
*opposite* sign to JavaScript's `getTimezoneOffset()`; nothing in this codebase
uses that method.

```
localMs = utcMs + tzOffsetMin × 60000
date    = localMs → YYYY-MM-DD
slot    = floor((localMs mod 86400000) / 300000)      // 0 … 287
```

Reconstructing an instant:

```
startTs = Date.parse(date + "T00:00:00Z") − tzOffsetMin × 60000
sampleTs = startTs + slot × 300000
```

### The band gives no timezone at all

`BandConnectionManager.deviceTimestamp` builds a `GregorianCalendar` from the
band's wall-clock `TimeData` using whatever zone the phone is in at read time.
The phone's offset at capture is therefore the only zone information that exists
anywhere, which is why the client must send it and the server must store it.

### DST

A DST day is 23 or 25 local hours; the frame is always 288 slots (ADR-006).
Spring-forward leaves an hour of slots empty. Fall-back maps the repeated hour
onto slots already written, where the merge policy resolves it and the
`collisions` count in the ingest response makes it visible. Up to 12 samples per
DST-observing user per year collapse to one. `Frame` carries `slotCount` in its
header, so variable-length days remain a codec-compatible change.

---

## 6. Merge policy

When a sample lands on an occupied slot:

1. **Lower-precedence source loses.** `manual (60) > live (50) > auto (40) >
   poll (30) > platform_health (20) > derived (10) > unknown (0)`.
2. **Equal or higher precedence overwrites**, per channel.
3. **Identical values are a no-op** — nothing is marked dirty, no write is
   issued, `rev` does not move.

Rule 3 is why a repeated history sync of unchanged data costs reads but zero
writes. Since the band re-serves its whole retained window on every sync, that
is the common case, not an edge case.

---

## 7. Size and cost

Per user, all 16 streams populated:

| | per day | 90 days | per year |
|---|---|---|---|
| Raw blocks | ~15 KB | 1.4 MB | *expires* |
| Day docs (with hourly) | ~8 KB | — | 2.9 MB |
| Month docs | — | — | ~70 KB |
| **Steady state** | | | **~8.5 MB/user** |

Firestore operations per user per day, steady state:

| Operation | Count |
|---|---|
| Writes | ~16 blocks + 1 day + 1 month + 1 device + 1 receipt ≈ **20** |
| Reads (ingest) | ~17 per sync × syncs/day |
| Reads (dashboard) | 1–30 per view |

Compare doc-per-sample: ~3,500 writes and ~3,500 reads per user per day. That
factor of ~175 is the entire justification for ADR-002.

---

## 8. Indexes

Firestore's automatic single-field indexes cover everything this service
queries. The only query in the codebase is the retention sweep's range on
`date` within `days`, which single-field indexing already serves.

**Recommended exemptions** (Firestore console → Indexes → Single field →
Add exemption), to stop indexing large opaque blobs that are never filtered on:

| Collection | Field | Exempt |
|---|---|---|
| `streams` | `f` | ascending, descending, array |
| `months` | `streams_*` | ascending, descending, array |
| `nights` | `segments` | ascending, descending, array |
| `days` | `streams_*` | ascending, descending, array |

These are optimisations, not correctness requirements — see
[07-OPERATIONS.md](07-OPERATIONS.md).

---

## 9. Extending the model

**A new metric from the band.** Add one entry to the `SPECS` array in
[`src/domain/registry.ts`](../src/domain/registry.ts). Storage, aggregation,
validation, retention and `/ingest/schema` all follow. No migration: absent
streams simply have no document.

**A new channel on an existing metric.** Add it to the spec's `channels`.
`Frame.withChannelCount` reshapes stored frames on read, preserving existing
slots and starting the new channel null.

**A new session type** (workouts). Follow the `nights` pattern: a document per
session with a packed per-minute frame (ADR-019).

**Waveforms** (ECG, PPG). Do *not* add them here. Hundreds of samples per second
belong in R2 blobs referenced by an event document.

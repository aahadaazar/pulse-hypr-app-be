# Phase 5 Brief — Data Depth

A self-contained handoff for whoever (human or agent) implements Phase 5. You
should not need this session's conversation history — everything you need to
start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-5--data-depth) first** for the phase's
goal, entry criteria, and how it fits the overall roadmap. This document goes
one level deeper: the exact registry mapping, verified current-code state,
and a field-type caveat worth reading before writing any parsing code.

**Verified against the flutter repo's working tree as it stood when this was
written**, plus the locally-available `Android_Ble_SDK` reference-SDK apidoc.
This is by far the smallest phase in the roadmap — one task, no architecture
risk, no backend work — but it has one real trap (see "A field-type caveat"
below) that's easy to miss without checking the actual SDK.

---

## Before you touch anything

1. **Entry criteria: Phase 2 complete.** Confirmed `Done` in `PHASES.md` as
   of this writing.
2. **This task edits `BandConnectionManager.kt`, but not its protected
   parts.** [`flutter/AGENTS.md`](../flutter/AGENTS.md)'s do-not-touch zone
   is exactly three things: `BluetoothService`'s in-process declaration, the
   `vpprotocol` SDK version floor, and the GATT+notifications-ready handshake
   ordering in `beginConnect()`. This task only adds new `emitAt(...)` calls
   inside the existing `publishOrigin3` callback — a different code path
   entirely, already downstream of a completed, authenticated connection.
   Read `AGENTS.md` anyway before editing the file.
3. **No backend changes are needed.** Every target stream below is already
   modeled in [the metric registry](../backend/docs/02-DATA-MODEL.md#3-metric-registry)
   and accepted by `/v1/ingest` — confirmed by reading the registry table
   directly. This is Dart/Kotlin-only.
4. **Scope is slightly larger than `PHASES.md`'s task list names.**
   `PHASES.md`'s 5.1 lists five field groups (respiratory rate, sleep
   stages, blood glucose, cardiac load, apnea/hypoxia). The registry
   actually has **seven** fields marked ★ ("arrives from the band today but
   is not yet forwarded") — those five plus `activity_state`
   (`OriginData3.gesture` + wear), which `PHASES.md`'s task description
   just doesn't name explicitly. Since it's the same file, same pattern, and
   already registry-modeled, this brief recommends including it — see the
   table below.
5. **A field-type caveat — read this before writing any parsing code.** The
   locally-available `Android_Ble_SDK/android_sdk_source/apidoc` reference
   describes these new `OriginData3` fields as `String[]` arrays. **Don't
   trust that without verifying against the actual bundled SDK.** The
   apidoc is a generated/decompiled reference doc and may not exactly match
   `vpprotocol-2.3.77.15.aar`, the specific version this app compiles
   against (per `AGENTS.md`'s version floor). Evidence that it doesn't
   match, at least for a sibling field: the apidoc lists `ppgs` as
   `String[]`, but the app's own **already-working** code does
   `data.ppgs?.lastOrNull { it in 30..220 }` — an `Int` range comparison,
   which cannot compile against a `String` element type. So `ppgs` resolves
   to a numeric-comparable array in the real bundled version, contradicting
   the apidoc's claim for that same field. **Before writing conversion code
   for any of the fields below, confirm the actual compiled type** (Android
   Studio go-to-definition/autocomplete against the real bundled `.aar` is
   the fastest way) rather than assuming either the apidoc or this
   document's inferences are exactly right.

---

## What's being forwarded — verified registry mapping

| Registry stream | Unit/scale | Agg | Source field | SDK-doc element count | Notes |
|---|---|---|---|---|---|
| `resp_rate` | brpm, ×1 | avg | `OriginData3.resRates` | `[5]` per apidoc | Same shape family as `ppgs`/`ecgs`, which the app already parses — closest existing precedent |
| `sleep_state` | code, ×1 | mode | `OriginData3.sleepStates` | `[6]` per apidoc | **Different metric from the existing `/sleep` channel** — see note below |
| `glucose` | mmol/L, ×100 | avg | `OriginData3.bloodGlucose` | **scalar `float`**, not an array | The one field here that needs no array handling at all |
| `cardiac_load` | index, ×1 | avg | `OriginData3.cardiacLoads` | array (count not given in apidoc snippet) | |
| `apnea` | index, ×1 | max | `OriginData3.apneaResults` | array | **Use this field, not `isHypoxias`** — see note below |
| `hypoxia` | min, ×1 | sum | `OriginData3.hypoxiaTimes` | array | |
| `activity_state` | code, ×1 | mode | `OriginData3.gesture` + wear | String, posture/wear type | Not named in `PHASES.md`'s task list but registry-modeled and ★-marked; same effort, recommend including |

Categorical codes (from the registry doc): **`sleep_state`** — 0 awake, 1
light, 2 deep, 3 rem, 4 nap, 5 unknown. **`activity_state`** — 0 unknown,
1 still, 2 walking, 3 running, 4 cycling, 5 other, 6 not_worn.

### Two fields the registry deliberately does not model — don't forward these as new streams

- **`OriginData3.corrects`** — per the SDK reference doc, this is a blood-
  oxygen *correction/calibration* value ("same meaning as the Temp1 field in
  blood oxygen data"), not an independent metric. It has no registry entry
  because it isn't one. Leave it alone.
- **`OriginData3.isHypoxias`** — the SDK reference doc's own description
  says this is a legacy-named duplicate of apnea data, kept only for
  naming consistency with an older protocol version ("in the previous
  protocol this field represented apnea, so the naming was kept
  consistent"). The registry's `apnea` stream maps to `apneaResults`
  specifically — use that field, not this one.

### An optional eighth field, worth a decision but not required

The registry's `spo2` row lists two source fields:
`Spo2hOriginData.oxygenValue` (already forwarded, via the existing
`publishSpo2`/`/oxygen` channel) **and `OriginData3.oxygens`** (confirmed
**not** forwarded today — `publishOrigin3`/`publishOrigin` never reference
`data.oxygens`). Unlike the seven fields above, this one isn't marked ★ in
the registry doc despite genuinely being dropped by that doc's own
definition of what ★ means — likely just missed when the doc was written,
not a deliberate exclusion. Forwarding it is the same effort as the others
and would give `spo2` a second, higher-frequency source (5-minute history
buckets, alongside the existing sparser live/poll reads) — worth doing in
the same pass, but not blocking if you'd rather keep this phase strictly to
the seven ★-marked fields.

### Why `sleep_state` is not redundant with the existing `/sleep` channel

The backend's own design doc is explicit about this
(`backend/docs/02-DATA-MODEL.md`): *"Sleep is the one measurement delivered
whole rather than on the five-minute schedule, so it gets a session document
(ADR-017). The slotted `OriginData3.sleepStates` signal is stored as well,
as the `sleep_state` stream — they are different observations of the same
night and both are kept."* The app already forwards the whole-night session
via the existing `/sleep` `EventChannel` (`SleepReading`) — that is a
separate, already-working thing. `sleep_state` here is the five-minute-
slotted signal, a distinct stream with its own registry entry. Don't treat
the existing `/sleep` channel as covering this.

---

## What to build

**The pattern is the same for every field** — worked example using
`resp_rate`, then the deltas for the rest:

1. In `BandConnectionManager.kt`'s `publishOrigin3(data: OriginData3)`, add
   a call alongside the existing heart-rate extraction:
   ```kotlin
   // matches the existing ppgs/ecgs handling directly above this line
   val respRate = data.resRates?.lastOrNull { /* plausible-range check, once the real element type is confirmed */ }
   if (respRate != null) {
       emitAt("resp_rate", "brpm" to respRate, deviceTimestamp(data))
   }
   ```
   Follow the *exact* precedent already set by the `ppgs`/`ecgs` handling a
   few lines above — same function, same `deviceTimestamp(data)` call, same
   "take the last plausible reading in the array" approach. Confirm the
   real element type first (see the field-type caveat above) before
   assuming what "plausible-range check" should look like for each field —
   a respiratory rate's plausible range is obviously different from a
   cardiac-load index's.
2. **`glucose` needs no array handling** — `bloodGlucose` is a scalar
   `float` per the reference doc. Emit it directly:
   `emitAt("glucose", "mmolPerL" to data.bloodGlucose, deviceTimestamp(data))`,
   guarded by whatever plausibility check makes sense (the existing fields
   guard with e.g. `> 0` or a range check — match that convention).
3. **`sleep_state` and `activity_state` are categorical** — the raw SDK
   value needs mapping to the documented codes (0–5 for sleep, 0–6 for
   activity) before or after crossing the bridge. Decide once, consistently
   with how `activity_state` combines `gesture` **and** wear-state (the
   registry entry says "`OriginData3.gesture` + wear" — confirm what "wear"
   source the SDK exposes alongside gesture; it may be a separate field or
   flag not yet identified in this brief).
4. **`apnea`** uses `apneaResults`, **not** `isHypoxias` — see the note
   above.
5. **`cardiac_load` and `hypoxia`** follow the same array-reduction pattern
   as `resp_rate`; `hypoxia`'s registry aggregation is `sum` (unlike the
   others' `avg`/`mode`/`max`), which may mean summing the array's elements
   within one callback is more semantically correct than taking the last
   one — worth a moment's thought per-field rather than copy-pasting the
   same reduction for all seven.
6. **Register the new channel names.** `VeepooBandChannel.kt`'s companion
   object has a driven `METRICS` list
   (`listOf("heartRate", "oxygen", "hrv", "bodyTemp", "steps", "sleep",
   "bloodPressure", "battery", "syncProgress")`) that a loop turns into one
   `EventChannel` per entry, all routing through the single
   `Listener.onMetric(metric, payload)` interface method. **Adding a new
   metric is just adding its string to this list** — no new channel
   boilerplate needed per field.
7. **Dart side**, mirroring the existing pattern in
   `veepoo_band_connection.dart` (e.g. the `_oxygenChannel` /
   `Stream<SpO2Reading> spo2` pair): add an `EventChannel` constant per new
   stream, a typed `Reading` model in `lib/src/band/models.dart`, and a
   `late final Stream<XReading> x = _xChannel.receiveBroadcastStream().map(...)`
   getter.
8. **Wire into `band_controller.dart`**, alongside the existing
   `band.battery.listen(...)` / `band.syncProgress.listen(...)` subscriptions
   — call `_persistSample` (the local-store write path from Phase 1) with
   the registry stream id (`'resp_rate'`, `'glucose'`, etc.) and
   `source: 'auto'`, matching the convention already used for other
   origin-history-derived readings (see
   [`backend/docs/06-FLUTTER-INTEGRATION.md`](../backend/docs/06-FLUTTER-INTEGRATION.md)'s
   metric-mapping table for the `source` convention).

### Files

`android/.../BandConnectionManager.kt` (`publishOrigin3` — the new
`emitAt` calls) · `android/.../VeepooBandChannel.kt` (`METRICS` list — add
the new stream names) · `lib/src/band/models.dart` (new `Reading` model
classes) · `lib/src/band/veepoo/veepoo_band_connection.dart` (new
`EventChannel` constants + typed streams) · `lib/src/app/band_controller.dart`
(subscribe, `_persistSample` wiring)

---

## Definition of done

- The new streams appear with real data via `/v1/metrics/*` for a
  connected band that supports them (the phase's stated exit criterion in
  `PHASES.md`).
- `sleep_state` and `activity_state` decode to the documented categorical
  codes, not raw SDK values.
- `glucose` emits as a plain scalar reading — no array-reduction logic
  applied to it.
- `corrects` is **not** forwarded as its own stream.
- `apnea` is sourced from `apneaResults`, not the legacy `isHypoxias`
  field.
- The existing `/sleep` (whole-night session) channel is unchanged and
  still works — `sleep_state` is additive, not a replacement.

## What NOT to do in this phase

- Don't forward `OriginData3.corrects` as a new stream — it's a blood-
  oxygen calibration value, not a metric the registry models.
- Don't use `isHypoxias` for the `apnea` stream — use `apneaResults`, the
  field the registry actually names.
- Don't trust the reference apidoc's declared field types (`String[]`)
  without confirming against the real bundled `.aar` — see the field-type
  caveat above; at least one sibling field (`ppgs`) is confirmed to differ
  from what the apidoc claims.
- Don't touch anything inside `AGENTS.md`'s do-not-touch zone — this phase
  only adds `emitAt` calls inside `publishOrigin3`, nothing scan/connect/
  handshake related.
- Don't do backend work — nothing here needs it.

# Decision Record

Every architectural decision behind this backend, with the reasoning and the
alternatives that were rejected. Written so that a future engineer — or a future
version of us — can tell the difference between a considered trade-off and an
accident, and can reverse a decision knowingly.

Status values: **Accepted** (in force), **Deferred** (deliberately not decided
yet), **Superseded** (replaced; kept for the record).

Four decisions (001, 002, 004, 009) were made by the project owner on
2026-08-09 during the design review. The rest follow from them or from
constraints found in the app and SDK during recon.

---

## ADR-001 — All client reads go through this API; Firebase is auth plus storage

**Status:** Accepted · **Decided by:** project owner · 2026-08-09

**Context.** The Flutter app already authenticates with Firebase Auth via Google
Sign-In. A web dashboard is planned but not built. The dashboard could read
Firestore directly with the Firebase JS SDK and security rules, or go through a
Worker API.

**Decision.** Every client read and write goes through the Hono API. Firebase
provides identity (ID tokens the API verifies) and storage (Firestore, reached
only by the Worker's service account). No client ever holds a Firestore
credential or knows the collection layout.

**Consequences.**
- One query surface for phone and dashboard; a bug is fixed once.
- The storage layout is a private implementation detail, which is what makes
  ADR-002 and ADR-012 safe — packed binary frames would be hostile to a client
  reading Firestore directly, but the API decodes them into plain JSON.
- No Firestore security rules to write or get wrong; authorisation is one
  `uid` check in one middleware ([`src/auth/middleware.ts`](../src/auth/middleware.ts)).
- Storage can be migrated (to D1, to R2 Parquet, to a hybrid) without touching a
  single client.
- **Cost:** no Firestore realtime listeners, so a "live" dashboard needs polling
  or a future SSE/WebSocket endpoint. Acceptable — band data updates every five
  minutes at best.
- **Cost:** the Worker is on the critical path for reads. Mitigated by the tier
  design (ADR-009): every endpoint has a bounded document-read count.

**Rejected: direct Firestore SDK access.** Cheapest to build and gives realtime
free, but permanently freezes the data shape as whatever the client can parse,
pushes authorisation into rules, and would have made packed frames impossible.

---

## ADR-002 — Raw samples are stored as packed day blocks, not one document per sample

**Status:** Accepted · **Decided by:** project owner · 2026-08-09

**Context.** The band records automatically every five minutes: 288 samples per
stream per day, across ~12 streams once every field the SDK already delivers is
captured (ADR-004). That is ~3,500 readings per user per day. Firestore bills
per document read and write.

**Decision.** One document per `(user, local date, stream)` holds the whole day
as a fixed 288-slot frame. Slot index is derived from the sample's local
timestamp, so writing is idempotent by position.

**Consequences.**

| | doc-per-sample | packed day blocks |
|---|---|---|
| Writes/user/day | ~3,500 | ~15 |
| Reads to chart one day | ~3,500 | ~12 |
| Reads to chart 30 days (hourly) | ~105,000 | 30 |
| Bytes/user/day | ~350 KB | ~15 KB |

- Ingest cost is proportional to *days touched*, not samples. Re-uploading a
  full day of 288 samples costs the same one write as uploading one sample.
- Dedup is free: same timestamp → same slot → same position overwritten.
- **Cost:** no server-side query on an individual sample value ("find every day
  I exceeded 180 bpm" cannot be a Firestore query). Answered instead from the
  per-day `min`/`max` on the day document, which is what such a question
  actually needs.
- **Cost:** read-modify-write on the block, requiring concurrency control
  (ADR-007).

**Rejected: doc-per-sample.** Simple and queryable, but the cost curve turns bad
before 1,000 users, and charting a week would cost ~25,000 reads.

**Rejected for now: hybrid D1/R2 + Firestore rollups.** Better analytics and
lower cost still, but two stores to keep consistent, and it contradicts the
"save it in Firebase" premise. ADR-001 keeps this reversible.

---

## ADR-003 — Firestore is reached over REST with a service account, not `firebase-admin`

**Status:** Accepted

**Context.** `firebase-admin` is a Node library depending on Node's crypto and
HTTP stacks. Cloudflare Workers run on V8 isolates with Web APIs; even with
`nodejs_compat` the admin SDK is a poor fit and a heavy cold-start cost.

**Decision.** Talk to the Firestore REST API directly
([`src/firestore/client.ts`](../src/firestore/client.ts)). Mint service-account
access tokens by signing a JWT assertion with Web Crypto
([`src/firestore/token.ts`](../src/firestore/token.ts)) and cache the resulting
token in KV and in the isolate.

**Consequences.**
- Cold start is one KV read, not a token exchange, because the access token is
  shared across isolates.
- Only five Firestore operations exist in the codebase (get, batchGet, commit,
  runQuery, list), which keeps the surface auditable.
- **Cost:** `Value` encoding must be handled by hand
  ([`src/firestore/value.ts`](../src/firestore/value.ts)).
- The service-account key is a full-database credential. It lives only in
  Worker secrets and never leaves the Worker.

---

## ADR-004 — The schema models every field the SDK already delivers, not just what the app shows

**Status:** Accepted · **Decided by:** project owner · 2026-08-09

**Context.** `OriginData3` — already received by
`BandConnectionManager.publishOrigin3` on every history sync — carries
`resRates`, `oxygens`, `bloodGlucose`, `cardiacLoads`, `apneaResults`,
`hypoxiaTimes`, `sleepStates`, `corrects`, `gesture`, `ppgs` and `ecgs`. The
Flutter app publishes exactly one of them (the last plausible `ppgs` entry, as
heart rate) and drops the rest.

**Decision.** The registry ([`src/domain/registry.ts`](../src/domain/registry.ts))
defines all of them now: 16 streams with units, ranges, scales and aggregation
rules. The app forwards them as it is updated; the backend needs no migration.

**Consequences.**
- Surfacing respiratory rate or sleep stages later is an app change only.
- The `corrects` flag becomes a per-slot quality bit rather than a stream, so
  the frontend can visually distinguish a band-corrected reading.
- **Cost:** ~16 streams instead of ~8 doubles per-day storage — from ~7 KB to
  ~15 KB per user per day. Immaterial.
- Waveform arrays (`ppgs`, `ecgs`) are explicitly *not* stored as time series;
  see ADR-019.

**Rejected: model only today's dashboard tiles.** Smaller now, but a schema
migration on real user data the first time a new metric ships.

---

## ADR-005 — The local calendar day is the partition key; timezone offset travels with the data

**Status:** Accepted

**Context.** The band reports wall-clock time with no zone
(`TimeData` → `GregorianCalendar` in `BandConnectionManager.deviceTimestamp`),
interpreted in whatever zone the phone is in at the moment of the read. Nothing
in the current pipeline records which zone that was. A user who flies from
Karachi to London gets history silently shifted by five hours.

**Decision.** Every ingest batch carries `tzOffsetMin`, minutes east of UTC
(Dart's `DateTime.timeZoneOffset.inMinutes` convention — note this is the
opposite sign to JavaScript's `getTimezoneOffset()`). Samples are bucketed into
the local calendar day and stored under it; the offset is stored on the block
and returned with every read.

**Consequences.**
- "Yesterday's steps" means the steps between the midnights the user actually
  lived through, which is the only definition a fitness user recognises.
- Absolute UTC instants are always reconstructible: `startTs` plus slot index.
- A day's samples recorded across a zone change carry the offset of the batch
  that delivered them. Documented imprecision, not corruption — the offset is
  recorded rather than assumed.

---

## ADR-006 — Day frames are a fixed 288 slots, including across DST transitions

**Status:** Accepted

**Context.** A DST day is 23 or 25 local hours. A variable-length frame would be
exactly correct and would complicate every reader, writer, aggregator and index
calculation for two days a year in zones that observe DST.

**Decision.** 288 slots always. On a spring-forward day one hour of slots stays
empty; on a fall-back day the repeated hour maps onto slots already written,
where the merge policy (ADR-008) resolves the collision.

**Consequences.**
- All frame arithmetic is constant and testable.
- **Cost:** up to 12 samples in one repeated hour per year, per DST-observing
  user, resolve to one value rather than two. The `collisions` counter in the
  ingest response makes this visible rather than silent.
- Reversible: `Frame` already carries `slotCount` in its header, so a
  variable-length day is a codec-compatible change if it ever matters.

---

## ADR-007 — Optimistic concurrency, not Firestore REST transactions

**Status:** Accepted

**Context.** Ingest is read-modify-write on a block. A REST transaction costs
three round-trips (`beginTransaction`, read, `commit`).

**Decision.** Read the block with its `updateTime`, merge in memory, and commit
with `currentDocument.updateTime` as a precondition. A concurrent write fails
the precondition; the route reloads the whole day and reapplies, up to three
attempts ([`src/domain/ingest.ts`](../src/domain/ingest.ts) `processDay`).

**Consequences.**
- Two round-trips instead of three on the common path.
- Contention is rare by construction: the contending writers would be two of one
  user's own phones syncing the same day at the same second.
- Retry reloads and reapplies rather than patching, because the merge policy is
  only correct against current state.
- All writes for one day — every stream block plus the day rollup — go in one
  commit, so a rollup can never describe a block that failed to write.

---

## ADR-008 — Idempotency at two levels: batch receipts and slot merge

**Status:** Accepted

**Context.** The band re-serves its entire retained window on every history sync
(`ReadOriginSetting` is built with the full `watchDataDay`, and there are no
cursors), so the same samples arrive repeatedly. Mobile uploads also retry.

**Decision.** Two independent mechanisms:
1. **Batch level.** Every request carries a client-generated `batchId`. A
   receipt document records the result; a replay returns the stored result with
   `duplicate: true` and touches nothing. Receipts expire after 7 days via a
   Firestore TTL policy.
2. **Slot level.** Identical values re-applied to the same slot leave the block
   unchanged, so no write is issued at all. When values differ, source
   precedence decides: `manual > live > auto > poll > platform_health >
   derived > unknown`.

**Consequences.**
- The client can retry freely, which is what makes aggressive batching safe.
- A repeat sync of unchanged data costs reads but no writes.
- Precedence is explicit and testable rather than "last write wins by accident".

---

## ADR-009 — Retention tiers: raw 90 days, hourly 2 years, daily forever

**Status:** Accepted · **Decided by:** project owner · 2026-08-09

**Context.** Reporting granularity was a stated product requirement. Keeping
5-minute data forever is affordable with packed blocks but grows without bound,
while daily aggregates are tiny and answer most long-range questions.

**Decision.** Three tiers, each mapped to a storage location so that expiry is a
delete of one thing:

| Tier | Resolution | Lives in | Retained |
|---|---|---|---|
| raw | 5 min, 288 slots | `days/{date}/streams/{stream}` | 90 days |
| hourly | 1 h, 24 slots | `h` field on `days/{date}` | 730 days |
| daily | 1 day, 31 slots | `months/{YYYY-MM}` | forever |

Both figures are `wrangler.toml` vars, changeable without a code change.

**Consequences.**
- `/metrics/series?resolution=` selects the tier directly; a request never fans
  out across tiers, so cost is predictable from the parameters.
- Deleting raw data never touches a day document, and the hourly/daily numbers
  that survive were computed at ingest.
- Steady state per user: ~1.4 MB raw + ~6 MB hourly + ~70 KB/year daily.
- The sweep uses a per-user watermark so each expired day is examined once ever,
  keeping nightly cost flat as the dataset ages
  ([`src/domain/retention.ts`](../src/domain/retention.ts)).

**Note.** Raw deletion is the only irreversible operation in the system. Anyone
raising `RETENTION_RAW_DAYS` should know it does not resurrect what is gone.

---

## ADR-010 — Implausible values are clamped and flagged, never rejected

**Status:** Accepted

**Context.** A batch can hold 20,000 samples. Bands with a loose strap or a dirty
sensor emit occasional nonsense.

**Decision.** Values outside the registry's physiological range are clamped to
the bound and marked with the `CLAMPED` quality bit. Only structurally invalid
input (wrong type, implausible timestamp, unknown stream) is rejected, and then
per-point — the batch still succeeds and the response lists what was dropped.

**Consequences.**
- One bad reading cannot make a phone retry a 20,000-sample batch forever, which
  is precisely the battery drain this backend exists to avoid.
- The frontend can grey out or exclude flagged samples; nothing is silently
  presented as fact.
- **Cost:** a clamped value is stored at the boundary rather than as null. The
  quality bit is what distinguishes it.

---

## ADR-011 — One runtime dependency: Hono

**Status:** Accepted

**Context.** Workers bill CPU time and cap bundle size; cold start matters on a
service a phone calls from the background.

**Decision.** `hono` is the only runtime dependency. Validation, JWT
verification, Firestore encoding and the frame codec are all hand-written.

**Consequences.**
- Small bundle, fast cold start, no transitive supply-chain surface.
- Validation runs inside a 20,000-iteration loop where a schema library's
  per-element overhead would be the dominant cost.
- **Cost:** ~200 lines of validators to maintain
  ([`src/lib/validate.ts`](../src/lib/validate.ts)).

---

## ADR-012 — Frames are Firestore `bytes`, not arrays

**Status:** Accepted

**Context.** Firestore indexes array elements individually. A 288-element array
consumes 288 index entries against a 20,000-entry-per-document ceiling.

**Decision.** Every frame is one opaque `bytesValue`, encoded by
[`src/lib/frame.ts`](../src/lib/frame.ts).

**Consequences.**
- One index entry per frame instead of hundreds, for indexes no query uses.
- ~4× smaller than the equivalent JSON numbers.
- Atomic: a frame cannot be half-written.
- **Cost:** unreadable in the Firestore console. Mitigated by keeping the day
  document's per-channel statistics as plain numbers in API units.
- Only possible because of ADR-001 — no client parses these.

---

## ADR-013 — Values are stored as scaled integers

**Status:** Accepted

**Context.** Frames are fixed-width integer matrices. Temperature (36.55 °C),
calories (12.345 kcal) and glucose need sub-unit precision.

**Decision.** Each stream declares a `scale`; `stored = round(apiValue * scale)`.
Temperature and glucose use 100, calories 100, everything else 1. Null is the
dtype's minimum value, kept far from any real reading by the range checks.

**Consequences.**
- Exact comparison, so idempotent re-upload detection is reliable — float
  equality would not be.
- No binary-fraction drift in stored data.
- **Cost:** a scale change would require re-encoding stored frames. Guarded
  against by keeping the day document's aggregates in API units, so the
  surviving long-term tiers are scale-independent.

---

## ADR-014 — Sync cadence is server-driven configuration

**Status:** Accepted

**Context.** Upload frequency, batch size, battery floor and metered-network
policy are the levers that determine both phone battery cost and backend load.
Compiled into the app, changing them takes an app-store release and months to
reach users.

**Decision.** `GET /v1/config` returns the sync policy; the client caches it and
obeys it. Feature flags ride the same document.

**Consequences.**
- Ingest load can be retuned on the fly, including throttling a bad release.
- The client must treat the config as advisory and keep working on its cached
  copy when offline.

---

## ADR-015 — Unpairing a device keeps its data

**Status:** Accepted

**Context.** `BandController.forgetBand` exists in the app today. The naive
server behaviour would be a cascading delete.

**Decision.** `DELETE /v1/devices/:id` removes the device document only.
Measurements are the user's health history, not the device's, and they remain.
The response says so explicitly (`dataRetained: true`).

**Consequences.**
- Replacing a broken band does not destroy months of history.
- Account deletion is a separate, explicit, and deliberately unimplemented flow
  — see [07-OPERATIONS.md](07-OPERATIONS.md).

---

## ADR-016 — Firebase ID tokens are verified in-process with Web Crypto

**Status:** Accepted

**Decision.** Verify RS256 signatures against Google's published JWK set,
checking `aud`, `iss`, `exp`, `iat` and `sub`, with 60 seconds of clock skew
([`src/auth/firebase.ts`](../src/auth/firebase.ts)). The key set is cached in the
isolate and in KV; an unknown `kid` triggers exactly one refetch, which is how
Google's key rotation is absorbed without downtime.

**Consequences.**
- A warm isolate verifies tokens with no network and no KV read.
- `token_expired` is a distinct error code from `unauthenticated`, so a client
  whose token expired mid-backlog refreshes and retries the same batch rather
  than discarding it.
- `uid` comes only from the verified token; no endpoint accepts a uid in a path
  or body.

---

## ADR-017 — Sleep is a session document, not a slotted stream

**Status:** Accepted

**Context.** Sleep is the one measurement the band delivers whole rather than on
its five-minute schedule: a night is a variable-length run of stage segments
(`SleepData.sleepLine`).

**Decision.** `users/{uid}/nights/{wakeDate}` holds the session and its segments
(packed with the same frame codec, one slot per segment). A `sleep_state` stream
also exists for the slotted `OriginData3.sleepStates` signal — they are different
observations of the same thing and both are kept.

**Consequences.**
- Segment fidelity is preserved instead of being quantised to five minutes.
- Keyed by wake date, which is the date a user means by "last night".
- `remMinutes` exists but is 0 for this band — the Veepoo protocol does not
  separate REM from light sleep. Apple Health does, and lands in the same
  document.

---

## ADR-018 — The server publishes a sync manifest; the client uploads only gaps

**Status:** Accepted

**Context.** Radio time is the dominant battery cost in this system. The
Bluetooth side already gets this wrong — no cursors, so every band sync
re-downloads the full retained window (`docs/fixes/02` in the Flutter repo). The
phone-to-cloud link should not repeat the mistake.

**Decision.** Two endpoints let the client compute the minimum upload:
- `GET /v1/sync/state` — per-stream watermarks (newest timestamp the server
  holds) plus this deployment's limits.
- `GET /v1/sync/manifest` — per-day, per-stream `n` and `lastTs`. The client
  diffs against its local store and uploads only days where it has more.

The manifest reads day documents, so two months of coverage costs 62 document
reads regardless of sample count.

**Consequences.**
- Steady state is one small batch per sync instead of a full-history re-upload.
- Recovers correctly from a partial upload: the next manifest shows exactly what
  is missing.
- Handles reinstall in both directions — the same endpoints tell a fresh app
  what to *download* to hydrate its dashboard.

---

## ADR-019 — Deferred: workouts, ECG, waveforms, derived scores, food logging

**Status:** Deferred

**Context.** The SDK also exposes `SportModelOrigin*` (workout sessions with GPS
and per-minute detail), `EcgDetectResult` / `RRIntervalData` / Lorenz plots, body
composition, and fatigue. The app has a `Log Activity` screen with exercise and
food tabs that is currently UI-only.

**Decision.** Not modelled in v1. `GET /v1/config` exposes them as `false`
feature flags so the client can be built against the eventual shape.

**Reasoning and intended shape when they arrive:**
- **Workouts** — a session document per workout, like sleep (ADR-017), with a
  packed per-minute frame. Fits the existing pattern; needs no new mechanism.
- **ECG and PPG waveforms** — hundreds of samples per second, categorically
  different from everything here. These belong in R2 as blobs referenced by an
  event document, not in Firestore. Storing them as time series would be a
  design error, which is why `ppgs`/`ecgs` are deliberately absent from the
  registry even though ADR-004 captures everything else.
- **Derived scores** (readiness, recovery, stress) — computable server-side from
  HRV, resting heart rate and sleep once enough raw history exists. The
  `scores_*` fields on the day document already hold whole-day values such as
  `onDayHrvScore`, so the storage is in place.
- **Food logging** — user-entered, not band data. It needs a different write
  path (mutable, correctable, no dedup by timestamp) and probably a food
  database; folding it into the sample pipeline would distort both.

---

## ADR-020 — The two Firebase projects must be consolidated before iOS ships

**Status:** Accepted (blocking, not yet actioned)

**Context.** `flutter/firebase.json` declares `projectId: hypr-8064c` for Android
and Dart, and `projectId: pulse-hypr` for the iOS default platform, while
`firebase_options.dart` uses `hypr-8064c` for both. ID tokens are project-scoped:
`aud` and `iss` must match `FIREBASE_PROJECT_ID`.

**Decision.** The backend accepts exactly one project, configured in
`wrangler.toml`, currently `hypr-8064c`. Multi-project acceptance is explicitly
not supported — it would mean two users could share a uid across projects and
collide in one Firestore namespace.

**Consequences.**
- An iOS build issuing `pulse-hypr` tokens gets `unauthenticated` with a message
  naming the audience mismatch.
- Consolidation must happen in the Flutter project before iOS can sync. See
  [07-OPERATIONS.md](07-OPERATIONS.md).

---

## Open questions

Not decisions — things deliberately left to be settled with more information.

1. **Multiple phones, one account.** The design tolerates it (idempotent ingest,
   source precedence, per-device watermarks) but it is untested. Two phones
   syncing the same band concurrently is the main source of ADR-007 retries.
2. **Data residency.** Firestore is single-region per project. If EU users
   arrive, a second project and region routing is the likely answer, and ADR-001
   is what makes it possible.
3. **Rate limiting.** None today. A misbehaving client can only damage its own
   data, but not its own bill. The natural place is a Durable Object per uid.
4. **Backfill priority.** The sync protocol recommends newest-first
   ([04-SYNC-PROTOCOL.md](04-SYNC-PROTOCOL.md)) so the dashboard is correct
   before the archive completes, but the server does not enforce it.

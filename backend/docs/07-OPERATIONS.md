# Operations

Setup, deployment, cost, and the things that will page you.

---

## 1. Prerequisites

- Cloudflare account with Workers (the free plan works; Cron Triggers and
  KV are both included)
- Firebase project **`hypr-8064c`** with Firestore in Native mode
- Node 20+, `npx wrangler`

---

## 2. Firebase setup

### 2.1 Service account

Firebase console → Project settings → Service accounts → **Generate new private
key**. Keep the JSON out of version control.

The account needs **Cloud Datastore User** (`roles/datastore.user`). Do not use
an Owner key — this Worker only ever reads and writes documents.

### 2.2 Firestore database

Create in **Native mode** (not Datastore mode).

Pick the region deliberately: Firestore is single-region per project and cannot
be moved later. Choose the one nearest the majority of users — it is the floor
on every API response time, since the Worker runs at the edge but Firestore does
not.

### 2.3 TTL policy for ingest receipts — required

Firestore console → Firestore → **TTL** → Create policy:

| Field | Value |
|---|---|
| Collection group | `receipts` |
| Timestamp field | `expiresAt` |

Without this, idempotency receipts accumulate forever. They are the only
collection that grows unboundedly by design, and this policy is what bounds it.

### 2.4 Index exemptions — recommended

Firestore console → Firestore → Indexes → Single field → **Add exemption**.
Disable ascending, descending and array indexing for:

| Collection group | Field |
|---|---|
| `streams` | `f` |
| `days` | `streams_hr`, `streams_bp`, … (one per stream) |
| `months` | `streams_hr`, `streams_bp`, … |
| `nights` | `segments` |

These are large opaque blobs no query filters on. Skipping them saves write cost
and index storage. **Optimisation only — the service is correct without them.**

### 2.5 Consolidate the two Firebase projects — blocking for iOS

[`flutter/firebase.json`](../../flutter/firebase.json) currently declares:

```
android → projectId: hypr-8064c
ios     → projectId: pulse-hypr      ← different project
dart    → projectId: hypr-8064c
```

ID tokens are project-scoped: `aud` and `iss` must match `FIREBASE_PROJECT_ID`.
An iOS build issuing `pulse-hypr` tokens is rejected with an audience mismatch.

Multi-project acceptance is deliberately not supported (ADR-020) — two projects
can mint the same uid, and they would collide in one Firestore namespace.

**Resolve in the Flutter project before iOS sync ships:** re-run
`flutterfire configure` against `hypr-8064c` for all platforms, or move
everything to `pulse-hypr` and update `FIREBASE_PROJECT_ID` here.

---

## 3. Cloudflare setup

```bash
cd backend
npm install

# KV namespace for the OAuth token and Firebase JWK set
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
# Paste the returned ids into wrangler.toml (id / preview_id)

# Secrets
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY   # full PEM, \n escapes are fine
```

`FIREBASE_PRIVATE_KEY` is accepted both with literal `\n` escapes (as it appears
in the service-account JSON) and with real newlines.

### Local development

```bash
cp .dev.vars.example .dev.vars     # fill in the two secrets
npm run dev                        # http://localhost:8787
```

`wrangler dev` talks to the **real** Firestore. Use a separate Firebase project
for development if you do not want test writes in production data.

### Deploy

```bash
npm run typecheck && npm test
npx wrangler deploy                      # default environment
npx wrangler deploy --env production
```

---

## 4. Configuration

Non-secret values live in `wrangler.toml`; changing them is a redeploy, not a
code change.

| Var | Default | Effect |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `hypr-8064c` | Which project's ID tokens are accepted |
| `RETENTION_RAW_DAYS` | `90` | Age at which 5-minute blocks are deleted |
| `RETENTION_HOURLY_DAYS` | `730` | Age at which hourly frames are stripped |
| `MAX_SAMPLES_PER_BATCH` | `20000` | Ingest ceiling |
| `ENVIRONMENT` | `development` | Reported by `GET /` |

⚠️ **Lowering `RETENTION_RAW_DAYS` deletes data on the next cron run.** Raising it
does not bring anything back. This is the only irreversible operation in the
system.

Client-facing knobs — sync cadence, battery floor, feature flags — are served by
`GET /v1/config` and live in [`src/routes/profile.ts`](../src/routes/profile.ts).
Changing those retunes every phone without an app release (ADR-014).

---

## 5. The retention cron

Runs at **03:20 UTC daily** (`[triggers] crons` in `wrangler.toml`), off the top
of the hour to avoid the platform-wide cron herd.

Per run it:
1. Pages through `users`, resuming from a KV cursor if the previous run ran out
   of budget.
2. For each user, queries day documents in `(retentionRawThrough, cutoff)` and
   deletes their `streams` subcollections.
3. Strips `h` (hourly frames) from day documents past the hourly cutoff.
4. Advances the per-user watermark.

Two properties keep it cheap: the watermark means each expired day is examined
**once, ever**; and the 20-second budget with a KV cursor means it never exceeds
its invocation limits.

```bash
# Trigger manually against a local dev server
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=20+3+*+*+*"

npx wrangler tail --format pretty     # watch the `retention` log line in production
```

A failed run is safe: deletions already committed stay committed, watermarks are
recorded, and the next run resumes.

---

## 6. Cost

Assuming steady state — one band, all 16 streams, ~4 syncs a day.

### Firestore, per user per day

| Operation | Count | Notes |
|---|---|---|
| Document writes | ~20 | 16 blocks + day + month + device + receipt |
| Document reads (ingest) | ~70 | ~17 per sync × 4 |
| Document reads (dashboard) | ~30 | typical session |
| Deletes | ~16/day at steady state | one expiring day |

At Firestore's published pricing (~$0.18/100k writes, ~$0.06/100k reads) this is
roughly **$0.0002 per user per day**, or about **$6/month at 1,000 users** —
dominated by reads, not writes.

Doc-per-sample would be ~3,500 writes and ~3,500 reads per user per day: about
**$1,000/month at the same 1,000 users**. That ~175× gap is the whole argument
for ADR-002.

### Storage

~8.5 MB per user per year in steady state (1.4 MB raw + ~6 MB hourly + ~70 KB
daily). 1,000 users ≈ 8.5 GB ≈ $1.50/month.

### Workers

Requests: ~4 ingest + ~20 read per user per day. At 1,000 users that is ~24k
requests/day — inside the free tier, and trivially inside the $5 paid plan.

CPU: the hot path is a 20,000-iteration validation loop plus frame merges,
typically 10–40 ms. Well inside the 30 s limit.

### The thing that would actually cost money

An app bug that ignores watermarks and re-uploads full history every sync. Reads
would rise ~50× while writes stayed flat (identical samples are skipped, ADR-008).
Watch `skipped` in ingest responses — see §8.

---

## 7. Monitoring

```bash
npx wrangler tail --format pretty
npx wrangler tail --status error
```

Structured lines worth alerting on:

| Log | Meaning |
|---|---|
| `retention {...}` | Nightly sweep summary. `budgetExhausted: true` for several consecutive days means it is falling behind |
| `[requestId] internal_error` | Unhandled exception — always investigate |
| `[requestId] upstream_error` | Firestore failing after 4 retries |

4xx responses are deliberately not logged: they are the client's problem and
would drown the log at volume. The `requestId` in the error body is the way to
trace one.

### Health checks

`GET /health` returns `{ ok: true }` without touching Firestore, so an uptime
check cannot generate reads. It proves the Worker is up, not that Firestore is —
for that, use an authenticated `GET /v1/sync/state`.

---

## 8. Runbook

### Ingest returning `409 conflict`

Two clients writing the same day concurrently. The server already retries three
times internally. Persistent conflicts mean two phones on one account syncing in
lockstep; stagger the background interval in `/v1/config`.

### Ingest returning `500` with "Firestore rejected the service-account credentials"

The service-account key is wrong, expired, or lacks `roles/datastore.user`.
Re-issue and `wrangler secret put FIREBASE_PRIVATE_KEY`. Note the isolate caches
the signing key, so a fresh deploy is the fastest way to force a reload.

### All requests returning `401`

Check `FIREBASE_PROJECT_ID` against the project the app authenticates with. This
is the most likely symptom of the unresolved two-project issue (§2.5).

### Retention not running

`wrangler tail` for the `retention` line. If absent, confirm the cron trigger is
deployed (`wrangler deployments list`). If present but `usersScanned: 0`, the KV
cursor may be stale — delete it:

```bash
npx wrangler kv key delete --binding CACHE "retention:cursor:v1"
```

### A user reports missing data

1. `GET /v1/sync/manifest?from=&to=` as that user — does the server have the day?
2. If yes, the read path or the client's cache is at fault.
3. If no, the upload never landed. Check the client's dead-letter rows.
4. If the day is older than `RETENTION_RAW_DAYS`, raw detail is gone by design —
   hourly and daily aggregates remain.

### Suspected duplicate or double-counted data

`inserted + merged + skipped` must equal `accepted` on every ingest response. If
daily totals look doubled, the likely cause is the client sending `readSportStep`
cumulative totals as `steps` samples instead of as `counters` — see
[06-FLUTTER-INTEGRATION.md](06-FLUTTER-INTEGRATION.md) §"Steps need care".

---

## 9. Security

| Control | Where |
|---|---|
| Identity | Firebase ID token, RS256, verified against Google's JWK set |
| Authorisation | `uid` from the verified token only; never from a path or body |
| Transport | HTTPS end to end |
| Firestore credentials | Worker secrets only; no client ever holds one |
| CORS | Explicit allow-list, never `*` (health data + bearer tokens) |
| Path injection | Every user-supplied path segment passes `assertSafePathSegment` |
| Payload bounds | Sample, day, series, event and segment caps on every endpoint |

**Not implemented:** rate limiting. A misbehaving client can only damage its own
data, but it can inflate the bill. A Durable Object per uid is the natural place
if it becomes necessary (see Open Questions in
[05-DECISIONS.md](05-DECISIONS.md)).

**Health data.** Every document under `users/{uid}` is personal health
information. Treat Workers logs accordingly — the code logs request ids and
error codes, never sample values or user identifiers. Keep it that way.

---

## 10. Account deletion — not implemented

There is no delete-account endpoint, deliberately. Doing it properly means:

1. Deleting `users/{uid}` and every subcollection (days, streams, months,
   nights, events, devices, receipts) — a recursive delete Firestore does not
   offer in one call.
2. Chunking it across cron runs, since a multi-year user has thousands of
   documents.
3. Deleting the Firebase Auth user.
4. Retaining an audit record that deletion occurred, without retaining the data.

Shipping half of that is worse than shipping none: a partial delete leaves
orphaned health data with no owner and no way to find it. Build it as one
deliberate piece of work before any public launch — most privacy regimes require
it, and users will ask.

---

## 11. Backup

Firestore's managed export writes to Cloud Storage:

```bash
gcloud firestore export gs://hypr-8064c-backups/$(date +%Y%m%d) \
  --collection-ids=users
```

Worth scheduling weekly. The daily and monthly rollup tiers are the irreplaceable
part — raw blocks expire anyway, but a lost month document is a permanent hole in
a user's lifetime trend.

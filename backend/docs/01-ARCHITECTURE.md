# Architecture

## What this service is

The durable home for everything the Pulse Hypr band measures, and the only query
surface the phone and the future web dashboard use.

It exists because the band's own memory is tiny and the app's is nonexistent.
The KR96 PRO retains about three days of history (`watchDataDay`), and the
Flutter app keeps metrics only in RAM on `BandController` — a force-stop erases
everything. **This backend is the archive.** That framing drives most of the
design: ingest durability and idempotency matter more than write latency,
because nothing else in the system remembers.

## System shape

```
┌────────────────────────────────────────────────────────────────────────┐
│  Band (Veepoo KR96 PRO)                                                │
│  Records automatically every ~5 min. Retains ~3 days.                  │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ BLE — history sync, serialised, 6 stages
┌───────────────────────────▼────────────────────────────────────────────┐
│  Flutter app                                                           │
│  ├─ Native bridge (BandConnectionManager.kt)  device-timestamped samples│
│  ├─ Local sample store  ← MUST EXIST FIRST (docs/fixes/02)             │
│  │     offline dashboard + upload queue, one store                     │
│  └─ Sync engine  batches, retries, obeys server config                 │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ HTTPS + Firebase ID token
┌───────────────────────────▼────────────────────────────────────────────┐
│  This Worker — Hono on Cloudflare                                      │
│  ├─ auth/       verify ID token (Web Crypto, JWKS cached in KV)        │
│  ├─ routes/     ingest · sync · metrics · sleep · profile · devices    │
│  ├─ domain/     registry · blocks · rollups · retention                │
│  └─ firestore/  REST client, service-account token cached in KV        │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ Firestore REST
┌───────────────────────────▼────────────────────────────────────────────┐
│  Firestore (project hypr-8064c)                                        │
│  users/{uid}/days/{date}/streams/{stream}   raw 5-min frames    90 d   │
│  users/{uid}/days/{date}                    daily + hourly     ∞ / 2 y │
│  users/{uid}/months/{YYYY-MM}               per-day frames        ∞    │
│  users/{uid}/nights · devices · events · receipts                      │
└────────────────────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTPS + Firebase ID token (same API)
┌───────────────────────────┴────────────────────────────────────────────┐
│  Web dashboard (not built) — Google sign-in, reads this API only       │
└────────────────────────────────────────────────────────────────────────┘
```

## Layers

Dependencies point strictly downward. Nothing in `domain/` knows about HTTP;
nothing above `firestore/` knows Firestore's `Value` encoding exists.

| Layer | Responsibility |
|---|---|
| [`routes/`](../src/routes) | HTTP shape: parse query and body, call domain, serialise JSON |
| [`domain/`](../src/domain) | What a metric *is*: the registry, slot merge, aggregation, retention |
| [`firestore/`](../src/firestore) | Paths, `Value` encoding, REST transport, access tokens |
| [`auth/`](../src/auth) | Firebase ID token verification and the `uid` on the context |
| [`lib/`](../src/lib) | Frame codec, day/slot arithmetic, errors, validators |

The registry ([`src/domain/registry.ts`](../src/domain/registry.ts)) is the
single source of truth for what exists. Adding a metric is one entry there —
storage, aggregation, validation, retention and the `/ingest/schema` contract all
follow from it.

## Write path

```
POST /v1/ingest
  │
  ├─ verify ID token ──────────────────► uid
  ├─ parse + validate batch             clamp out-of-range, drop bad points,
  │                                     bucket by (local date, stream, slot)
  ├─ receipt check on batchId ─────────► replay? return stored result, stop
  │
  └─ per local day, chronologically:
       ├─ batchGet  day doc + touched stream blocks     (1 round-trip)
       ├─ merge slots in memory                         (source precedence)
       ├─ recompute daily + hourly aggregates
       └─ commit  blocks + day doc atomically           (precondition on updateTime)
     then:
       ├─ commit sleep sessions and events
       ├─ update month frames                           (per month, retried)
       ├─ update device watermarks
       └─ write receipt (TTL 7 days)
```

Three properties are load-bearing:

- **Idempotent** at batch level (receipts) and slot level (position + value
  equality). The band re-serves its whole window on every sync, so duplicate
  arrival is the normal case.
- **Atomic per day.** Every write for one day is one commit, so a rollup can
  never describe a block that failed.
- **Bounded.** ≤62 days and ≤20,000 samples per request. A phone draining a long
  backlog is paced across requests instead of timing out on one.

## Read path

Resolution maps one-to-one onto a storage tier. A request never fans out across
tiers, so cost is predictable from the parameters alone.

| Endpoint | Reads | Docs per request |
|---|---|---|
| `/metrics/series?resolution=raw` | stream blocks | ≤ 31 × streams |
| `/metrics/series?resolution=hour` | day docs | ≤ 92 |
| `/metrics/series?resolution=day` | month docs | ≤ 36 |
| `/metrics/day/:date` | one day doc | 1 |
| `/metrics/latest` | recent day docs | ≤ 30 |
| `/sync/manifest` | day docs | ≤ 62 |
| `/sleep` | night docs | ≤ 92 |

Every endpoint enforces its cap and returns a `400` explaining which resolution
to use instead, rather than silently doing 365 reads.

## Storage tiers

| Tier | Resolution | Location | Retained | ≈ size/user |
|---|---|---|---|---|
| raw | 5 min | `days/{date}/streams/{stream}` | 90 days | 15 KB/day → 1.4 MB |
| hourly | 1 hour | `h` field on `days/{date}` | 730 days | 8 KB/day → 6 MB |
| daily | 1 day | `months/{YYYY-MM}` | forever | ~6 KB/month |

A daily cron sweep enforces the first two. It deletes only the `streams`
subcollection — never a day document — and uses a per-user watermark so each
expired day is examined once, ever.

## What runs where

| Concern | Where | Why |
|---|---|---|
| Identity | Firebase Auth | Already in the app |
| Token verification | Worker, Web Crypto | `firebase-admin` cannot run on Workers (ADR-003) |
| Storage | Firestore | Stated requirement; managed, no ops |
| Aggregation | Worker, at ingest | Reads must never scan raw data |
| Retention | Worker cron | Resumable across runs |
| Access control | Worker middleware | `uid` from the verified token only (ADR-001) |

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Expired ID token mid-backlog | `401 token_expired` — distinct code; client refreshes and retries the same batch |
| Concurrent write to one day | precondition fails → reload and reapply, 3 attempts → `409 conflict` (retryable) |
| Firestore 429 / 5xx | 4 attempts, exponential backoff with jitter, then `502 upstream_error` |
| One implausible sample | clamped and flagged, or listed in `rejected[]`; batch still succeeds |
| Request fails partway | days are processed in date order, so the committed prefix is contiguous and the manifest shows exactly what is missing |
| Retention run dies mid-sweep | deletions already committed, watermarks recorded; next run resumes |

Every error body carries a stable `code` and a `retryable` boolean, because a
client that retries an unretryable batch forever is the exact battery drain this
service exists to prevent.

## The Flutter prerequisite

**This backend cannot be integrated until the app has a local sample store.**
Today `BandController` holds only the newest value per metric; there is no
history to batch and nothing survives a restart. That work is already specified
in the app repo as `docs/fixes/02-local-sample-persistence.md`, and its schema
(band id, metric, value, device timestamp, receipt timestamp, source) is
deliberately the same shape this API ingests.

Build it once and it serves both purposes: the offline dashboard and the upload
queue. [06-FLUTTER-INTEGRATION.md](06-FLUTTER-INTEGRATION.md) has the details.

## Deliberately not here

- **Realtime push.** No Firestore listeners (ADR-001) and no WebSocket. Band
  data updates every five minutes; polling is honest and cheaper.
- **Waveforms.** `ppgs`/`ecgs` are hundreds of samples per second and belong in
  R2 blobs, not a time-series schema (ADR-019).
- **Cross-user analytics.** No collection-group queries, no aggregate reporting.
  Every query is scoped to one `uid`.
- **Account deletion.** Needs a deliberate, audited flow — see
  [07-OPERATIONS.md](07-OPERATIONS.md).

# Pulse Hypr Backend

Metrics ingest and reporting API for the Pulse Hypr fitness band.
**Hono on Cloudflare Workers · Firestore storage · Firebase Auth identity.**

📖 **[Documentation index](docs/00-INDEX.md)** — start there.

---

## Quick start

```bash
npm install

npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
# paste the ids into wrangler.toml

npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY

npm run typecheck && npm test
npm run dev            # http://localhost:8787
npx wrangler deploy
```

Full setup, including the required Firestore TTL policy:
[docs/07-OPERATIONS.md](docs/07-OPERATIONS.md).

---

## Why it exists

The band retains ~3 days of history. The Flutter app keeps only the newest value
per metric, in RAM — a force-stop erases everything. **This backend is the
archive**; nothing else in the system remembers.

Roughly 3,500 readings arrive per user per day across 16 streams. Storing one
document per reading would cost ~$1,000/month at 1,000 users. Instead, one
document per `(user, local day, stream)` holds the whole day as a packed binary
frame: **~20 writes per user per day, ~$6/month at the same scale**, and writes
are idempotent by slot position — which is also what deduplicates the band's
overlapping history reads.

---

## Endpoints

```
POST   /v1/ingest                 batch upload, idempotent on batchId
GET    /v1/ingest/schema          live metric registry

GET    /v1/sync/state             per-stream watermarks + deployment limits
GET    /v1/sync/manifest          per-day coverage, for gap detection

GET    /v1/metrics/series         charts — resolution=raw|hour|day
GET    /v1/metrics/day/:date      one day, fully summarised
GET    /v1/metrics/latest         newest value per stream, with measuredAt

GET    /v1/sleep                  nights with stage segments
GET    /v1/sleep/:date

GET    /v1/profile                body profile, goals, units
PUT    /v1/profile
GET    /v1/config                 server-driven sync policy + feature flags

GET    /v1/devices                paired bands, capabilities, watermarks
PUT    /v1/devices/:deviceId
DELETE /v1/devices/:deviceId      unpairs; measurements are kept

GET    /health                    liveness, touches no storage
```

Contract: [docs/03-API.md](docs/03-API.md).

---

## Layout

```
src/
├── index.ts          Hono app, middleware, error envelope, cron handler
├── env.ts            bindings and request context types
├── auth/             Firebase ID token verification (Web Crypto, JWKS in KV)
├── firestore/        REST client, service-account tokens, Value codec, paths
├── domain/           registry · blocks · rollups · ingest · sleep · retention
├── routes/           one file per resource
└── lib/              frame codec · day/slot arithmetic · errors · validators
test/                 frame codec, time arithmetic, merge policy and aggregation
docs/                 architecture, data model, API, sync, decisions, ops
```

[`src/domain/registry.ts`](src/domain/registry.ts) is the single source of truth
for what exists. Adding a metric is one entry there — storage, aggregation,
validation, retention and the published schema all follow.

One runtime dependency: `hono`.

---

## Before this is useful

**The Flutter app needs a local sample store first.** Today every 5-minute sample
is collapsed into a "latest value" field and discarded, so there is no history to
batch. That work is already specified in the app repo as
`docs/fixes/02-local-sample-persistence.md`, and its schema is deliberately the
shape this API ingests — build it once and it serves both the offline dashboard
and the upload queue.

**Two Firebase projects are in play.** `flutter/firebase.json` declares
`hypr-8064c` for Android and Dart, `pulse-hypr` for iOS. ID tokens are
project-scoped, so iOS cannot authenticate here until they are consolidated.

Details: [docs/06-FLUTTER-INTEGRATION.md](docs/06-FLUTTER-INTEGRATION.md).

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Local Worker against real Firestore |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — codec, time arithmetic, merge policy, aggregation |
| `npm run deploy` | `wrangler deploy` |

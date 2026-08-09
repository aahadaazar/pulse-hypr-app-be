# Pulse Hypr Backend — Documentation

Metrics ingest and reporting API for the Pulse Hypr fitness band.
Hono on Cloudflare Workers, Firestore for storage, Firebase Auth for identity.

## Read in this order

| # | Document | For |
|---|---|---|
| [01](01-ARCHITECTURE.md) | **Architecture** | System shape, layers, write and read paths, failure behaviour |
| [02](02-DATA-MODEL.md) | **Data Model** | Firestore layout, packed frame format, metric registry, sizing |
| [03](03-API.md) | **API Reference** | Every endpoint, request and response shape, error codes |
| [04](04-SYNC-PROTOCOL.md) | **Sync Protocol** | How the phone decides what to upload; battery and memory budget |
| [05](05-DECISIONS.md) | **Decision Record** | Every architectural decision with its reasoning and rejected alternatives |
| [06](06-FLUTTER-INTEGRATION.md) | **Flutter Integration** | What the app must build, and how its existing pieces map on |
| [07](07-OPERATIONS.md) | **Operations** | Setup, deploy, cost model, monitoring, runbook |

## Shortcuts

**Setting it up for the first time** → [07 §1–3](07-OPERATIONS.md)
**Wiring the app to it** → [06](06-FLUTTER-INTEGRATION.md), then [03](03-API.md)
**Adding a metric** → [02 §9](02-DATA-MODEL.md), then one entry in [`src/domain/registry.ts`](../src/domain/registry.ts)
**Wondering why something is the way it is** → [05](05-DECISIONS.md)

---

## The shape of it, in one page

The band records automatically every ~5 minutes and retains about three days.
The Flutter app currently keeps only the newest value per metric, in RAM. So:

> **This backend is the archive.** Nothing else in the system remembers.

That framing drives the design. Ingest durability and idempotency matter more
than write latency, because there is no second copy.

### Storage in three tiers

| Tier | Resolution | Where | Kept |
|---|---|---|---|
| raw | 5 min, 288-slot packed frame | `users/{uid}/days/{date}/streams/{stream}` | 90 days |
| hourly | 1 hour, 24-slot frame | field on `users/{uid}/days/{date}` | 730 days |
| daily | 1 day, 31-slot frame | `users/{uid}/months/{YYYY-MM}` | forever |

`?resolution=` on the read API selects a tier directly. A request never fans out
across tiers, so its cost is predictable from its parameters.

### The number that shaped everything

~3,500 readings per user per day across 16 streams.

| | doc-per-sample | packed day blocks |
|---|---|---|
| Firestore writes/user/day | ~3,500 | ~20 |
| Reads to chart 30 days | ~105,000 | 30 |
| Cost at 1,000 users | ~$1,000/mo | ~$6/mo |

One document per `(user, local day, stream)` holding the whole day as a binary
frame. Idempotent by slot position, which also solves deduplication — and the
band re-serves its entire retained window on every sync, so duplicates are the
normal case, not an edge case.

### Four decisions taken by the project owner (2026-08-09)

1. **All reads go through this API** — Firebase is auth plus storage; no client
   touches Firestore ([ADR-001](05-DECISIONS.md#adr-001--all-client-reads-go-through-this-api-firebase-is-auth-plus-storage))
2. **Packed day blocks** over doc-per-sample ([ADR-002](05-DECISIONS.md#adr-002--raw-samples-are-stored-as-packed-day-blocks-not-one-document-per-sample))
3. **Model everything the SDK already delivers**, not just today's tiles ([ADR-004](05-DECISIONS.md#adr-004--the-schema-models-every-field-the-sdk-already-delivers-not-just-what-the-app-shows))
4. **Tiered retention**: raw 90 d → hourly 2 y → daily forever ([ADR-009](05-DECISIONS.md#adr-009--retention-tiers-raw-90-days-hourly-2-years-daily-forever))

---

## Before this is useful

Two things are blocking, both in the Flutter project:

1. **The app has no local sample store.** Every 5-minute sample is collapsed into
   a single "latest value" field and discarded. There is nothing to batch. This
   is already specified as `docs/fixes/02-local-sample-persistence.md`, and its
   schema is deliberately the shape this API ingests — build it once and it
   serves both the offline dashboard and the upload queue.
   ([06](06-FLUTTER-INTEGRATION.md))

2. **Two Firebase projects are in play.** `firebase.json` declares `hypr-8064c`
   for Android and Dart, `pulse-hypr` for iOS. ID tokens are project-scoped, so
   iOS cannot authenticate here until they are consolidated.
   ([ADR-020](05-DECISIONS.md#adr-020--the-two-firebase-projects-must-be-consolidated-before-ios-ships), [07 §2.5](07-OPERATIONS.md))

---

## Status

Implemented and tested: ingest, sync state and manifest, metrics at all three
resolutions, sleep, profile, config, devices, retention sweep.

Deliberately deferred, with reasoning in
[ADR-019](05-DECISIONS.md#adr-019--deferred-workouts-ecg-waveforms-derived-scores-food-logging):
workout sessions, ECG and PPG waveforms, derived readiness scores, food logging,
account deletion, rate limiting.

No Flutter code has been written — [06](06-FLUTTER-INTEGRATION.md) is the
specification for that work.

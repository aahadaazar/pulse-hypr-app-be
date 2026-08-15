# Build Phases

The execution roadmap: what to build, in what order, and how to know each
phase is actually done. This is the document to read to answer "what should I
work on right now."

**Companion documents:**
- [`DATA-AND-APP-FLOW.md`](DATA-AND-APP-FLOW.md) — architecture and the
  current status of every component. Explains *why* the phases below are
  ordered this way.
- [`SETUP-AND-WIRING.md`](SETUP-AND-WIRING.md) — repo, secrets, and backend
  provisioning. Phase 0 below is a pointer into that document, not a
  duplicate of it.

---

## How to use this document

1. **Find the active phase.** Read top to bottom; the active phase is the
   first one whose exit criteria are not yet all met.
2. **Check entry criteria before starting work in a phase.** If they are not
   met, the dependency they name is the actual next task, even if it belongs
   to an earlier phase on paper.
3. **Hardware-gated items and the backlog are exceptions.** They are not part
   of the phase sequence — pull them in opportunistically whenever the
   precondition they need (a specific device, a specific band state) is
   available, regardless of which phase is otherwise active.
4. **Update the `Status` line as you go.** This document is a working
   tracker, not a static plan — when a phase's exit criteria are met, mark it
   `Done` and move on. A stale status here is worse than no status.

Every task links to its full write-up — the fix documents in
`flutter/docs/fixes/` or the ADR/design docs in `backend/docs/`. This document
only adds grouping, ordering, and the *why* for anything that was reordered
from those sources.

---

## Phase 0 — Foundation

**Status:** In progress — 0.1–0.3 done; only 0.4 remains, waiting on a
specific collaborator to onboard.
**Goal:** Make the project shareable and give the app a backend to talk to.
**Entry criteria:** None — this is where everything starts.

### Tasks

Full detail lives in [`SETUP-AND-WIRING.md`](SETUP-AND-WIRING.md) Steps 1–3
and [`ONBOARDING.md`](ONBOARDING.md); this phase does not duplicate them.

| # | Task | Where | Status |
|---|---|---|---|
| 0.1 | Root repo created, `backend/` and `docs/` pushed | [Step 1](SETUP-AND-WIRING.md#step-1--put-the-backend-under-version-control) | Done |
| 0.2 | Secrets encrypted with dotenvx | [Step 2](SETUP-AND-WIRING.md#step-2--credentials-without-emailing-env-files) | Done |
| 0.3 | Firebase + Cloudflare provisioned, Worker deployed, TTL policy active | [Step 3](SETUP-AND-WIRING.md#step-3--provision-the-backend) | Done |
| 0.4 | Collaborator has console access, Flutter toolchain running, SHA-1 registered | [`ONBOARDING.md`](ONBOARDING.md) | Not started — no collaborator identified yet |

### Notes

**Credential model changed mid-phase** — collaborators now get Editor/member
access on the owner's real Firebase and Cloudflare projects instead of
minting their own dev-tier project, per
[ADR-021](../backend/docs/05-DECISIONS.md#adr-021--collaborators-share-the-owners-project-they-dont-mint-their-own).
`ONBOARDING.md` reflects this; it replaces what was originally planned as
inline "Collaborator onboarding" content in `SETUP-AND-WIRING.md`.

**The Firestore TTL policy on `receipts` was briefly blocked**, not by IAM
but by billing: setting it (via console or `gcloud firestore fields ttls
update`) failed with `PERMISSION_DENIED: Project hypr-8064c has billing
disabled`, even though the account held Owner-level IAM — a billing-plan
gate, not a permissions issue. Resolved by linking Blaze billing to
`hypr-8064c`; a $10/month budget alert (50/90/100% thresholds, notification
only, not an enforced cap) was set alongside it as a tripwire. TTL is now
`ACTIVE` on `receipts`/`expiresAt`.

### Exit criteria

- The smoke test in Step 3.3 passes, **including the duplicate-batch
  assertion** (`duplicate: true` on replay — `inserted`/`accepted` mirror the
  original call's stored receipt rather than resetting to 0; see `ingest.ts`).
  ✅ Done.
- Firestore TTL policy on `receipts`/`expiresAt` is active. ✅ Done.
- Collaborator has cloned both repos, has a working dev build signed in on a
  device, and has decrypted a working `.dev.vars`. ⏳ Waiting on 0.4.

---

## Phase 1 — Core Android Reliability

**Status:** Not started
**Goal:** Make on-device data trustworthy and durable before anything leaves
the phone. Nothing downstream is worth building on top of a dashboard that
still resets on every restart.
**Entry criteria:** Toolchain ready (0.4). Backend live (0.3) is required only
for the profile round-trip tasks (1.3, 1.4) — **fix 02 and the disconnect-state
fix (1.1, 1.2) have no backend dependency and can start immediately**, in
parallel with the rest of Phase 0. See
[Step 6](SETUP-AND-WIRING.md#step-6--splitting-the-work) for how to split this
across two developers.

**Implementation brief:** [`PHASE-1-CORE-ANDROID-RELIABILITY.md`](PHASE-1-CORE-ANDROID-RELIABILITY.md)
is a self-contained handoff for whoever implements this phase — verified
current-code state per task, exact scope boundaries (what's already correct
vs. what's actually broken), and a step-by-step checklist. It supersedes the
notes below wherever the two disagree; it was written after re-reading the
actual source, not just the original fix docs.

### Tasks

| # | Task | Source | Tier |
|---|---|---|---|
| 1.1 | **Local sample store** | [fix 02](../flutter/docs/fixes/02-local-sample-persistence.md) | P0 |
| 1.2 | **Honest disconnect state** *(rescoped — not auto-reconnect)* | [fix 01](../flutter/docs/fixes/01-android-auto-reconnect.md) | P0, small |
| 1.3 | **Profile → band (`syncPersonInfo`)** | [fix 06](../flutter/docs/fixes/06-sync-person-info.md) | P1, promoted |
| 1.4 | **Persist app settings + onboarding** | [fix 11](../flutter/docs/fixes/11-persist-app-settings-onboarding.md) | P2, promoted |

### Notes

**1.1 is the prerequisite for every phase below.** Today `BandController`
holds one nullable field per metric; a force-stop erases everything and there
is no history to batch. This is also, on its own, the single biggest UX win
available — see
[`DATA-AND-APP-FLOW.md` Hop 4](DATA-AND-APP-FLOW.md#hop-4--dart--local-store-missing).

**1.2 is deliberately not "add auto-reconnect."** The original fix 01
proposes wiring up an existing-but-dead backoff subsystem
(`scheduleReconnect`, `[2s,4s,8s,15s,30s]`) so the app silently retries after
any unexpected BLE drop. **That is a confirmed product decision not to
build** — the connection stays user-driven; after a drop, the user sees it and
taps to reconnect, same as an initial pairing. This re-confirms what
[`findings.md`](../flutter/docs/findings.md) already recorded as deliberate
scope (*"Intentionally omitted — automatic reconnect. The user must select a
discovered band."*), rather than reversing it.

What 1.2 *does* still fix, kept in scope as a correctness bug independent of
that question: the disconnect handler currently **mislabels** an unexpected
drop as if the user asked to disconnect
(`userRequestedDisconnect = true`, `setConnectionWanted(false)`), which can
show a stale connection state and wrongly clears the flag the user's *own*
next manual reconnect depends on. Fix: report the drop honestly
(`disconnected`, reason "link dropped") **without** calling
`scheduleReconnect`. One block in the disconnect handler, not the multi-file
subsystem the original fix describes — hence "P0, small."

*This also changes the scope of fix 12 in Phase 3 (3.4) — see that phase's
notes.*

**1.3 is promoted ahead of the sync engine (Phase 2), not merely ahead of
other P1s.** Onboarding collects height, weight and age and discards them, so
the band computes calories and distance from a factory-default profile. Today
that's a wrong number in a RAM field cleared on restart. Once Phase 2 is live,
the same wrong numbers get written into **permanent monthly rollups** — and
they're unrecoverable, because the *band* computed them from its own stored
profile, so no server-side recomputation can fix them after the fact. Every
day synced before this lands is a day of permanently wrong calorie/distance
history. It's also nearly free: the backend already stores the profile
(`GET/PUT /v1/profile`, `age` derived from `birthDate`), so the remaining work
is one SDK call after the handshake.

> **Do not enable Phase 2 (sync engine) before 1.3 ships.**

**1.4 is paired with 1.1**, not run separately as its original P2 ranking
suggested. You're already adding local persistence for 1.1, and the backend
gives onboarding data a durable home via `preferences` on the profile — which
directly unblocks 1.3 (fix 11's own text lists "the onboarding Calibrate data
has nowhere durable to go" as a consequence; that's now false). Doing them
together also removes the `startedSignedIn` workaround in
[`main.dart`](../flutter/lib/main.dart), which its own comment calls a trap.

### Exit criteria

- Force-stop and relaunch with Bluetooth off: every tile shows its last value
  with an honest timestamp; no sync pill claiming activity.
- The band computes calories/distance from the user's real profile, not
  defaults.
- Theme, accent, and onboarding completion survive a restart.
- An unexpected BLE drop is reported as `disconnected` with an honest reason;
  no silent auto-retry loop runs; a subsequent manual reconnect works.

---

## Phase 2 — Cloud Sync

**Status:** Not started
**Goal:** Data leaves the phone and survives reinstall — the actual reason
this backend exists.
**Entry criteria:** Phase 1 complete. Uploading before 1.3 lands writes wrong
calorie/distance data into permanent storage; uploading before 1.1 lands has
nothing to upload from.

**Implementation brief:** [`PHASE-2-CLOUD-SYNC.md`](PHASE-2-CLOUD-SYNC.md) is
a self-contained handoff for whoever implements this phase — exact API
contracts, the client architecture already specified in
`backend/docs/06-FLUTTER-INTEGRATION.md`, and a step-by-step checklist per
task, including the battery/memory rules from `backend/docs/04-SYNC-PROTOCOL.md`.

### Tasks

| # | Task | Source | Tier |
|---|---|---|---|
| 2.1 | Sync engine — upload path | [backend integration guide](../backend/docs/06-FLUTTER-INTEGRATION.md) | — |
| 2.2 | Hydrate dashboard from `/metrics/latest` | [backend integration guide](../backend/docs/06-FLUTTER-INTEGRATION.md) | — |
| 2.3 | Lifecycle-aware step polling | [fix 13](../flutter/docs/fixes/13-lifecycle-aware-steps-polling.md) | P2, bundled |

### Notes

**2.3 is bundled here**, not scheduled as a standalone later P2. The sync
engine is where battery policy actually gets decided — WorkManager
constraints, the battery floor from `/v1/config` — and a 5-second BLE poll
that keeps running with the screen off is the same power-budget conversation.
Do it while you're already in that code.

### Exit criteria

All of [Step 7.2](SETUP-AND-WIRING.md#72-full-pipeline-acceptance) in
`SETUP-AND-WIRING.md` passes, specifically:

- Airplane mode → record → back online: queued rows upload, no data lost.
- Replaying a `batchId` against the real deployed Worker (not just curl)
  returns `duplicate: true` and writes nothing.
- Sign out, reinstall, sign in: dashboard populates from `/v1/metrics/latest`
  before any BLE traffic.
- A day's step total matches the band's own display exactly (proves
  `counters` vs. five-minute-bucket handling is correct — see
  [`DATA-AND-APP-FLOW.md` Hop 5](DATA-AND-APP-FLOW.md#hop-5--local-store--backend-missing)
  for the trap this test catches).
- Step polling cadence drops when the app is backgrounded.

---

## Phase 3 — iOS Parity

**Status:** Not started
**Goal:** Unblock iOS auth and bring the iOS bridge to the same standard as
Android.
**Entry criteria:** Phase 1 complete (3.4 depends on 1.4's persisted settings;
3.2/3.3 reuse patterns proven on Android). **3.1 has no such dependency and
costs nothing — do it the moment anyone has ten minutes free, even before
Phase 1.** It is a Firebase console change, not code.

**Implementation brief:** [`PHASE-3-IOS-PARITY.md`](PHASE-3-IOS-PARITY.md) is
a self-contained handoff for whoever implements this phase — verified
current-code state per task (including the exact Firebase project/app-id
discrepancy behind 3.1), the fix-12 scope override spelled out in full for
3.5, and a step-by-step checklist per task.

### Tasks

| # | Task | Source | Tier |
|---|---|---|---|
| 3.1 | **Consolidate the two Firebase projects** | [ADR-020](../backend/docs/05-DECISIONS.md) | blocks 3.2–3.4 |
| 3.2 | iOS phantom fatal crashes | [fix 04](../flutter/docs/fixes/04-ios-phantom-fatal-crashes.md) | P0 |
| 3.3 | iOS history sync parity | [fix 05](../flutter/docs/fixes/05-ios-history-sync-parity.md) | P0 |
| 3.4 | iOS connection semantics | [fix 09](../flutter/docs/fixes/09-ios-connection-semantics.md) | P1, after 1.4 |
| 3.5 | **Contextual permission prompting only** *(rescoped — not auto-connect)* | [fix 12](../flutter/docs/fixes/12-auto-connect-and-permission-flow.md) | P2 |

### Notes

**3.1 blocks everything else in this phase.**
[`flutter/firebase.json`](../flutter/firebase.json) currently names
`hypr-8064c` for Android/Dart and `pulse-hypr` for iOS; ID tokens are
project-scoped, so iOS cannot authenticate against the backend at all until
this is resolved. Zero engineering risk, so there's no reason to sequence it
behind anything.

**3.5 is fix 12 with its Part A dropped**, for the same reason as 1.2: "on
launch, if a last band exists, connect to it silently" was written assuming
1.2's original auto-reconnect would land ("with Fix 01 landed, drops
self-heal... a normal cold start... still requires a manual tap" — that
premise no longer holds once 1.2 is scoped down). Part B — deleting the
launch-time `onCreate` permission dialog in favor of the existing contextual
`BluetoothSetup.prepareForScan` flow — is unrelated to auto-connect and
stays: prompting for Bluetooth permission before the user has touched
anything is a UX bug on its own, independent of connection policy.

*The fix documents themselves (`01-android-auto-reconnect.md` and
`12-auto-connect-and-permission-flow.md`) still describe the original,
superseded proposals. This document is the authoritative override for scope;
they remain accurate for the mechanics of the parts that are still in scope
(the disconnect-handler fix in 01, Part B in 12).*

### Exit criteria

- iOS builds authenticate successfully against the single consolidated
  project.
- iOS crash telemetry reflects real crashes only — no phantom fatals from
  unregistered event channels.
- iOS runs history sync instead of the live-measurement loop Android already
  removed.
- iOS connection states match Android's semantics; reconnecting to a known
  band works.
- Bluetooth permission is requested only when the user takes a
  Bluetooth-related action, on both platforms.

---

## Phase 4 — Reliability & Polish

**Status:** Not started
**Goal:** Make the daily experience trustworthy under real-world network and
BLE conditions — the gap between "works in the happy path" and "works on a
commute."
**Entry criteria:** Phase 2 complete. These tasks harden the sync pipeline
Phase 2 builds; there's nothing to harden before it exists.

### Tasks

| # | Task | Source | Tier |
|---|---|---|---|
| 4.1 | Capabilities race hardening | [fix 08](../flutter/docs/fixes/08-capabilities-race-hardening.md) | P1 |
| 4.2 | Scan lifecycle / stuck state | [fix 10](../flutter/docs/fixes/10-scan-lifecycle-stuck-state.md) | P1 |
| 4.3 | Sync-failure UX and tile states | [fix 14](../flutter/docs/fixes/14-sync-failure-ux-and-tile-states.md) | P2 |

### Exit criteria

- A just-connected device's capability read is race-free (no dropped
  SpO2/HRV support flags on a fresh handshake).
- The scan flow cannot get stuck in a state with no user-visible recovery.
- A failed sync shows an honest, actionable state on affected tiles instead
  of a blank or misleading one.

---

## Phase 5 — Data Depth

**Status:** Not started
**Goal:** Surface the metrics the band already sends but the app currently
throws away — pure value-add, no architecture risk.
**Entry criteria:** Phase 2 complete (the sync pipeline must exist to carry
new streams end to end).

### Tasks

| # | Task | Source |
|---|---|---|
| 5.1 | Forward dropped `OriginData3` fields (respiratory rate, sleep stages, blood glucose, cardiac load, apnea/hypoxia indices) | [`DATA-AND-APP-FLOW.md` Hop 3](DATA-AND-APP-FLOW.md#hop-3--native--dart-platform-channels) |

### Notes

No backend work required — every one of these streams is already modelled in
[the metric registry](../backend/docs/02-DATA-MODEL.md#3-metric-registry) and
accepted by `/v1/ingest`. This is Dart/Kotlin-only: stop discarding fields
that already arrive in `OriginData3` on every history sync.

### Exit criteria

- The new streams appear with real data via `/v1/metrics/*` for a connected
  band that supports them.

---

## Phase 6 — Web Dashboard

**Status:** Not started
**Goal:** Ship the frontend this backend was built for.
**Entry criteria:** Phase 2 complete, minimum. Phase 4 strongly recommended —
building the dashboard against an unhardened sync pipeline means the
dashboard becomes the first place users notice sync bugs.

### Tasks

Not yet planned in detail. Starting point:
[`backend/docs/03-API.md`](../backend/docs/03-API.md) for the full contract —
every endpoint the dashboard needs already exists and is documented. No
backend changes are expected to build a read-only dashboard; Google sign-in
producing a Firebase ID token is the only integration requirement.

### Exit criteria

- Dashboard shows the same data as the mobile app for a signed-in user, kept
  in sync via polling (no realtime infrastructure exists — see
  [ADR-001](../backend/docs/05-DECISIONS.md)).

---

## Hardware-gated (pull in whenever the precondition is available)

Not part of the phase sequence — these need a specific physical setup, not a
specific point in the roadmap. Whoever is holding the band should pull these
in opportunistically.

| # | Task | Source | Needs |
|---|---|---|---|
| H1 | Scan-path contradiction | [fix 03](../flutter/docs/fixes/03-scan-path-contradiction.md) | A Pixel 8 Pro, to reproduce the original crash |
| H2 | Auto-measure arming validation | [fix 07](../flutter/docs/fixes/07-complete-auto-measure-arming.md) | A **factory-reset** band — see below |
| H3 | Minor cleanups | [fix 15](../flutter/docs/fixes/15-minor-cleanups.md) | Nothing — fill-in work, anytime |

⚠️ **H2, and validating Phase 1/3's connection fixes generally, require a band
that has never connected to the vendor's GBand app.**
[`BLUETOOTH_SDK_BAND_CONNECTIVITY.md §8`](../flutter/docs/BLUETOOTH_SDK_BAND_CONNECTIVITY.md)
warns that GBand's automatic-measurement settings persist on the device, so
testing against a GBand-touched band proves nothing — see
[Step 7.1](SETUP-AND-WIRING.md#71-band-side-protocol) for the full validation
protocol.

---

## Out of scope for this roadmap

Recorded but deliberately not scheduled — see
[ADR-019](../backend/docs/05-DECISIONS.md#adr-019--deferred-workouts-ecg-waveforms-derived-scores-food-logging)
for the reasoning behind each: workout sessions with GPS, ECG/PPG waveforms,
server-computed readiness/recovery scores, food logging, account deletion,
rate limiting.

None of these block anything above. Add a phase for one only when there is a
concrete reason to build it — the backend's storage design already
anticipates most of them.

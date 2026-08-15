# Phase 4 Brief — Reliability & Polish

A self-contained handoff for whoever (human or agent) implements Phase 4. You
should not need this session's conversation history — everything you need to
start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-4--reliability--polish) first** for the
phase's goal, entry criteria, and how it fits the overall roadmap. This
document goes one level deeper: verified current-code state, exact scope
boundaries, and a per-task execution checklist.

**Verified against the flutter repo's working tree as it stood when this was
written** (last commit `61883b4`). At the time of writing, `PHASES.md` shows
Phase 1 as `Done` and Phase 2 as `In progress` — a `lib/src/sync/` directory
has appeared in the working tree (uncommitted), consistent with sync-engine
work being underway. None of that changes anything below: every citation in
this document was re-checked directly against the files on disk, not against
a stale commit or an assumption about phase status. If you're starting this
phase later, re-grep the specific line references before trusting them —
that's why they're here.

---

## Before you touch anything

1. **Confirm Phase 2 is actually done, not just "mostly."** This phase's
   goal is hardening the sync pipeline Phase 2 builds — there's nothing to
   harden against a pipeline that's still changing shape. Check
   [`PHASES.md`](PHASES.md#phase-2--cloud-sync)'s Phase 2 status and exit
   criteria before starting. If it still says `In progress`, that's the
   actual next task, not this phase.
2. **Read [`flutter/AGENTS.md`](../flutter/AGENTS.md) in full before editing
   `BandConnectionManager.kt`.** Tasks 4.1 and 4.2 both edit this file, but
   neither touches what AGENTS.md actually protects. The do-not-touch zone
   is exactly three things: `BluetoothService`'s in-process declaration, the
   `vpprotocol` SDK version floor (`2.3.77.15`+), and `beginConnect()`
   waiting for both the GATT-connect and notifications-ready callbacks
   before starting the password handshake. Capability-timeout logic (4.1)
   and scan-callback event plumbing (4.2) are different subsystems — read
   the document anyway so you recognize the boundary when you're working
   next to it.
3. **A live discrepancy exists between `AGENTS.md` and the actual code on
   the scan path — read this before starting Task 4.2.** `AGENTS.md`
   currently states scanning uses Android's native `BluetoothLeScanner`.
   The code does not: `BandConnectionManager.kt`'s `startScan()` still calls
   `vpManager.startScanDevice(...)` — the SDK path `AGENTS.md` describes as
   replaced. This is tracked separately as fix 03 / H1 (hardware-gated, not
   yet landed) — not something to fix as part of this phase, but something
   Task 4.2 must be built *against the code that exists*, not the document.
   See Task 4.2's own note.
4. **No backend changes are needed for any task below.** This phase is
   Dart/Kotlin-only (Android; iOS parity for 4.2 is optional and belongs
   with Phase 3, not blocking here). Do not modify anything under `backend/`.

---

## Order

```
4.1 Capabilities race hardening  ──────────┐
                                            ├─ 4.3's "unsupported" tile state
4.2 Scan lifecycle hardening  (parallel)    │  needs 4.1's capability payload;
                                            │  the rest of 4.3 doesn't.
4.3 Sync-failure UX  ── split into two:
      · stage-name translation + staleness   (ship anytime, no dependency)
      · "unsupported" tile state             (needs 4.1)
```

**4.1 and 4.2 have no dependency on each other** — different subsystems
(capability reads happen after authentication; scanning happens before
connection exists). Do them in either order or in parallel.

**4.3 is not one atomic task.** Fix 14 itself says steps 1–2 (stage-name
translation, staleness) are independent and can ship immediately; only the
general "unsupported" state (step 3) needs 4.1's capability payload to be
real rather than a stand-in.

---

## Task 4.1 — Capabilities race hardening

**Source:** [fix 08](../flutter/docs/fixes/08-capabilities-race-hardening.md) (full detail)

### Verified current state

`BandConnectionManager.kt`: `CAPABILITIES_TIMEOUT_MS = 3_000L`;
`capabilitiesReady` is set `false` on connect/disconnect and flipped `true`
exactly once per connection via `markCapabilitiesReady()` — either when the
device's function-support packet (0xA7) actually arrives, or when the 3s
timeout fires and the code proceeds on SDK defaults. **The code does not
currently distinguish which path unblocked it** — confirmed reading
`markCapabilitiesReady()` and its call sites.

No capability cache keyed by MAC exists. No capability payload is exposed to
Flutter — confirmed: neither `VeepooBandChannel.kt` nor
`veepoo_band_connection.dart` contains any reference to "capabilit[y/ies]".

The `ble_sync_state` / `ble_sync_failures` Crashlytics custom keys already
exist (`crash_diagnostics.dart`, `BandConnectionManager.kt`) — fix 08's own
note observes these can measure how often the late-0xA7 scenario actually
happens in the field, once a dedicated `capabilities` failure stage exists
to feed them a real signal.

### What to build

1. Track *which* path unblocked `capabilitiesReady` (packet arrived vs.
   timeout gave up) — a boolean alongside the existing flag.
2. When sync proceeds on defaults, **don't report `completed = true`.** Add
   a `capabilities` entry to the failed-stages signal (or a new
   `SyncOutcome` field) so Dart shows the retryable pill instead of a clean
   success that silently guessed.
3. Extend the wait specifically for the sync path (e.g., total 10s) while
   keeping the short 3s timeout for anything cosmetic. Allow a
   late-arriving 0xA7 to upgrade `capabilitiesReady` mid-connection — today
   it stays permanently true for the rest of the connection once the
   timeout fires once, which is the bug this step closes.
4. **Cache the last-known capability profile per MAC** (`SharedPreferences`,
   native side) as the fallback instead of SDK defaults when the packet is
   late. This converts the failure mode from "wrong protocol branch" to
   "yesterday's branch" — for fixed firmware, almost always correct.
5. **Emit a capabilities payload** (supported metrics, watch-day window,
   protocol version) to Flutter — a new event channel, or folded into the
   connection-state payload. This is what Task 4.3 consumes for its
   "unsupported" tile state.

### Files

`android/.../BandConnectionManager.kt` (timeout policy, `SyncOutcome`,
capability cache, emission) · `android/.../VeepooBandChannel.kt` (expose the
channel if one is added) · `lib/src/app/band_controller.dart` /
`lib/src/band/veepoo/veepoo_band_connection.dart` (consume the
provisional-sync signal — the existing failed-stages plumbing is reusable)

### Definition of done

- Artificially delaying/masking the 0xA7 packet in a dev build makes sync
  report incomplete (not a clean success); the pill offers retry; retrying
  after the packet arrives produces a full sync.
- Reconnecting to a known band with the packet masked uses the cached
  profile and reads the correct protocol branch (sample counts > 0).
- Normal connections are not slowed — the extended wait only triggers when
  the packet is genuinely late (it typically lands in milliseconds).

---

## Task 4.2 — Scan lifecycle / stuck state

**Source:** [fix 10](../flutter/docs/fixes/10-scan-lifecycle-stuck-state.md) (full detail)

### A note on scan backend — read before starting

Fix 10's own text says to "implement this fix against whichever scan backend
Fix 03 lands on." As of this writing, **fix 03 / H1 (hardware-gated) has not
landed** — see "Before you touch anything" #3 above. `BandConnectionManager.kt`'s
`startScan()` still calls `vpManager.startScanDevice(...)`, the SDK path,
not the native `BluetoothLeScanner` `AGENTS.md` describes. **Build this task
against the scan path that exists today.** If H1 lands later and migrates
scanning to native `BluetoothLeScanner`, this task's event plumbing will
need to be re-pointed at the new callback shape — but the Dart-facing
contract (`scanning`/`scanError` fields, the UI states built on them)
shouldn't need to change either way, since both backends report the same
kind of started/stopped/failed events.

### Verified current state

`BandConnectionManager.kt`'s `Listener` interface has exactly three members
— `onConnectionState`, `onScanResult`, `onMetric` — **no scan-status
member.** `onSearchStopped`/`onSearchCanceled` (the SDK's scan callbacks)
have log-only bodies with no listener call. On the Dart side,
`band_controller.dart`'s `scanning` flag is written `true` only by the
user-initiated toggle, and `false` only by user toggle, `connect`, or
`_teardown` — nothing clears it when the SDK's own scan window lapses or a
scan fails silently (`MainActivity.kt`'s own comment describes a swallowed
`SecurityException` on some permission-adjacent failures). `scanError`
already exists as a field and is already rendered in `dashboard_screen.dart`
— it's populated today only by connect failures, never by a scan-stop/fail
signal.

### What to build

1. Add a scan-state signal to the bridge: extend the `Listener` interface
   and channel layer with `started`/`stopped`/`failed(reason)`, emitted from
   `onSearchStarted`/`onSearchStopped`/`onSearchCanceled`.
2. Dart: clear `scanning` (and cancel `_scanSub`) when a `stopped`/`failed`
   event arrives; surface `failed` reasons through the existing `scanError`
   field the UI already renders.
3. Add a Dart-side scan timeout (~30s): on expiry, stop the scan through the
   normal path and show "No bands found — try again closer to your band"
   instead of an eternal "Scanning…". The empty-state copy should
   distinguish "scanning, nothing yet" from "scan finished, nothing found."
4. Decide explicitly whether a `stopped` event while Dart still wants to
   scan restarts the native scan or just reports it — either policy is
   fine, but make it a real decision rather than an emergent accident of
   SDK internals.

### Files

`android/.../BandConnectionManager.kt` (scan callbacks → listener events) ·
`android/.../VeepooBandChannel.kt` (channel plumbing) ·
`lib/src/band/veepoo/veepoo_band_connection.dart` (expose scan status) ·
`lib/src/app/band_controller.dart` (state clearing, timeout, error
surfacing) · `lib/src/screens/dashboard_screen.dart`,
`connected_devices_screen.dart` (empty-state copy split). iOS parity
(`ios/Runner/VeepooBandChannel.swift`, same contract) is optional here —
treat this task as Android-first and let Phase 3 mirror it later; don't
block on iOS.

### Definition of done

- Start a scan with the band powered off: within the timeout the UI lands
  on a clear "nothing found" state; the button reads "Scan again," not a
  perpetual spinner.
- Let the SDK's own scan window lapse: Dart state follows within a second.
- Revoke a permission mid-session (or simulate the swallowed
  `SecurityException`): the user sees an actionable error, not silence.

---

## Task 4.3 — Sync-failure UX and tile states

**Source:** [fix 14](../flutter/docs/fixes/14-sync-failure-ux-and-tile-states.md) (full detail)

### Two independent halves — sequence them separately

Steps 1–2 below (stage-name translation, staleness) have no dependency on
anything else in this phase and can ship immediately. Step 3 (the general
"unsupported" tile state) needs Task 4.1's real capability payload — a
stand-in using today's natively-read SpO₂/HRV flags covers only those two
metrics, not the general case. Don't block the first half on the second.

### Verified current state

`dashboard_screen.dart`'s tiles have exactly three states today: a value
with timestamp, `--` (one shared `_emptyLevel` helper used for every
metric's empty case, always labeled "No reading" regardless of cause), and
the global sync pill. The pill's failed-stage copy interpolates **raw
internal stage-name strings** directly — confirmed via
`BandConnectionManager.kt`'s six `runSyncStage(...)` call sites
(`"steps"`, `"battery"`, `"origin"`, `"SpO2 history"`, `"HRV history"`,
`"sleep"`) — these strings reach rendered UI text today (e.g. "Couldn't
finish syncing origin."). No staleness treatment exists anywhere — a
reading carries a timestamp but nothing dims it or switches to relative
time as it ages. No capability payload exists yet (confirms 4.1 is the real
gate for the unsupported-state half, not an optional nice-to-have).

### What to build — part 1 (ship independent of 4.1)

1. Translate stage names centrally in Dart before display ("origin" →
   "health history", "SpO2 history" → "blood oxygen", etc.) — or better,
   have the pill summarize generically ("Couldn't finish syncing — retry")
   and move per-metric failure detail onto the affected tiles instead of
   the shared pill.
2. Define per-metric staleness horizons — steps ~10 min while connected;
   HR/SpO₂/HRV ~30 min given the band's 5-minute recording cadence; sleep
   24h. Past the horizon, dim the value and switch the meta line to
   relative time. Target copy set (from `findings.md`): *"Measuring… /
   updated just now / Last measured 8 minutes ago / No measurement yet /
   Not supported by this band."*

### What to build — part 2 (needs Task 4.1)

3. Tiles whose metric the connected band cannot produce render "Not
   supported by this band" (stable, non-error styling) instead of `--`.
   Until 4.1 fully lands, this can be partially driven by the SpO₂/HRV
   support flags the sync already reads natively — but generalizing beyond
   those two needs 4.1's emitted profile.
4. Distinguish empty-complete from failed: a sync that completes with zero
   samples for a metric shows "No measurement yet," not the same `--` as a
   genuine failure. Tie the copy to the band's arming status where known
   (fix 07 / H2, hardware-gated) — "automatic recording just enabled — data
   appears after ~5 minutes" is both true and reassuring on a first-ever
   connect.

### Files

`lib/src/screens/dashboard_screen.dart` (`_SyncStatusPill`, `_MetricMeta`,
`_emptyLevel`, per-tile state logic) · `lib/src/app/band_controller.dart`
(staleness computation, capability/arming exposure) ·
`lib/src/band/veepoo/veepoo_band_connection.dart` (capability payload,
paired with 4.1)

### Definition of done

- No internal identifier ("origin", "SpO2 history") ever appears in
  rendered UI.
- Disconnect the band for an hour, reopen: values show with
  dimmed/relative-time stale treatment, not as fresh readings.
- On a band without SpO₂ support, the Blood O₂ tile reads "Not supported by
  this band" and never joins failed-stage messaging.
- First-ever connect on a fresh band shows the "data appears after…" hint
  rather than an error.

---

## Phase exit criteria (from `PHASES.md`, repeated here for convenience)

- A just-connected device's capability read is race-free (no dropped
  SpO₂/HRV support flags on a fresh handshake). (4.1)
- The scan flow cannot get stuck in a state with no user-visible recovery.
  (4.2)
- A failed sync shows an honest, actionable state on affected tiles instead
  of a blank or misleading one. (4.3)

When all three are true, update `PHASES.md`'s Phase 4 status to `Done`.

## What NOT to do in this phase

- Don't start until Phase 2's exit criteria actually pass — check
  `PHASES.md` for current status before assuming.
- Don't touch `AGENTS.md`'s three protected invariants (`BluetoothService`
  process, `vpprotocol` SDK floor, GATT+notifications-ready-before-password
  ordering) — none of this phase's tasks need to.
- Don't build Task 4.2 against the native-`BluetoothLeScanner` scan path
  `AGENTS.md` describes — the code still uses `vpManager.startScanDevice()`
  today. Build against reality, not the (currently inaccurate) document.
- Don't generalize 4.3's "unsupported" tile state beyond SpO₂/HRV without
  4.1's real capability payload landing first.
- Don't do backend work — nothing here needs it.

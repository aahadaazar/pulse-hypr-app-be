# Phase 1 Brief — Core Android Reliability

A self-contained handoff for whoever (human or agent) implements Phase 1. You
should not need this session's conversation history — everything you need to
start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-1--core-android-reliability) first** for
the phase's goal, entry criteria, and how it fits the overall roadmap. This
document goes one level deeper: verified current-code state, exact scope
boundaries, and a per-task execution checklist. Where the two disagree,
**this document is newer** — it was written after re-reading the actual
source files, not just the original fix-plan docs.

**Verified against the repo at commit `61883b4`** (flutter) — if `git log -1`
shows something newer, re-check the "Verified current state" note under each
task before trusting it.

---

## Before you touch anything

1. **Read [`flutter/AGENTS.md`](../flutter/AGENTS.md) in full.** It documents
   a do-not-touch zone around `BandConnectionManager.kt` and the
   `BluetoothService` manifest entry, encoding a reproduced device bug (not a
   style preference). None of the four tasks below require touching the
   things it protects (process isolation, SDK version, GATT-before-password
   handshake ordering) — but you will be editing the same file for 1.2 and
   1.3, so know the boundary before you start.
2. **The product decision that shapes 1.2 and 1.3 in Phase 3:** connection
   stays user-driven. After an unexpected BLE drop, the app does **not**
   silently retry — the user sees a disconnected state and taps to
   reconnect, same as an initial pairing. This was confirmed explicitly by
   the project owner (superseding fix 01's and fix 12's original proposals)
   and is recorded in
   [`flutter/docs/findings.md`](../flutter/docs/findings.md) as deliberate
   scope: *"Intentionally omitted — automatic reconnect. The user must
   select a discovered band."* **Do not wire up `scheduleReconnect` or any
   automatic-retry loop.** If you find yourself doing that, stop — you're
   implementing the superseded version of the fix.
3. **This is Android/Dart-only.** No backend changes are needed for any task
   below — 1.3 and 1.4 read/write endpoints that already exist and are
   deployed (`GET/PUT /v1/profile`). Do not modify anything under `backend/`.

---

## Order

**1.1 and 1.2 have no dependency on each other or on the backend — start
both immediately, in either order or in parallel** (they touch different
layers: 1.1 is mostly new Dart storage code, 1.2 is a small, isolated native
handler). **1.3 and 1.4 share a persisted-settings store**, so whichever you
implement first should leave room for the other; doing them together is
cheaper than sequencing them (see 1.4's notes for why one already partially
motivates the other).

```
1.1 Local sample store  ─┐
1.2 Honest disconnect    ├─ any order / parallel
1.3 Profile → band       ─┐
1.4 Persist settings      ├─ share a store; do together if possible
```

---

## Task 1.1 — Local sample store

**Source:** [`flutter/docs/fixes/02-local-sample-persistence.md`](../flutter/docs/fixes/02-local-sample-persistence.md) (fix 02, full detail — steps, evidence, files, risks)
**Tier:** P0 — this is the prerequisite for everything downstream, including Phase 2.

### Verified current state

- `pubspec.yaml` has no local-database dependency of any kind — only
  `shared_preferences` (used today for known-band storage, theme intent,
  etc.). Confirmed via `grep -iE "drift|sqflite|isar|hive" pubspec.yaml`:
  no match in the `dependencies:` block.
- `lib/src/app/band_controller.dart` holds every metric as a nullable field;
  `_teardown()` nulls all of them. A force-stop genuinely loses everything.

### What to build

1. Add a local database (`drift` recommended — typed queries, works on both
   platforms). One table: band MAC, metric type, value(s), device timestamp,
   receipt timestamp, source (`history`/`live`/`poll`). Unique index on
   `(band id, metric, device timestamp)` — history reads overlap by design
   and must dedupe by upsert, not by rejecting duplicates.
2. Upsert every reading as it arrives, in `BandController` or a thin
   repository between the platform stream and the controller. Device
   timestamps already flow end to end (`BandConnectionManager.emitAt`).
3. On `BandController` construction, hydrate current fields from the
   database *before* any Bluetooth traffic — the dashboard should open with
   last-known values and honest timestamps, not `--` placeholders. Keep the
   existing `_isNewest` guard so hydrated values yield to fresher live data.
4. Store per-metric sync cursors and extend the `syncHealthHistory` method
   channel call to accept a day-window hint (days-since-cursor, clamped to
   `1..watchDataDay`), threaded through the native `ReadOriginSetting` /
   `ReadSleepSetting` construction. **Verify the day-count parameter's exact
   semantics against the SDK demo sources before relying on it** — this
   project has already been burned once by an undocumented day-offset
   parameter (`findings.md` §9, "a day offset, not a number of days"). If
   this proves unreliable, ship persistence alone (steps 1–3) first; it
   delivers most of the user-facing value on its own.
5. Cap retention (e.g. 90 days per band) with a periodic delete.
6. Don't gate the sync pill on hydrated data — the pill should still reflect
   live Bluetooth activity; the tiles behind it are just no longer blank.

### Files

`pubspec.yaml` · new `lib/src/band/sample_store.dart` (or similar) ·
`lib/src/app/band_controller.dart` · `lib/src/band/veepoo/veepoo_band_connection.dart` ·
`android/.../BandConnectionManager.kt` · `android/.../VeepooBandChannel.kt`

### Definition of done

- Force-stop, relaunch with Bluetooth off: every tile shows its last value
  with an honest timestamp, no sync pill claiming activity.
- Pull-to-refresh after a short gap transfers visibly less data than a
  first-ever sync (log the day window) and completes faster.
- Two refreshes with the band idle produce stable row counts — no
  duplicates.
- A sync stage timing out no longer empties or blocks a tile that already
  has stored data.

---

## Task 1.2 — Honest disconnect state (rescoped)

**Source:** [`flutter/docs/fixes/01-android-auto-reconnect.md`](../flutter/docs/fixes/01-android-auto-reconnect.md) (fix 01 — **read the scope override below first; the doc itself still describes the original, superseded proposal**)
**Tier:** P0, small — this should be a narrow, low-risk change.

### Verified current state (this is more precise than PHASES.md's summary — re-read this before starting)

`BandConnectionManager.kt`'s disconnect handler (around line 346, function
`connectStatusListener`) currently does this on an **unexpected** drop
(`userRequestedDisconnect == false` at the time of the drop):

```kotlin
} else {
    // Connections are user-initiated. Do not reconnect merely because a previously
    // selected band becomes visible again.
    userRequestedDisconnect = true
    setConnectionWanted(false)
    emitConnectionState(STATE_DISCONNECTED, "link dropped")
    BandConnectionService.stop(appContext)
}
```

Two things are **already correct** and need no change:
- It emits reason `"link dropped"`, not a generic/misleading string — the
  state is already reported honestly at the emission-string level.
- `scheduleReconnect` is **not** called. The dead backoff subsystem
  (`RECONNECT_DELAYS_MS`, `reconnectAttempt`, `cancelPendingReconnect`,
  lines ~699–723) stays dead. **Leave it alone.**

One thing is a **real, narrower bug** than the original fix-01 doc describes:
`setConnectionWanted(false)` is called on *any* disconnect, including an
unexpected one the user hasn't reacted to yet. `isConnectionWanted()`
(line 261) is read by `restoreRequestedConnection()`, which runs at manager
init and re-establishes a connection the user still wanted if the **process**
restarts (e.g. the OS kills a backgrounded app) — this is existing,
pre-existing behavior, distinct from the rejected "auto-retry after every
drop" proposal, and it appears intentional (see its own doc comment at
line ~271: *"a debug-session disconnect can terminate the Flutter process
while the user still expects their selected band to stay connected"*).

The bug: because an unexpected drop clears `connectionWanted` immediately,
if the process happens to restart in the window between the drop and the
user's next manual tap, `restoreRequestedConnection()` will **not** attempt
to resume — even though the user never explicitly disconnected. Their intent
was overwritten by a drop they haven't even necessarily noticed yet.

### Open question — confirm before implementing

Should `connectionWanted` stay `true` across an *unexpected* drop (cleared
only by an explicit user-initiated disconnect via `connect()`'s counterpart
or a real disconnect action), so that `restoreRequestedConnection()` can
still resume on a process restart even though no in-process auto-retry
happens? **Recommended: yes** — this doesn't reintroduce silent auto-retry
(nothing changes for a live process; `scheduleReconnect` still isn't
called), it only affects what happens if the process is killed before the
user gets a chance to tap reconnect, which is arguably still "the
connection the user wanted" rather than a fresh auto-connect decision. This
reasoning wasn't part of the original scope conversation, though, so a
one-line confirmation with the project owner before shipping is cheap
insurance against re-litigating the auto-reconnect decision by accident.

### What to build

1. In the disconnect handler, on an unexpected drop: keep emitting
   `STATE_DISCONNECTED, "link dropped"` (already correct). Change
   `setConnectionWanted(false)` to **not** run on this path — only on an
   explicit user-initiated disconnect. Confirm exactly where "explicit
   disconnect" is triggered from (search for the Dart-side disconnect call
   into this manager) and make sure *that* path still clears the wanted
   flag correctly.
2. Do **not** touch `scheduleReconnect`, the backoff delay table, or call
   it from anywhere. Do **not** add any timer-based retry.
3. Verify `restoreRequestedConnection()`'s behavior after this change with a
   real device: kill the process (not just background it) shortly after an
   unexpected drop, relaunch, and confirm it attempts to resume — versus an
   explicit disconnect, relaunch, which must **not** resume.

### Files

`android/app/src/main/kotlin/com/pulsehypr/pulse_hypr/BandConnectionManager.kt` only.

### Definition of done

- An unexpected BLE drop shows `disconnected` with reason `"link dropped"`;
  no retry loop runs; a subsequent manual reconnect works normally.
- Explicit user disconnect still disconnects and stays disconnected,
  including across an app restart.
- Killing the process shortly after an *unexpected* drop and relaunching
  resumes the connection attempt (per the recommendation above, pending
  confirmation). Killing the process after an *explicit* disconnect does
  not.
- `scheduleReconnect` remains uncalled — grep the diff for it; it should not
  appear.

---

## Task 1.3 — Profile → band (`syncPersonInfo`)

**Source:** [`flutter/docs/fixes/06-sync-person-info.md`](../flutter/docs/fixes/06-sync-person-info.md) (fix 06, full detail)
**Tier:** P1, promoted ahead of Phase 2 — see below.

### Why this can't wait for Phase 2

Onboarding already collects height/weight/age and throws them away — the
band computes calories/distance from a factory-default profile today. That's
a wrong number in a field that resets on restart, currently. Once Phase 2's
sync engine is live, the same wrong numbers become **permanent monthly
rollups**, computed by the band itself from its own stored (wrong) profile —
no server-side recomputation can fix that after the fact. **Do not enable
Phase 2 before this ships.**

### Verified current state

Zero occurrences of `syncPersonInfo` or `PersonInfoData` anywhere in
`android/` or `lib/` (confirmed via repo-wide grep) — this SDK call has
never been wired up. `onboarding_screen.dart`'s `_height`/`_weight`/`_age`
are widget state read by nothing after `_finish()`.

### What to build

1. Persist height, weight, age, step goal (and decide: add a sex question to
   onboarding, or document a deliberate default — `PersonInfoData` requires
   it and onboarding doesn't currently ask). Store alongside Task 1.4's
   settings store if that lands first or simultaneously.
2. Bridge a `syncPersonInfo` method through the Veepoo method channel:
   Dart → `VPOperateManager.syncPersonInfo` with a `PersonInfoData` and an
   `IPersonInfoDataListener`. Reference: `docs/BLUETOOTH_SDK_BAND_CONNECTIVITY.md`
   §3 and the SDK demo sources.
3. Call it after each successful authentication (the `completeHandshake` →
   capabilities-ready sequence is the natural hook) and immediately when the
   user edits the profile while connected.
4. Run it before history sync starts, never concurrently — the SDK handles
   concurrent long operations poorly (`findings.md` finding 8).
5. Replace the dashboard's hardcoded `_stepsGoal = 10000` with the persisted
   goal.
6. The backend already has a home for this: `GET/PUT /v1/profile` (see
   [`backend/docs/06-FLUTTER-INTEGRATION.md`](../backend/docs/06-FLUTTER-INTEGRATION.md)).
   No backend work needed — it's live now.

### Files

`lib/src/screens/onboarding_screen.dart` · settings store (shared with 1.4) ·
`lib/src/band/veepoo/veepoo_band_connection.dart` ·
`android/.../VeepooBandChannel.kt` · `android/.../BandConnectionManager.kt` ·
`lib/src/screens/dashboard_screen.dart`

### Definition of done

- Two test profiles with substantially different height/weight produce
  different calorie/distance values for the same walk on the same band.
- Profile edits while connected reach the band without reconnecting.
- Dashboard goal percent uses the configured goal, not a hardcoded 10,000.
- Profile sync never overlaps a running history sync (check log ordering).

---

## Task 1.4 — Persist app settings + onboarding

**Source:** [`flutter/docs/fixes/11-persist-app-settings-onboarding.md`](../flutter/docs/fixes/11-persist-app-settings-onboarding.md) (fix 11, full detail)
**Tier:** P2, promoted — pair with 1.1/1.3, not scheduled separately.

### Verified current state

`lib/src/app/app_settings.dart` still carries the comment *"In-memory only
for now — resets on app restart until persistence is added."* — confirmed
unchanged. `lib/main.dart:39-40` still has the `startedSignedIn` workaround
(`final startedSignedIn = FirebaseAuth.instance.currentUser != null;`),
which its own surrounding comment calls a trap.

### What to build

1. Persist `themeMode`, `accent`, `onboardingComplete` via
   `shared_preferences` — mirror `lib/src/band/known_band_store.dart`'s
   existing pattern (load on construction, write on change).
2. Key `onboardingComplete` by Firebase UID (a different user signing in on
   the same device should see onboarding again); theme/accent stay
   device-level.
3. Remove the `startedSignedIn` workaround from `main.dart` once the
   persisted flag alone is sufficient to route correctly.
4. Decide the data-sharing toggles' fate together with Task 1.3: either
   persist and have them gate something real, or remove them — shipping
   toggles that silently do nothing erodes trust.
5. If Task 1.3 lands after this, add the profile fields to this same store.

### Files

`lib/src/app/app_settings.dart` (primary) · `lib/main.dart` ·
`lib/src/screens/onboarding_screen.dart` · pattern reference:
`lib/src/band/known_band_store.dart`

### Definition of done

- Set light theme + a non-default accent, force-stop, relaunch: choices
  intact, no dark-theme flash.
- Complete onboarding, sign out, sign back in as the same user, restart: no
  onboarding shown. Sign in as a different user: onboarding appears once.
- `startedSignedIn` no longer exists anywhere in the codebase (grep to
  confirm).

---

## Phase exit criteria (from `PHASES.md`, repeated here for convenience)

- Force-stop and relaunch with Bluetooth off: every tile shows its last
  value with an honest timestamp; no sync pill claiming activity. (1.1)
- The band computes calories/distance from the user's real profile, not
  defaults. (1.3)
- Theme, accent, and onboarding completion survive a restart. (1.4)
- An unexpected BLE drop is reported as `disconnected` with an honest
  reason; no silent auto-retry loop runs; a subsequent manual reconnect
  works. (1.2)

When all four are true, update `PHASES.md`'s Phase 1 status to `Done` and
move to Phase 2 — but not before Task 1.3 ships (see its "why this can't
wait" note above).

## What NOT to do in this phase

- Don't wire up `scheduleReconnect` or any automatic BLE retry loop.
- Don't touch anything inside `flutter/AGENTS.md`'s do-not-touch zone
  without re-reading it and testing on a physical device.
- Don't modify anything under `backend/` — nothing here needs backend
  changes.
- Don't start Phase 2 (sync engine) before Task 1.3 ships — see that task's
  "why this can't wait" note.
- Don't touch fix 03/07/15 (hardware-gated) or fix 04/05/09/12 (Phase 3,
  iOS) — out of scope for this phase.

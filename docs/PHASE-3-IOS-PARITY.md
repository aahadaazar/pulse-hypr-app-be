# Phase 3 Brief — iOS Parity

A self-contained handoff for whoever (human or agent) implements Phase 3. You
should not need this session's conversation history — everything you need to
start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-3--ios-parity) first** for the phase's
goal, entry criteria, and how it fits the overall roadmap. This document goes
one level deeper: verified current-code state, exact scope boundaries, and a
per-task execution checklist.

**Verified against the flutter repo's working tree as it stood when this was
written** (last commit `61883b4`). One caveat: at the time of writing, the
working tree also carried **~930 uncommitted lines across 13 files** that look
like in-progress Phase 1 work (`sample_store.dart` and changes to
`band_controller.dart`, `veepoo_band_connection.dart`,
`BandConnectionManager.kt`, `VeepooBandChannel.kt` (Android),
`onboarding_screen.dart`, `app_settings.dart`, `settings_screen.dart`, and
others). **None of the files this phase concerns were part of that diff** —
`ios/Runner/VeepooBandChannel.swift` and `android/.../MainActivity.kt` were
both untouched — so every "verified current state" note below holds
regardless of what happens to that other work. The one shared file this phase
also touches, `lib/src/app/band_controller.dart`, *was* part of that diff;
where this document cites it (Task 3.2, 3.3), the citation reflects the file
as it stood on disk, not just the last commit. If you're starting this phase
after that WIP has since been committed or changed further, re-grep the
specific line references below before trusting them — the citations exist so
you can re-verify cheaply, not so you can skip verifying.

---

## Before you touch anything

1. **Read [`flutter/AGENTS.md`](../flutter/AGENTS.md).** Its do-not-touch zone
   covers `BandConnectionManager.kt`'s process isolation, SDK version, and
   GATT-before-password handshake ordering. **Nothing in this phase modifies
   that file** — Tasks 3.3 and 3.4 reference it as a contract to mirror on
   iOS (payload shapes, stage watchdogs, handshake ordering), read-only. Know
   the boundary anyway before you're working nearby.
2. **The product decision that shapes Task 3.5:** same one already made for
   Phase 1's Task 1.2 — connection stays user-driven. Fix 12 (the source
   document for 3.5) describes two parts; **Part A, "auto-connect on launch,"
   is out of scope and superseded.** See Task 3.5's own scope-override section
   below before you start it — this is the part of this phase most likely to
   accidentally re-open a decision the project owner already made.
3. **No backend changes are needed for any task below.** This phase is
   Dart/Swift/Kotlin-only. Do not modify anything under `backend/`.
4. **This phase does not require Phase 1 to be complete**, except Task 3.5
   (needs 1.4's persisted-settings store). Task 3.1 has zero dependency on
   anything and costs nothing — see "Order" below for why it should happen
   immediately, independent of whatever else is in flight.

---

## Order

```
3.1 Consolidate Firebase projects        ← zero cost, unblocks iOS auth entirely — do first, anytime
        │
        ▼
3.2 Fix iOS phantom fatal crashes         ← prerequisite cleanup; land before 3.3/3.4 so their
        │                                    hardware sessions have readable telemetry
        ▼
3.3 iOS history sync parity  ─┐
3.4 iOS connection semantics  ├─ develop together — sync must only start once "authenticated"
        │                        is real, which is exactly what 3.4 makes true
        ▼
3.5 Contextual permission prompting only  ← Part B of fix 12 only; needs 1.4 from Phase 1
```

**3.1 blocks 3.2–3.4 in practice, not by hard dependency** — those tasks are
about the BLE bridge, not auth, but you cannot meaningfully test any of them
end-to-end (profile fetch, ingest, anything behind `requireAuth`) on iOS until
iOS ID tokens are accepted. Do 3.1 first regardless of what else is queued;
it's a console change with no engineering risk.

---

## Task 3.1 — Consolidate the two Firebase projects

**Source:** [ADR-020](../backend/docs/05-DECISIONS.md#adr-020--the-two-firebase-projects-must-be-consolidated-before-ios-ships)

### Verified current state

`flutter/firebase.json`, read directly:

```json
{"flutter":{"platforms":{
  "android": {"default": {"projectId": "hypr-8064c", "appId": "1:686248417794:android:..."}},
  "ios":     {"default": {"projectId": "pulse-hypr", "appId": "1:451329438541:ios:..."}},
  "dart":    {"lib/firebase_options.dart": {"projectId": "hypr-8064c",
               "configurations": {
                 "android": "1:686248417794:android:...",
                 "ios":     "1:686248417794:ios:bc147ff6e09a552316a51b"
               }}}
}}}
```

Two things worth noticing before you start:

- `firebase.json`'s `ios.default` points at project `pulse-hypr`, app id
  `1:451329438541:...` — the wrong project.
- `firebase_options.dart` (Dart's actual runtime config) **already lists an
  iOS app id under `hypr-8064c`** (`1:686248417794:ios:bc147ff6e09a552316a51b`)
  — a *different* app id than the one `firebase.json` names. This may mean an
  iOS app registration already exists under `hypr-8064c` in the Firebase
  console (created but never wired into `firebase.json`), or it may be stale.
  **Check the Firebase console first** — you may only need to fix
  `firebase.json` and regenerate `GoogleService-Info.plist`, not create a new
  registration.

The backend only accepts one project (`wrangler.toml`'s `FIREBASE_PROJECT_ID`,
currently `hypr-8064c`) — ADR-020 explicitly rejected multi-project
acceptance, since it would let two users collide on the same uid across
projects in one Firestore namespace.

### What to build

1. In the Firebase console for `hypr-8064c`, confirm whether an iOS app
   registration already exists matching the Runner target's bundle id (see
   the note above — `firebase_options.dart` suggests one might). Register one
   if not.
2. Download that registration's `GoogleService-Info.plist`; replace
   `ios/Runner/GoogleService-Info.plist`.
3. Update `flutter/firebase.json`'s `ios.default.projectId` to `hypr-8064c`
   and `appId` to match the registration.
4. Regenerate `lib/firebase_options.dart` (`flutterfire configure`, or
   hand-edit) so its iOS entry is self-consistent with the above — resolve
   the app-id discrepancy noted above rather than leaving two candidate iOS
   app ids in the repo.
5. Grep the repo for any other hardcoded reference to `pulse-hypr` (search
   both `flutter/` and any build scripts) and update it.
6. Once verified working, the old `pulse-hypr` project's iOS registration can
   be deprecated — optional cleanup, not blocking.

### Files

`flutter/firebase.json` · `lib/firebase_options.dart` ·
`ios/Runner/GoogleService-Info.plist`

### Definition of done

- An iOS build's Firebase ID token has `aud`/`iss` matching `hypr-8064c`.
- A backend call made from that iOS build (e.g. `GET /v1/profile`) succeeds
  instead of returning `unauthenticated` (the `ADR-020` consequence this task
  removes).

---

## Task 3.2 — Stop iOS phantom fatal crashes from unregistered event channels

**Source:** [fix 04](../flutter/docs/fixes/04-ios-phantom-fatal-crashes.md) (full detail)

### Verified current state

`ios/Runner/VeepooBandChannel.swift` registers exactly nine event channels
(`scanResults`, `connectionState`, `heartRate`, `oxygen`, `hrv`, `bodyTemp`,
`steps`, `sleep`, `bloodPressure`) — confirmed by reading the registration
block. **No `battery`, no `syncProgress` channel exists.**

`lib/src/app/band_controller.dart`'s `battery.listen(...)` and
`syncProgress.listen(...)` subscriptions are guarded by
`if (band is VeepooBandConnection)` — a **type** check, true on both
platforms, not a platform check. Neither `.listen` call passes an `onError`
handler. `lib/main.dart`'s `PlatformDispatcher.instance.onError` records every
uncaught async error as `fatal: true`. Together: subscribing to an
unregistered iOS `EventChannel` throws `MissingPluginException` as a stream
error with nowhere to go but the global fatal-crash hook.

### What to build

1. Register `battery` and `syncProgress` `EventChannel`s in
   `VeepooBandChannel.swift` — they can initially emit nothing; wiring real
   data can ride along with Task 3.3.
2. Add `onError` handlers to every platform metric stream subscription in
   `band_controller.dart`'s monitoring setup, routed through
   `CrashDiagnostics.recordBandError` (non-fatal) — the helper already
   exists, this task just needs to use it consistently.
3. Optional, flag as an explicit decision rather than silently changing it:
   reconsider the blanket `fatal: true` in `main.dart`'s error hook.

### Files

`ios/Runner/VeepooBandChannel.swift` · `lib/src/app/band_controller.dart` ·
`lib/main.dart` (optional) · reference for parity:
`android/.../VeepooBandChannel.kt`

### Definition of done

- A full iOS session (connect, background, return, disconnect) produces
  **zero** fatal Crashlytics events attributable to `MissingPluginException`.
- Android behavior unchanged (battery pill still populates, sync progress
  still animates).
- Deliberately killing one event channel in a dev build produces a logged
  non-fatal, not a fatal.

---

## Task 3.3 — Replace the iOS live-measurement loop with history sync

**Source:** [fix 05](../flutter/docs/fixes/05-ios-history-sync-parity.md) (full detail — confidence 80%, iOS SDK behavior unverified on hardware)
**Develop together with Task 3.4** — see fix 09's own notes: sync must only
start once "authenticated," which is what 3.4 makes true.

### Verified current state

`band_controller.dart`'s monitoring-strategy method (`_startMonitoring`)
branches: **Android + Veepoo** → `_runAndroidVeepooMonitoring` (history sync).
**Everything else — including iOS** — falls through to the continuous live
loop (`startHeartRateMonitoring`, `startSpo2Monitoring`, `startHrvMonitoring`,
`startBodyTempMonitoring`). Confirmed still true reading the current file.
`VeepooBandChannel.swift` has no `syncHealthHistory` case in its method-call
switch — an iOS call to it returns `FlutterMethodNotImplemented`.

This is exactly the failure mode the Android redesign (`findings.md`)
eliminated: permanently lit PPG LEDs, band battery drain, minutes-stale
tiles, and — for bands like the KR96 PRO that don't support app-triggered
HRV — outright unsupported-operation behavior.

### What to build

1. Enumerate the bundled `ios/VeepooSDKPod/VeepooBleSDK.framework` headers
   for history-sync entry points — search for `SyncData`, `FiveMinute`,
   `OriginData`, `TestData`, `HealthData`-style method names. The framework
   already exposes `VPDataBaseOperation` reads the bridge uses for other
   metrics; something has to trigger the SDK-side sync that populates that
   store, and today nothing does.
2. Implement a `syncHealthHistory` method-call handler on iOS: trigger the
   SDK sync, report stage/progress on the `syncProgress` channel (added in
   3.2), read the resulting records (steps, HR, SpO₂, HRV, sleep, BP,
   battery) with **device timestamps**, resolve with the same
   `{completed, failedStages}` shape Android returns
   (`android/.../VeepooBandChannel.kt:71-84`, reference only). Bound every
   stage with a watchdog, mirroring Android's `SYNC_STAGE_TIMEOUT_MS`
   pattern.
3. Change `band_controller.dart`'s monitoring strategy to key off
   *capability* (attempt `syncHealthHistory` unconditionally) rather than
   hardcoded platform branching. Treat the live loop as removed once this
   lands — `refresh()` already catches not-implemented/missing-plugin errors
   gracefully, so an old native build degrades safely during rollout.
4. Keep per-metric live detections available only behind an explicit
   user-initiated measurement flow, if/when one is built — same policy
   Android already follows.
5. Emit battery during sync (needs 3.2's registered channel).
6. **Validate on a physical iPhone + band.** This bridge has never run
   against hardware. Use the **factory-reset-band protocol**
   ([Step 7.1](SETUP-AND-WIRING.md#71-band-side-protocol) /
   [`PHASES.md`'s H2 warning](PHASES.md#hardware-gated-pull-in-whenever-the-precondition-is-available))
   — a band previously touched by the vendor's GBand app has persisted
   settings that will make this test pass or fail for the wrong reasons.

### Files

`ios/Runner/VeepooBandChannel.swift` (primary) ·
`ios/VeepooSDKPod/VeepooBleSDK.framework/Headers/` (API discovery) ·
`lib/src/app/band_controller.dart` (monitoring strategy) ·
`lib/src/band/veepoo/veepoo_band_connection.dart` — no change expected,
`syncHealthHistory` is already defined platform-neutrally there.

### Definition of done

- Connecting on iOS does **not** continuously light the band's side LEDs.
- Dashboard tiles populate from recorded history with device timestamps
  after connect and on pull-to-refresh; the sync pill shows progress and
  completes.
- Method-channel contract is identical on both platforms (same method
  names, payload keys, result shape) — `veepoo_band_connection.dart` stays
  unmodified.
- One full connect–sync–background–return cycle on hardware, zero
  Crashlytics fatals.

### If the SDK doesn't cooperate

If the bundled framework lacks usable history-sync APIs for this band,
escalate to the vendor before building raw-protocol reads —
`findings.md`'s GBand analysis recommends this path; the HCI-snoop
interoperability workflow documented there is the fallback.

---

## Task 3.4 — Fix iOS "connected" semantics and known-band reconnect

**Source:** [fix 09](../flutter/docs/fixes/09-ios-connection-semantics.md) (full detail)
**Develop together with Task 3.3** — same hardware validation session.

### Verified current state — two independent defects

**A. Premature "connected."** `VeepooBandChannel.swift`'s
`connectionStateName` (confirmed by reading it):

```swift
case .BleConnectSuccess, .BleVerifyPasswordSuccess:
    return "connected"
// .BlePoweredOff, .BleConnectFailed, .BleVerifyPasswordFailure, .BleConnectTimeout, ...
    return "disconnected"   // no distinguishable failure reason
```

Both raw-connect success and password-verified success map to the same
string; there's no `"authenticating"` phase. **The Dart side already
supports this distinction and needs no change** — confirmed independently:
`BandConnectionState.authenticating` exists as its own enum value
(`lib/src/band/models.dart`), `veepoo_band_connection.dart` already parses
an `'authenticating'` string into it, and `dashboard_screen.dart` already
renders it as `"Pairing…"`. iOS just never emits the string that would
trigger it.

**B. Known-band reconnect is impossible on iOS.** `VeepooBandChannel.swift`'s
`connect` handler (confirmed):

```swift
private func connect(deviceId: String, result: @escaping FlutterResult) {
    guard let model = discoveredDevices[deviceId] else { ... }  // errors otherwise
```

It requires the device id to be present in the current session's in-memory
scan results. Android's `connect(mac)` needs no prior scan
(`BandConnectionManager.kt`, reference only). The app's known-band /
Settings-reconnect feature calls connect with a stored id from a *previous*
session — on iOS that always fails with `device_not_found`.

### What to build

1. **Map states faithfully:** `"connecting"` on `BleConnecting`,
   `"authenticating"` once the raw link is up but password hasn't succeeded
   (on `BleConnectSuccess`), `"connected"` only on `BleVerifyPasswordSuccess`.
   Surface `BleVerifyPasswordFailure` as a disconnection with a
   distinguishable reason (log/record it; the state channel's string
   contract itself doesn't need a new value beyond `"disconnected"`).
2. **Confirm/implement the iOS SDK's password-verify step.** The bridge
   currently never sets a password anywhere. The KR96 PRO uses `0000`,
   matching Android's `DEVICE_PASSWORD`. Sequence it like Android's handshake
   (both link-ready signals before password — see `AGENTS.md`) — this is a
   reference to mirror, not a modification to the protected Kotlin file.
3. **Support connect-by-identifier without a fresh scan.** Check whether
   `veepooSDKConnectDevice` can retrieve a peripheral by stored UUID/address
   directly (most CoreBluetooth wrappers can). If the SDK genuinely requires
   a live scan result, implement a scoped internal scan-then-connect inside
   the native `connect` handler — filtered for the requested id, connect on
   sight, timeout-bounded — so the Dart-facing contract matches Android.
4. **Accept identifier instability as a platform fact.** CoreBluetooth
   exposes per-phone peripheral UUIDs, not the BLE MAC Android sees. A band
   known on Android is not matchable on iOS, and that's fine — don't try to
   cross-match; `KnownBandStore` already keys by whatever id the platform
   reports, which is internally consistent per-platform.
5. Verify the hot-restart resolve path (`getConnectedDeviceId`) returns the
   id only when genuinely authenticated, once step 1 lands — it currently
   keys off `currentConnectionState == "connected"`, which becomes correct
   automatically once that string only fires on real auth success.

### Files

`ios/Runner/VeepooBandChannel.swift` (primary) ·
`ios/VeepooSDKPod/VeepooBleSDK.framework/Headers/` (password/verify +
reconnect API discovery) · Dart is a **contract reference only** —
`veepoo_band_connection.dart:138-151` (state string parsing) needs no
change, since the vocabulary it expects already exists.

### Definition of done

- On a physical iPhone: UI shows Connecting → Pairing → Connected in
  sequence; a wrong-password band (or simulated verify failure) never
  reaches "Connected."
- Settings → known band → Connect succeeds with the app freshly launched
  and no scan performed this session.
- Dart code unchanged; both platforms emit the same state vocabulary.

### If the SDK never delivers a distinguishable verify-success event

Fall back to treating the first successful post-connect protocol operation
as the authenticated signal, and document that decision inline — per fix
09's own risk note.

---

## Task 3.5 — Contextual permission prompting only (rescoped — not auto-connect)

**Source:** [fix 12](../flutter/docs/fixes/12-auto-connect-and-permission-flow.md) — **read the scope override below first; the doc itself still describes the original, superseded Part A proposal alongside the still-in-scope Part B.**
**Tier:** P2. **Entry criteria:** needs Task 1.4 (Phase 1's persisted-settings
store) — see notes below for why.

### Scope override — read before implementing

Fix 12 describes two independent parts:

- **Part A — "auto-connect on launch."** *"On app launch... if a last
  authenticated band exists and Bluetooth + permissions are already granted,
  begin a connection attempt to it automatically — silently."* **This is out
  of scope. Do not build it.**
- **Part B — remove the launch-time permission dialog.** Independent of Part
  A; a pure UX fix.

Part A is exactly the pattern the project owner already rejected for Phase
1's Task 1.2: the connection stays user-driven. After any drop, explicit
disconnect, or cold start, the user sees the disconnected state and taps to
reconnect — same as an initial pairing. `PHASES.md`'s own Phase 3 notes
already record this override (*"3.5 is fix 12 with its Part A dropped, for
the same reason as 1.2"*); this document just makes it impossible to miss.
**If you find yourself wiring a connect attempt into an app-launch or
controller-init code path, stop** — that's the superseded proposal, not this
task.

Part B stays: prompting for Bluetooth permission before the user has taken
any Bluetooth-related action is a bug on its own, unrelated to the
auto-connect question.

### Why this needs Task 1.4

Fix 12's evidence notes the native `KEY_CONNECTION_WANTED` flag "is close but
is currently also cleared by involuntary drops." Phase 1's Task 1.2 already
fixes that clearing bug on the Android native side. This task doesn't touch
that flag at all (no auto-connect logic here), but it's sequenced after
Phase 1 in `PHASES.md` because fix 12's *Part A* — which this task explicitly
excludes — was the piece that depended on it. Part B alone has no real
dependency on 1.4; the entry criteria in `PHASES.md` is inherited from the
original (larger) scope of fix 12, not from anything Part B specifically
needs. If you want to do Part B earlier, nothing here technically blocks it —
just don't let it become an excuse to sneak Part A in early too.

### Verified current state

`android/app/src/main/kotlin/com/pulsehypr/pulse_hypr/MainActivity.kt`'s
`onCreate` (confirmed — this file was **not** part of the uncommitted diff
mentioned at the top of this document, so this holds against both HEAD and
the current working tree) unconditionally calls
`ActivityCompat.requestPermissions` for `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`
(Android 12+) and `POST_NOTIFICATIONS` (13+) at launch — before sign-in,
before onboarding, before the user has expressed any Bluetooth intent.

### What to build

1. Remove the unconditional permission request from `MainActivity.onCreate`.
2. Let `BluetoothSetupChannel.prepareForScan` (already used by
   `BandController.toggleScan`) be the single permission path.
3. Fold `POST_NOTIFICATIONS` into a sensible contextual moment — first
   successful connect is natural (that's when the foreground-service
   notification becomes relevant). Have the connect flow or
   `prepareForScan` request it alongside.
4. **Do not add any launch-time or controller-init auto-connect logic.** Do
   not call `connectKnown` (or any iOS equivalent, once 3.4 makes it
   possible) from app startup or lifecycle-resume code.

### Files

`android/.../MainActivity.kt` (delete the request) ·
`android/.../BluetoothSetupChannel.kt` (`POST_NOTIFICATIONS` handling) ·
`lib/src/band/bluetooth_setup.dart` — contract should stay stable.

### Definition of done

- Fresh install: no permission dialogs appear until the user taps a
  scan/connect action.
- Permission-denied and Bluetooth-off cases land in the existing scan-error
  UX, not a launch-time dialog.
- No code path connects to a band without an explicit user tap — grep the
  diff for any new call into `connectKnown`/`connect` from app-init or
  lifecycle-resume code. There should be none.

---

## Phase exit criteria (from `PHASES.md`, repeated here for convenience)

- iOS builds authenticate successfully against the single consolidated
  project. (3.1)
- iOS crash telemetry reflects real crashes only — no phantom fatals from
  unregistered event channels. (3.2)
- iOS runs history sync instead of the live-measurement loop Android already
  removed. (3.3)
- iOS connection states match Android's semantics; reconnecting to a known
  band works. (3.4)
- Bluetooth permission is requested only when the user takes a
  Bluetooth-related action, on both platforms. (3.5)

When all five are true, update `PHASES.md`'s Phase 3 status to `Done`.

## What NOT to do in this phase

- Don't build fix 12's Part A (auto-connect on launch) — see Task 3.5's
  scope override above.
- Don't modify `BandConnectionManager.kt` — Tasks 3.3/3.4 reference it as a
  contract to mirror, never as a file to edit.
- Don't touch anything inside `flutter/AGENTS.md`'s do-not-touch zone.
- Don't modify anything under `backend/` — nothing here needs backend
  changes.
- Don't try to reconcile iOS CoreBluetooth peripheral UUIDs with Android BLE
  MACs into one identifier space — accept the platform difference (3.4).
- Don't skip the factory-reset-band protocol before validating 3.3/3.4 on
  hardware — a GBand-touched band's persisted settings will invalidate the
  test.

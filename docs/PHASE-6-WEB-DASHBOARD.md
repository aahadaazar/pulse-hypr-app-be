# Phase 6 Brief — Web Dashboard

A self-contained handoff for whoever (human or agent) implements Phase 6. You
should not need this session's conversation history — everything you need to
start is either in this document or linked from it.

**Read [`PHASES.md`](PHASES.md#phase-6--web-dashboard) first** for the
phase's goal and entry criteria. **This phase is different in character from
Phases 1–5**: there is no pre-existing fix document to draw from — `PHASES.md`
itself says the tasks are "not yet planned in detail." This brief does that
planning, grounded in three things that already exist and were verified
directly rather than assumed: the mobile app's actual current dashboard (for
what "same data" concretely means), the already-documented API contract
(nothing new needs building server-side to read data), and infra signals
already present in the backend's own source (see below — hosting has
effectively already been decided, whether or not anyone wrote that down).

**Verified against the repo as it stood when this was written.** No `web/`
or dashboard code exists anywhere in this repo yet — confirmed by directory
listing. This phase starts from nothing on the frontend side.

---

## Before you touch anything

1. **Entry criteria, per `PHASES.md` as of this writing:** Phase 2 (`Done`)
   and Phase 4 (`Done` — implementation complete, physical-band testing
   still pending) are both satisfied. Re-check `PHASES.md` if you're
   starting later — Phase 4's hardware testing being unfinished doesn't
   block this phase; nothing about a read-only web dashboard depends on
   BLE reliability.
2. **Read [ADR-001](../backend/docs/05-DECISIONS.md#adr-001--all-client-reads-go-through-this-api-firebase-is-auth-plus-storage)
   first — it's the one constraint that shapes this entire phase.** Every
   client read and write goes through the Hono API. The dashboard must
   **never** hold a Firestore credential or read Firestore directly via the
   Firebase JS SDK, even though that would be technically possible with
   security rules. This was a deliberate choice (one query surface for
   phone and dashboard; the packed-binary storage layout in Firestore stays
   a private implementation detail the API decodes, per ADR-002/ADR-012).
   Every screen in this phase is powered by a `GET` call to an
   already-existing, already-documented endpoint — nothing here needs new
   backend routes.
3. **Hosting has effectively already been decided — don't re-litigate it.**
   `backend/src/index.ts`'s CORS configuration already allow-lists three
   origins:
   ```ts
   const allowed = [
     'https://pulse-hypr.pages.dev',   // Cloudflare Pages, production
     'http://localhost:5173',          // Vite's default dev port
     'http://localhost:3000',          // secondary dev port
   ];
   ```
   This was set up before this brief was written, and confirms **Cloudflare
   Pages** as the intended host and **Vite** as the intended dev-tooling
   (port 5173 is Vite's own default, not a generic choice). Treat both as
   settled. Only the specific frontend framework on top of Vite (React,
   Vue, Svelte, or vanilla TS) is genuinely open — see "Open decisions"
   below.
4. **No Firebase Web app is registered yet.** Confirmed:
   `flutter/lib/firebase_options.dart` explicitly throws
   `"DefaultFirebaseOptions have not been configured for web"` if invoked
   for that platform. Registering one is Task 6.1 below, not a prerequisite
   assumed to already exist.
5. **`PHASES.md`'s "no backend changes expected" note is conditionally
   true, not unconditionally.** The CORS allow-list above is hardcoded to
   `pulse-hypr.pages.dev` specifically. If the dashboard ends up deployed
   at exactly that Cloudflare Pages default subdomain, no backend edit is
   needed. If it ends up on a custom domain or a differently-named Pages
   project, `backend/src/index.ts`'s `allowed` array needs a one-line
   addition — a real, if small, backend change. Confirm which case you're
   in before assuming zero backend work.

---

## Open decisions for the project owner

This project has a standing practice of recording decisions and their
rationale (`backend/docs/05-DECISIONS.md`'s ADR system) rather than making
consequential calls silently. This phase is greenfield enough that a few
things are worth surfacing explicitly rather than this brief just picking
for you:

1. **Frontend framework.** No technical requirement in the API or infra
   favors one over another — this is a read-only, polling-based dashboard
   with no complex client state. Pick whatever the implementer can ship
   fastest and maintain comfortably (React/Vite and Svelte/Vite are both
   reasonable defaults). The only hard requirement is Vite-based tooling
   (or otherwise serving on port 5173 in dev), to match the CORS allow-list
   without needing a backend edit during development.
2. **Repo placement.** Recommended: a new `web/` directory as a sibling to
   `backend/` in *this* root repo, not a separate repository. Rationale:
   `backend/` already lives here (unlike `flutter/` and `Android_Ble_SDK/`,
   which the root `.gitignore`'s own comment marks as independent repos
   cloned side by side). The dashboard is tightly coupled to the API
   contract `backend/` defines — one repo means a contract-breaking API
   change and its dashboard-side fix can land in one PR and one review.
3. **Polling interval.** ADR-001 mandates polling over realtime but doesn't
   specify a cadence for a browser context. Recommended: something short
   while the tab is visible (e.g. 30s) via the Page Visibility API, paused
   entirely when the tab is backgrounded — a browser tab has none of the
   phone's battery constraints that drove the mobile app's debounce
   intervals, so there's no need to reuse those numbers here. This needs no
   backend config; it's a client-only polling loop against endpoints that
   already exist.

None of these three block starting the work below — they affect *how* you
build it, not *whether* the plumbing exists to build it against.

---

## Task 6.1 — Firebase Web app + Google Sign-In

### Verified current state

No web platform is registered under Firebase project `hypr-8064c` (see
"Before you touch anything" #4). The Android and iOS apps are registered
(the latter pending Phase 3's consolidation, per ADR-020 — irrelevant here
since the dashboard is a new, separate Firebase app entry regardless of
mobile's project situation).

### What to build

1. In the Firebase console, register a new **Web app** under `hypr-8064c`.
   This produces a config object (`apiKey`, `authDomain`, `projectId`,
   etc.) — unlike the backend's service-account credentials, **this config
   is meant to be public**; it ships in every page load of any Firebase web
   app and carries no secret value on its own.
2. Initialize the Firebase JS SDK with that config; wire Google Sign-In
   (`signInWithPopup` or `signInWithRedirect`, either is fine for a
   dashboard) using the same Google OAuth client the mobile app already
   uses under this project, or a new one scoped to the web app — either
   works since Firebase Auth handles both under one project.
3. On sign-in, obtain the ID token (`user.getIdToken()`) and attach it as
   `Authorization: Bearer <token>` on every API call — identical mechanism
   to the mobile app, different SDK surface.
4. Handle token refresh: Firebase's JS SDK auto-refreshes ID tokens
   similarly to the mobile SDK; don't hand-roll expiry tracking.

### Definition of done

- A user can sign in with the same Google account they use on mobile and
  land on an authenticated dashboard shell.
- API calls carry a valid bearer token; an expired/missing token produces
  the same `unauthenticated`/`token_expired` error codes documented in
  [`backend/docs/03-API.md`](../backend/docs/03-API.md)'s error table, and
  the client handles them (re-prompt sign-in, or silent refresh-and-retry).

---

## Task 6.2 — Data-fetching layer (the ADR-001 boundary)

### What to build

One thin client module wrapping every read this dashboard needs — this is
the layer that enforces ADR-001 in practice (everything funnels through the
API, nothing reaches into Firestore):

```
GET /v1/profile          → user's profile, goals, units, preferences
GET /v1/metrics/latest    → current tile values (the dashboard's main data source)
GET /v1/sleep             → recent nights
GET /v1/devices           → known bands (for a "last synced from…" note, optional)
```

All four are already fully specified in
[`backend/docs/03-API.md`](../backend/docs/03-API.md) — the response shapes
there are the contract; don't invent a different one. Base URL should be
environment-aware (point at the deployed Worker's URL; support pointing at
a local `wrangler dev` instance for development, matching how the mobile
app's own dev setup works per
[`SETUP-AND-WIRING.md`](SETUP-AND-WIRING.md)).

Wrap the polling loop from "Open decisions" #3 here — one place that calls
`/v1/metrics/latest` (and `/v1/sleep` on a slower cadence, since a night's
sleep data doesn't change intra-day) and republishes to whatever state
layer the chosen framework uses.

### Definition of done

- Every dashboard screen reads through this one module — no component
  calls `fetch` directly against the API.
- A backend error (any code in the documented error table) surfaces as a
  visible, honest state in the UI, not a silent failure or an infinite
  loading spinner.

---

## Task 6.3 — Dashboard: tile parity with the mobile app

### Verified current state — the actual parity target

`PHASES.md`'s exit criterion is "the same data as the mobile app." Read
directly from `flutter/lib/src/screens/dashboard_screen.dart`, the mobile
dashboard's tile grid is exactly these eight tiles, each with a header,
current value, unit, and "last measured" timestamp:

| Mobile tile | Source endpoint | Field(s) |
|---|---|---|
| Heart Rate | `GET /v1/metrics/latest` | `streams.hr.values.bpm`, `.measuredAt` |
| Blood O2 | `GET /v1/metrics/latest` | `streams.spo2.values.percent`, `.measuredAt` |
| HRV | `GET /v1/metrics/latest` | `streams.hrv.values.milliseconds`, `.measuredAt` |
| Sleep | `GET /v1/sleep` (most recent night) | `nights[0]` — `totalMinutes`, `deepMinutes`, etc. |
| Body Temp | `GET /v1/metrics/latest` | `streams.temp.values.celsius`, `.measuredAt` |
| Blood Pressure | `GET /v1/metrics/latest` | `streams.bp.values.{systolic,diastolic}` |
| Calories | `GET /v1/metrics/latest` | `streams.calories.values.kcal` |
| Distance | `GET /v1/metrics/latest` | `streams.distance.values.distanceM` (convert to km/mi per user units) |

This is the concrete definition of "same data" — build these eight, sourced
from the two endpoints above, before considering anything beyond parity.

### What to build

1. Eight tiles matching the table above. Each shows the current value, its
   unit, and an honest "last measured" relative-time label derived from
   `measuredAt` — the same principle
   [`backend/docs/03-API.md`](../backend/docs/03-API.md) states for
   `/v1/metrics/latest`: *"an old value must not render as a live one."*
2. Respect `units` from `GET /v1/profile` (distance in km vs. mi, temperature
   in °C vs. °F) — the mobile app already does this; don't hardcode one
   unit system.
3. A stream absent from the `/v1/metrics/latest` response (never measured,
   or outside `lookbackDays`) should render an honest empty state — "No
   measurement yet," not a blank tile or a crash on a missing key.

### Definition of done

- All eight tiles render real data for a signed-in user with existing
  mobile-synced history.
- Values update on the polling interval without a manual page reload.
- A stream with no data shows an honest empty state, not `undefined` or a
  layout break.

---

## Task 6.4 — Sleep detail view

### What to build

A secondary view (not required to be on the main dashboard) showing recent
nights from `GET /v1/sleep?from=&to=` — the same data
`flutter/lib/src/screens/dashboard_screen.dart`'s `_SleepTile` summarizes,
but with room to show the segment/stage detail the API already returns
(`segments: [{offsetMin, durationMin, state}]`) if you want more than the
single-tile mobile view offers. This is optional depth, not required for
phase exit — the exit criterion only requires the *same* data as mobile,
which the Task 6.3 sleep tile alone already satisfies.

### Definition of done

- Recent nights list, each showing total/deep/light/awake minutes and
  quality — matches what `GET /v1/sleep` already returns, no new backend
  work.

---

## Task 6.5 — Profile / settings view (optional, P2)

`GET/PUT /v1/profile` already exists and is fully documented, including its
field-masked `PUT` semantics (send only the top-level groups you're
changing). A settings screen mirroring what onboarding/settings collect on
mobile (height, weight, goals, units) is a natural extension, but
`PHASES.md`'s stated exit criterion doesn't require it — treat this as
optional scope, not a blocker for calling the phase done.

**If you build it:** reuse the exact field-masking contract documented in
`backend/docs/03-API.md`'s `PUT /v1/profile` section — don't invent a
different update semantics for the web client than what the API already
defines for mobile.

---

## Task 6.6 — Deploy to Cloudflare Pages

### What to build

1. Build the chosen framework's static output; deploy to Cloudflare Pages,
   using the Cloudflare account already provisioned for the Worker (same
   account as `backend/`'s deployment, per
   [`SETUP-AND-WIRING.md`](SETUP-AND-WIRING.md) Step 3).
2. Confirm the deployed URL matches (or is added to) the CORS allow-list in
   `backend/src/index.ts` — see "Before you touch anything" #5. If it's the
   default `pulse-hypr.pages.dev`, this is already done; verify rather than
   assume.
3. Set up the same collaborator-access pattern already established for the
   rest of this project (Editor/member access, not separate per-developer
   projects) — see
   [ADR-021](../backend/docs/05-DECISIONS.md#adr-021--collaborators-share-the-owners-project-they-dont-mint-their-own)
   and [`ONBOARDING.md`](ONBOARDING.md) for the existing pattern to follow,
   rather than inventing a new access model for this one service.

### Definition of done

- The dashboard is reachable at a stable URL, signs in, and shows live data
  from the production backend.
- A fresh collaborator with Editor-level Cloudflare access (already granted
  per `ONBOARDING.md`, if they've onboarded) can deploy without needing
  additional credentials beyond what they already have.

---

## Phase exit criteria (from `PHASES.md`, repeated here for convenience)

- Dashboard shows the same data as the mobile app for a signed-in user,
  kept in sync via polling (no realtime infrastructure exists — see
  [ADR-001](../backend/docs/05-DECISIONS.md)).

Concretely, per this brief: the eight tiles in Task 6.3, sourced from
`/v1/metrics/latest` and `/v1/sleep`, polling on a visible-tab interval,
behind Google Sign-In via a registered Firebase Web app. Tasks 6.4 and 6.5
are additive, not required for this bar.

## What NOT to do in this phase

- Don't read Firestore directly from the browser, with the Firebase JS SDK
  or otherwise — this violates ADR-001 regardless of how tempting security
  rules might look for a "just this once" read. Every read goes through the
  Hono API.
- Don't assume the existing Android/iOS Firebase config works for web — web
  needs its own registered app and config object (Task 6.1).
- Don't invent a different `PUT /v1/profile` update contract than the one
  already documented — if you build Task 6.5, reuse the field-masking
  semantics as-is.
- Don't skip verifying the CORS allow-list matches your actual deployed
  domain — see "Before you touch anything" #5.
- Don't build write/mutation UI beyond profile editing (Task 6.5, optional)
  without checking with the project owner first — this phase's stated goal
  is to "ship the frontend this backend was built for," which the exit
  criterion frames entirely in terms of *displaying* data.

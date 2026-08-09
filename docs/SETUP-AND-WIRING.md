# Setup and Wiring — Next Steps

The guide for getting this project from "three folders on one machine" to "two
developers shipping against a real backend."

**Scope.** Toolchain installation (Flutter SDK, Android Studio, JDK, emulator,
device setup) is already covered by
[`flutter/LOCAL_SETUP_AND_RUN.md`](../flutter/LOCAL_SETUP_AND_RUN.md) — do that
first and do not duplicate it here. This document covers everything that guide
does not: repository structure, credential handling for a two-person team,
backend provisioning, and the order the remaining work should be done in.

Read [`DATA-AND-APP-FLOW.md`](DATA-AND-APP-FLOW.md) first if you have not — it
explains what connects to what and why. For *what to build and in what
order* once this setup is done, see [`PHASES.md`](PHASES.md) — this document
only gets you to a working, shareable, deployed foundation.

---

## 0. Where things actually stand

| Component          | Git repo        | Remote                            | Deployable           |
| ------------------ | --------------- | --------------------------------- | -------------------- |
| `flutter/`         | ✅ own repo     | `IffatAhmedk/pulse-hypr-test-app` | ✅                   |
| `Android_Ble_SDK/` | ✅ vendor clone | `HBandSDK/Android_Ble_SDK`        | n/a — reference only |
| `backend/`         | ❌ **none**     | —                                 | ❌ never deployed    |
| `docs/`            | ❌ **none**     | —                                 | n/a                  |

> ⚠️ **`backend/` and `docs/` exist only on this machine and are not under version
> control anywhere.** A collaborator cannot obtain them, and a disk failure loses
> them. This is step 1 and everything else depends on it.

Also outstanding, from the flow document:

- No local sample store in the app → nothing to sync
- No sync engine → backend has never received a request
- Two Firebase projects in `firebase.json` → iOS cannot authenticate

---

## Step 1 — Put the backend under version control

`flutter/` is already its own repo with its own remote, and `Android_Ble_SDK/` is
a clone of a vendor repo you do not own. Neither should be absorbed. The clean
move is a second repo at the root that ignores both.

```bash
cd e:/Projects/pulse-hypr-test-app

cat > .gitignore <<'EOF'
# Independent repositories, cloned side by side — see docs/SETUP-AND-WIRING.md
/flutter/
/Android_Ble_SDK/

node_modules/
.wrangler/
.dev.vars
*.log
.DS_Store
EOF

git init
git add .gitignore backend docs
git commit -m "Backend service and cross-repo documentation"
gh repo create pulse-hypr-platform --private --source=. --push
```

The friend then reproduces the exact on-disk layout:

```bash
mkdir pulse-hypr-test-app && cd pulse-hypr-test-app
git clone git@github.com:<you>/pulse-hypr-platform.git .
git clone git@github.com:IffatAhmedk/pulse-hypr-test-app.git flutter
git clone https://github.com/HBandSDK/Android_Ble_SDK.git    # reference, optional
```

**Why not one monorepo.** Merging the Flutter app in means rewriting the history
of a repo that already carries the hard-won BLE fixes described in
[`flutter/AGENTS.md`](../flutter/AGENTS.md). The two components deploy on
completely different cycles — an app-store release versus `wrangler deploy` —
so there is no shared release train to justify the risk. Revisit if you ever add
a third component that must version-lock with both.

**Give the friend write access to both repos** and agree on a branch convention
now (`main` protected, feature branches, PRs) — retrofitting that after two
people are pushing to `main` is unpleasant.

---

## Step 2 — Credentials without emailing `.env` files

This is the part worth getting right once.

### 2.1 What is actually secret

Most of what _looks_ like a credential in this project is not one.

| Item                                            | Secret?                        | Where it lives                       | Notes                                                                                                |
| ----------------------------------------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `android/app/google-services.json`              | **No**                         | committed, correctly                 | Client config. Ships inside every APK — anyone can extract it. Do not gitignore it; the build breaks |
| `ios/Runner/GoogleService-Info.plist`           | **No**                         | committed, correctly                 | Same                                                                                                 |
| `lib/firebase_options.dart`                     | **No**                         | committed                            | Same                                                                                                 |
| `FIREBASE_PROJECT_ID`                           | **No**                         | `wrangler.toml`                      |                                                                                                      |
| KV namespace ids                                | **No**                         | `wrangler.toml`                      |                                                                                                      |
| Debug keystore SHA-1                            | **No**, but per-developer      | each machine                         | Must be registered in Firebase — see step 4.1                                                        |
| `FIREBASE_CLIENT_EMAIL`                         | Low                            | encrypted `.env.*`                   | Identifies the service account                                                                       |
| **`FIREBASE_PRIVATE_KEY`**                      | **🔴 Critical**                | encrypted `.env.*` + Cloudflare      | Full read/write on the entire Firestore database                                                     |
| **Cloudflare API token**                        | **🔴 Critical**                | CI secret                            | Can deploy or delete the Worker                                                                      |
| **Android release keystore + `key.properties`** | **🔴 Critical, irreplaceable** | encrypted `.env.production` (base64) | Losing it means you can never update the Play listing again                                          |

So the genuinely-secret set is **three items**, not a folder of `.env` files.

### 2.2 The principle: don't share credentials, mint your own

The best answer to "how do I transfer my env to my friend" is usually **don't**.
Three tiers:

| Tier        | Who            | Credentials                                        | Sharing                                                                 |
| ----------- | -------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| **Dev**     | Each developer | Own Firebase project + own free Cloudflare account | **None.** Everyone mints their own                                      |
| **Staging** | Shared         | One Firebase project + one Worker                  | `.env.staging` committed encrypted; its private key shared              |
| **Prod**    | Owner only     | Real project, release keystore                     | `.env.production` committed encrypted; its private key **never** shared |

Two consequences worth internalising:

1. **A collaborator doing Flutter work needs zero backend secrets.** Point the app
   at your deployed _staging_ Worker and they never touch a service-account key.
   Only someone editing backend code needs one — and then it should be theirs.
2. **Cloudflare is itself a secret store for the deployed service.** Once
   `wrangler secret put` has run, the value is encrypted at Cloudflare and never
   needed locally again until rotation. Local secret handling covers only
   bootstrapping, local development, and CI.

That reduces the problem from "sync all environment variables between two
machines" to "send one private-key string, once."

### 2.3 The tool: dotenvx

**[dotenvx](https://dotenvx.com)** — free, MIT, no account, no server, no SaaS.
From the author of `dotenv`.

It encrypts each value in a `.env` file with public-key cryptography. The result
is that **the encrypted `.env` files are committed to the repo** and the only
thing you ever hand your friend is a single private-key string, once, per
environment.

```
.env.production   ← committed. Values encrypted. Contains the PUBLIC key
.env.keys         ← NEVER committed. Contains the PRIVATE keys
```

Three properties that make this the right fit here:

1. **Nothing to transfer but one string.** Not a folder of `.env` files, not an
   invite to a service. `DOTENV_PRIVATE_KEY_DEV=4f2c…` over Signal, once.
2. **The public key is in the committed file**, so your friend can _add or
   change_ secrets without ever holding the private key. They encrypt; only
   deploy needs to decrypt.
3. **Secrets are versioned with the code.** A branch that adds a config value
   carries its encrypted value. No drift between what the code expects and
   what is actually stored.

Everything below was verified against **dotenvx 2.20.1**.

| Alternative                     | Verdict                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **SOPS + age**                  | ✅ Also free/OSS, and handles _binary files_ properly. Use it if you accumulate more file-shaped secrets than the one keystore          |
| 1Password / Infisical / Doppler | Fine tools; all want an account, and two of them want money as you grow. Unnecessary at this size                                       |
| HashiCorp Vault                 | ❌ Not for two people. A server to run, unseal, back up, and write policies for. Revisit at ~10 engineers or when compliance demands it |
| `.env` over Slack/email         | ❌ Lives in message history, backups, and someone's Downloads folder forever                                                            |

### 2.4 Setting it up

```bash
cd backend
npm i -D @dotenvx/dotenvx
```

Create the dev environment. **Note the `-f` placement** — see the gotchas below:

```bash
npx dotenvx set FIREBASE_CLIENT_EMAIL -f .env.dev \
  "firebase-adminsdk-xxxxx@hypr-8064c.iam.gserviceaccount.com"

npx dotenvx set FIREBASE_PRIVATE_KEY -f .env.dev \
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n'
```

That creates two files:

```bash
# .env.dev  ← commit this
DOTENV_PUBLIC_KEY_DEV="0230870cfc3fe90fd3196738..."
FIREBASE_CLIENT_EMAIL="encrypted:BFNdUrbSSvKzD+2fyLighntHGMVwOLPbdkfHl6TYQL..."
FIREBASE_PRIVATE_KEY="encrypted:BOVYZf1kITw+ijXNEbc4QX84vJumg70OmztCL3IQUh..."

# .env.keys  ← NEVER commit
DOTENV_PRIVATE_KEY_DEV=4f2c1737e6b06cf0ce80fbdd47d26b4340bd9eabd8c601a90dd0b3def34b3a9c
```

Repeat with `-f .env.production` for the prod service account. That produces a
second key pair — `DOTENV_PRIVATE_KEY_PRODUCTION` — which you keep and your
friend never receives. **Environment isolation comes free from key separation.**

```bash
git add .env.dev .env.production        # encrypted — safe
echo ".env.keys" >> .gitignore          # or: npx dotenvx gitignore
npx dotenvx precommit                   # verifies nothing plaintext is staged
```

Onboarding your friend is now one message:

> `DOTENV_PRIVATE_KEY_DEV=4f2c1737e6b06cf0…` — put this in `backend/.env.keys`

### 2.5 Two gotchas that will cost you an hour

Both were hit while verifying this guide.

**① `-f` must come _before_ a value starting with `-`.**

A PEM always begins `-----BEGIN PRIVATE KEY-----`, which the argument parser
reads as flags. Everything after it — including `-f` — is silently dropped, and
the value lands in the default `.env` instead of the file you named:

```bash
# ✗ silently writes to .env, not .env.dev
npx dotenvx set FIREBASE_PRIVATE_KEY "-----BEGIN PRIVATE KEY-----\n..." -f .env.dev
#   → ◈ encrypted FIREBASE_PRIVATE_KEY (.env)

# ✓ -f first
npx dotenvx set FIREBASE_PRIVATE_KEY -f .env.dev "-----BEGIN PRIVATE KEY-----\n..."
#   → ◈ encrypted FIREBASE_PRIVATE_KEY (.env.dev)
```

**② Store the key as one line with literal `\n`, not as a real multi-line PEM.**

Passing a genuinely multi-line value through the shell truncates it to the first
line — it round-trips as just `-----BEGIN PRIVATE KEY-----`, and you get an
opaque crypto error at runtime rather than anything pointing at the cause.

Use the single-line escaped form, which is **exactly how the key appears in the
service-account JSON**, so copy it straight out of that file:

```bash
# extract it in the correct form directly
npx dotenvx set FIREBASE_PRIVATE_KEY -f .env.dev "$(jq -r '.private_key' sa.json | sed -z 's/\n/\\n/g')"
```

This is safe because [`backend/src/firestore/token.ts`](../backend/src/firestore/token.ts)
already normalises both forms — it does `pem.replace(/\\n/g, '\n')` before
importing the key, precisely for this reason.

Verify the round-trip before trusting it:

```bash
npx dotenvx get FIREBASE_PRIVATE_KEY -f .env.dev
# must print the WHOLE key ending in -----END PRIVATE KEY-----\n
```

### 2.6 Using it day to day

**Local development.** Wrangler reads secrets from `.dev.vars`, so generate it
from the encrypted file:

```bash
# backend/scripts/dev-vars.sh
set -euo pipefail
{
  printf 'FIREBASE_CLIENT_EMAIL="%s"\n' "$(npx dotenvx get FIREBASE_CLIENT_EMAIL -f .env.dev)"
  printf 'FIREBASE_PRIVATE_KEY="%s"\n'  "$(npx dotenvx get FIREBASE_PRIVATE_KEY  -f .env.dev)"
} > .dev.vars
echo "wrote .dev.vars"
```

```jsonc
// backend/package.json
"scripts": {
  "secrets": "sh scripts/dev-vars.sh",
  "dev": "npm run secrets && wrangler dev"
}
```

`.dev.vars` is already gitignored. Regenerating it is idempotent, so nobody has
to think about staleness.

**Deploying.** Push each secret to Cloudflare once; after that Cloudflare holds
it encrypted and you only return here to rotate:

```bash
npx dotenvx get FIREBASE_PRIVATE_KEY -f .env.production \
  | npx wrangler secret put FIREBASE_PRIVATE_KEY --env production

npx dotenvx get FIREBASE_CLIENT_EMAIL -f .env.production \
  | npx wrangler secret put FIREBASE_CLIENT_EMAIL --env production
```

**CI.** The private key can come from the environment instead of `.env.keys` —
verified: with `DOTENV_PRIVATE_KEY_DEV` set, decryption works with no key file
present; without it, values stay encrypted. So GitHub Actions needs exactly
**two** repository secrets:

```yaml
- name: Deploy
  env:
    DOTENV_PRIVATE_KEY_PRODUCTION: ${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: |
    cd backend
    npx dotenvx run -f .env.production -- npx wrangler deploy --env production
```

**The Android release keystore.** dotenvx handles env vars, not files. Base64 it
into the production environment — it is a one-line value, so it encrypts fine:

```bash
npx dotenvx set ANDROID_KEYSTORE_B64 -f .env.production "$(base64 -w0 release.jks)"
npx dotenvx set ANDROID_KEYSTORE_PASSWORD -f .env.production "..."

# restore when signing a release
npx dotenvx get ANDROID_KEYSTORE_B64 -f .env.production | base64 -d > release.jks
```

If file-shaped secrets multiply beyond this one, switch to **SOPS + age**, which
encrypts binaries natively. For a single keystore, base64 is not worth a second
tool.

### 2.7 Guardrails

Templates and tiers only help if a raw key can never be committed by accident.

```bash
# root .gitignore — add these
.env.keys
*serviceAccount*.json
*service-account*.json
*.jks
*.keystore
key.properties
.dev.vars
.env
.env.*
!.env.example
!.env.dev
!.env.staging
!.env.production
```

Add secret scanning as a pre-commit hook — cheap, and it catches the one mistake
that matters:

```bash
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks: [{ id: gitleaks }]
```

```bash
pip install pre-commit && pre-commit install
```

Also enable **GitHub secret scanning + push protection** on both repos
(Settings → Code security). It is free on private repos and blocks a push
containing a recognised key.

> If a service-account key is ever committed, rotate it — do not just delete the
> commit. Revoke in the Google Cloud console, generate a new one, update the
> encrypted files, re-run `wrangler secret put`. Assume anything pushed was
> captured.

---

## Step 3 — Provision the backend

Full detail in [`backend/docs/07-OPERATIONS.md`](../backend/docs/07-OPERATIONS.md);
this is the ordered path.

### 3.1 Firebase

1. **Decide the project.** [`flutter/firebase.json`](../flutter/firebase.json)
   currently names `hypr-8064c` for Android/Dart and `pulse-hypr` for iOS. Pick
   one and run `flutterfire configure` against it for **all** platforms. Until
   this is done, iOS cannot authenticate against the backend at all
   ([ADR-020](../backend/docs/05-DECISIONS.md)).
2. **Firestore → Create database → Native mode.** Choose the region deliberately:
   it is fixed forever and is the floor on every API response time.
3. **Service account** — Project settings → Service accounts → Generate new
   private key. Grant **Cloud Datastore User** only, not Owner. Put it straight
   straight into `.env.production` with `dotenvx set`; do not leave the raw
   JSON in Downloads.
4. **TTL policy — required.** Firestore → TTL → Create policy, collection group
   `receipts`, field `expiresAt`. Without it, idempotency receipts grow forever.
5. **Index exemptions — recommended.** Disable indexing on the packed blob
   fields listed in [`07-OPERATIONS.md §2.4`](../backend/docs/07-OPERATIONS.md).

### 3.2 Cloudflare

```bash
cd backend
npm install

npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
# paste both ids into wrangler.toml

npm run secrets            # decrypts .env.dev into .dev.vars, per step 2
npm run typecheck && npm test
npx wrangler deploy
```

### 3.3 Smoke test

```bash
curl https://pulse-hypr-api.<subdomain>.workers.dev/health
# → {"ok":true,"time":...}
```

Then with a real token — add a temporary debug button in the app that prints
`await FirebaseAuth.instance.currentUser!.getIdToken()`:

```bash
TOKEN="<paste>"
API="https://pulse-hypr-api.<subdomain>.workers.dev"

curl "$API/v1/ingest/schema" -H "Authorization: Bearer $TOKEN"
curl "$API/v1/sync/state"    -H "Authorization: Bearer $TOKEN"

curl -X POST "$API/v1/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"batchId":"smoke-1","deviceId":"AA:BB:CC:DD:EE:FF","tzOffsetMin":300,
       "series":[{"stream":"hr","t":[1754697600000,1754697900000],"v":[64,66]}]}'
# → 201, inserted: 2

# send it again, verbatim
# → 200, duplicate: true, inserted: 0     ← idempotency proven

curl "$API/v1/metrics/latest" -H "Authorization: Bearer $TOKEN"
```

**The second request returning `duplicate: true` is the single most important
assertion in the system.** The band re-serves its whole retained window on every
sync, so if that fails, everything downstream double-counts.

---

## Step 4 — Per-developer Flutter environment

After [`LOCAL_SETUP_AND_RUN.md`](../flutter/LOCAL_SETUP_AND_RUN.md).

### 4.1 The SHA-1 gotcha — read this before debugging sign-in

Google Sign-In on Android validates the app's signing certificate. **Every
developer's debug keystore has a different SHA-1**, so a second developer's
`Sign in with Google` fails silently — usually as a cancelled-looking
`GoogleSignInException` with no useful message — until their fingerprint is
registered.

```bash
cd flutter/android
./gradlew signingReport     # find the SHA1 under Variant: debug
```

Firebase console → Project settings → your Android app → **Add fingerprint** →
paste the SHA-1. Then re-download `google-services.json` and **commit it** — the
file gains an `oauth_client` entry per registered fingerprint, so both
developers' hashes must be present in the committed copy.

Do this once per developer per machine. It is the most common cause of "sign-in
works for you but not for me."

### 4.2 Keep the committed Firebase config as-is

`google-services.json`, `GoogleService-Info.plist` and `firebase_options.dart`
are tracked and should stay tracked. They are client identifiers that ship inside
every APK, not secrets. Gitignoring them breaks the build for the other
developer, which is a tempting mistake to make while tightening secret handling.

If someone wants to develop against their own Firebase project, use a build
flavor with a gitignored override rather than swapping the committed files.

### 4.3 Hardware

| Item                | Detail                                                   |
| ------------------- | -------------------------------------------------------- |
| Phone               | Pixel 8 Pro (the device the BLE fixes were validated on) |
| Band                | Veepoo KR96 PRO, pairing password `0000`                 |
| Band history window | 3 days (`watchDataDay`)                                  |

⚠️ [`flutter/AGENTS.md`](../flutter/AGENTS.md) declares a **do-not-touch zone**
around `BandConnectionManager.kt` and the `BluetoothService` manifest entry.
Both developers must read it before touching Android BLE code — the constraints
there encode a reproduced device bug, not a style preference.

---

## Step 5 -- Build order

The execution roadmap now lives in its own document:
**[`PHASES.md`](PHASES.md).**

It groups the fix plan from
[`flutter/docs/fixes/00-INDEX.md`](../flutter/docs/fixes/00-INDEX.md) --
written before this backend existed -- into phases with explicit entry and
exit criteria, and records four deliberate departures from that plan's
original ordering and scope:

| Change | What | Why (full reasoning in PHASES.md) |
|---|---|---|
| Promoted | Fix 06 (`syncPersonInfo`) now ships *before* the sync engine | Wrong calorie/distance data becomes a permanent, unrecoverable rollup once ingest is live |
| Promoted | Fix 11 (persist settings) now pairs with fix 02 | Both are local persistence work; fix 11 unblocks fix 06 |
| Bundled | Fix 13 (step-polling cadence) now ships with the sync engine | Both are the same battery-policy conversation |
| **Rescoped** | Fix 01 and fix 12 **no longer add silent auto-reconnect / auto-connect** | Confirmed product decision: connection stays user-driven. Both fixes keep their independent correctness/UX fixes -- see [PHASES.md Phase 1](PHASES.md#phase-1--core-android-reliability) |

Read [`PHASES.md`](PHASES.md) for the phase-by-phase breakdown -- goals, entry
and exit criteria, and task lists. This document (`SETUP-AND-WIRING.md`)
covers the *infrastructure* Phase 0 depends on; `PHASES.md` covers
*everything after that*.

---

## Step 6 — Splitting the work

Mapped onto [`PHASES.md`](PHASES.md)'s task numbers. Two developers, minimal
collision:

|           | Owner                                                              | Collaborator                                          |
| --------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| **First** | Steps 1–3 (repos, secrets, backend live)                           | Toolchain, SHA-1 registered, app running on a device  |
| **Then**  | 1.1 local store — touches `BandController`, the shared hot spot    | 1.2 honest disconnect state — Android native only, isolated |
| **Then**  | 2.1 sync engine                                                    | 1.3 + 1.4 profile round-trip and persisted settings   |
| **Then**  | Backend read endpoints (Phase 6) as the UI needs them              | 4.3, 2.3 sync-failure UX and step-polling power       |

1.1 and 1.2 touch different layers and can genuinely run in parallel — see
[Phase 1's entry criteria](PHASES.md#phase-1--core-android-reliability) for
why neither needs the backend to be live first. After that, whoever owns the
local store should own the sync engine — they are the same abstraction.

**Hardware-gated items (H1, H2) belong to whoever physically holds the band.**
Only one person can test BLE at a time.

---

## Step 7 — Verifying it end to end

### 7.1 Band-side protocol

[`BLUETOOTH_SDK_BAND_CONNECTIVITY.md §8`](../flutter/docs/BLUETOOTH_SDK_BAND_CONNECTIVITY.md)
warns that testing with a band previously configured by the vendor's GBand app
proves nothing — GBand's automatic-measurement settings persist on the device, so
your app appears to work while doing none of the arming itself.

**Validate fixes 02, 05, 06 and 07 on a factory-reset band that has never
connected to GBand:**

1. Connect and authenticate (password `0000`)
2. Confirm capabilities are received and stored
3. Sync the user profile
4. Arm the supported automatic measurements
5. Wait at least one measurement interval
6. Disconnect and reconnect
7. Confirm the new measurements arrive via the history APIs

### 7.2 Full-pipeline acceptance

| #   | Test                                               | Pass condition                                                                           |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Force-stop, relaunch with Bluetooth off            | Every tile shows its last value with an honest timestamp; no sync pill claiming activity |
| 2   | Pull-to-refresh twice with the band idle           | Local row count stable; ingest reports `inserted: 0`                                     |
| 3   | Replay a `batchId`                                 | `duplicate: true`, nothing written                                                       |
| 4   | Airplane mode → record → back online               | Queued rows upload; no data lost                                                         |
| 5   | Sign out, reinstall, sign in                       | Dashboard populated from `/v1/metrics/latest` before any BLE traffic                     |
| 6   | Compare a day total against the band's own display | Steps match — proves `counters` vs bucket handling is right                              |
| 7   | Cross a timezone, then sync                        | Days split at the local midnights actually lived through                                 |

Test 6 is the one that catches the steps trap described in
[the flow doc](DATA-AND-APP-FLOW.md#hop-5--local-store--backend-missing). If
daily totals come out roughly double, cumulative `readSportStep` values are being
sent as `steps` samples instead of `counters`.

---

## Checklists

**Owner, one time**

- [ ] Root repo created, `backend/` and `docs/` pushed
- [ ] Collaborator has write access to both repos
- [ ] dotenvx installed; `.env.dev` / `.env.production` encrypted and committed
- [ ] `.env.keys` gitignored; `dotenvx precommit` passes
- [ ] `DOTENV_PRIVATE_KEY_DEV` sent to the collaborator; prod key kept private
- [ ] Release keystore base64'd into `.env.production`
- [ ] `.gitignore` hardened; gitleaks hook installed; GitHub push protection on
- [ ] Firebase: single project decided, Firestore created, TTL policy on `receipts`
- [ ] Cloudflare: KV namespaces created, secrets set, Worker deployed
- [ ] Smoke test passes, including the duplicate-batch assertion

**Collaborator onboarding**

- [ ] Both repos cloned side by side in one parent folder
- [ ] Toolchain per `LOCAL_SETUP_AND_RUN.md`; `flutter doctor` clean
- [ ] Debug SHA-1 registered in Firebase; refreshed `google-services.json` committed
- [ ] App builds and signs in on a physical device
- [ ] `DOTENV_PRIVATE_KEY_DEV` pasted into `backend/.env.keys`
- [ ] `npm run secrets` produces a working `.dev.vars`; `dotenvx get FIREBASE_PRIVATE_KEY -f .env.dev` prints the whole key
- [ ] `npm run typecheck && npm test` green in `backend/`
- [ ] Read `AGENTS.md`, `findings.md`, and `docs/DATA-AND-APP-FLOW.md`

**Before enabling ingest against production data**

- [ ] Fix 06 shipped — the band has a real body profile
- [ ] Fix 02 shipped and stable — dedup verified locally
- [ ] Duplicate-batch test passes against the deployed Worker
- [ ] Timezone offset captured at sample time, not upload time
- [ ] Steps buckets and cumulative counters demonstrably separated

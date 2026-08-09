# Onboarding a New Collaborator

For you, if you're joining this project. This is the one document you need —
it tells you what access to expect, how to get it, and how to know your setup
actually works before you touch real code.

**Companion documents**, for later — don't read these first:
- [`DATA-AND-APP-FLOW.md`](DATA-AND-APP-FLOW.md) — how the system fits together.
- [`PHASES.md`](PHASES.md) — what's being built right now, and what's next.
- [`SETUP-AND-WIRING.md`](SETUP-AND-WIRING.md) — the owner's infrastructure
  runbook. §2.2 there explains *why* access works the way it does below; this
  document is just the steps.

---

## What access you'll get

This project runs on the owner's real infrastructure — one Firebase project,
one Cloudflare account — not a separate sandbox per developer. You'll be able
to see real data, real logs, and real deploys, the same things the owner
sees. In exchange, the owner keeps a few things to themself: billing, IAM,
the production decryption key, and the Android release keystore. None of
those block you from building or testing anything.

| You get | You don't get |
|---|---|
| Firebase console access (**Editor** role) — Firestore data, Auth users, project settings | Firebase **Owner** role — billing, IAM, project deletion |
| Cloudflare account access — Worker logs, deploys, KV | Cloudflare account owner — billing, API token issuance |
| Write access to both GitHub repos | Admin on either repo |
| `DOTENV_PRIVATE_KEY_DEV` — decrypts `backend/.env.dev` for local secrets | `DOTENV_PRIVATE_KEY_PRODUCTION` — never leaves the owner |
| — | The Android release keystore — only the owner signs a Play release |

Full reasoning: [`backend/docs/05-DECISIONS.md` ADR-021](../backend/docs/05-DECISIONS.md#adr-021--collaborators-share-the-owners-project-they-dont-mint-their-own).

---

## Step 1 — The owner invites you (they do this, not you)

Before anything below works, the owner needs to:

1. **GitHub** — add you as a collaborator with write access on both repos
   (`pulse-hypr-app-be`, `pulse-hypr-test-app`/Flutter).
2. **Firebase** — [console.firebase.google.com](https://console.firebase.google.com)
   → project `hypr-8064c` → ⚙️ Project settings → **Users and permissions** →
   add your email with role **Editor**.
3. **Cloudflare** — dashboard → **Manage Account** → **Members** → invite your
   email. Grant Workers edit access on the `pulse-hypr-api` Worker.
4. **Send you `DOTENV_PRIVATE_KEY_DEV`** — one string, over Signal or
   similar, once. Not email, not Slack history.

You'll get email invites for GitHub, Firebase, and Cloudflare — accept all
three before continuing.

---

## Step 2 — Clone both repos side by side

```bash
mkdir pulse-hypr-test-app && cd pulse-hypr-test-app
git clone git@github.com:<owner>/pulse-hypr-app-be.git .
git clone git@github.com:IffatAhmedk/pulse-hypr-test-app.git flutter
git clone https://github.com/HBandSDK/Android_Ble_SDK.git    # reference, optional
```

## Step 3 — Toolchain

Follow [`flutter/LOCAL_SETUP_AND_RUN.md`](../flutter/LOCAL_SETUP_AND_RUN.md)
(Flutter SDK, Android Studio, JDK, emulator or device). Not duplicated here.
`flutter doctor` should be clean before you continue.

## Step 4 — The SHA-1 gotcha — read this before debugging sign-in

Google Sign-In on Android validates the app's signing certificate, and
**your debug keystore has a different SHA-1 than anyone else's.** Skip this
and `Sign in with Google` fails silently — usually a cancelled-looking
`GoogleSignInException` with no useful message.

```bash
cd flutter/android
./gradlew signingReport     # find the SHA1 under Variant: debug
```

You have Firebase **Editor** access now, so you can do this yourself:
Firebase console → Project settings → your Android app → **Add fingerprint**
→ paste your SHA-1. Then re-download `google-services.json` and **commit
it** — it gains an `oauth_client` entry per registered fingerprint, so every
developer's hash needs to be present in the committed copy.

Do this once per machine. It is the most common cause of "sign-in works for
the owner but not for me."

**Do not gitignore `google-services.json`, `GoogleService-Info.plist`, or
`firebase_options.dart`.** They're client identifiers that ship inside every
APK, not secrets — gitignoring them breaks the build for everyone else.

## Step 5 — Backend secrets

```bash
cd backend
echo "DOTENV_PRIVATE_KEY_DEV=<what the owner sent you>" >> .env.keys
npm install
npm run secrets              # decrypts .env.dev into .dev.vars
npx dotenvx get FIREBASE_PRIVATE_KEY -f .env.dev   # sanity check
# must print the WHOLE key, ending -----END PRIVATE KEY-----\n
npm run typecheck && npm test
```

If the key print looks truncated (just the `-----BEGIN...` line and nothing
after), stop and flag it — don't try to work around it. A previous attempt at
encrypting this exact key was silently corrupted by a Windows-specific tool
bug (see the Step 3 commit history in `backend/`); a truncated round-trip
here means something is broken upstream, not something to patch locally.

You're pointed at the owner's real deployed Worker and real Firestore data —
there's no separate sandbox to spin up.

## Step 6 — Hardware

| Item | Detail |
|---|---|
| Phone | Pixel 8 Pro (the device the BLE fixes were validated on) |
| Band | Veepoo KR96 PRO, pairing password `0000` |
| Band history window | 3 days (`watchDataDay`) |

⚠️ [`flutter/AGENTS.md`](../flutter/AGENTS.md) declares a **do-not-touch
zone** around `BandConnectionManager.kt` and the `BluetoothService` manifest
entry. Read it before touching Android BLE code — the constraints there
encode a reproduced device bug, not a style preference.

**Only one person can test BLE at a time.** Hardware-gated tasks (see
[`PHASES.md`](PHASES.md#hardware-gated-pull-in-whenever-the-precondition-is-available))
belong to whoever is physically holding the band.

---

## You're ready when

- [ ] Both repos cloned side by side in one parent folder
- [ ] `flutter doctor` clean
- [ ] Debug SHA-1 registered in Firebase; refreshed `google-services.json` committed
- [ ] App builds and signs in on a physical device
- [ ] `DOTENV_PRIVATE_KEY_DEV` in `backend/.env.keys`; `dotenvx get FIREBASE_PRIVATE_KEY -f .env.dev` prints the whole key
- [ ] `npm run typecheck && npm test` green in `backend/`
- [ ] You can see the `hypr-8064c` Firestore data and the `pulse-hypr-api` Worker's logs in their respective consoles

Then read, in order: [`flutter/AGENTS.md`](../flutter/AGENTS.md),
[`flutter/docs/findings.md`](../flutter/docs/findings.md),
[`DATA-AND-APP-FLOW.md`](DATA-AND-APP-FLOW.md), and
[`PHASES.md`](PHASES.md) to find what's actually being worked on right now.

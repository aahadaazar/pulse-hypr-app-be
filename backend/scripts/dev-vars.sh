#!/usr/bin/env bash
set -euo pipefail
{
  printf 'FIREBASE_CLIENT_EMAIL="%s"\n' "$(npx dotenvx get FIREBASE_CLIENT_EMAIL -f .env.dev)"
  printf 'FIREBASE_PRIVATE_KEY="%s"\n'  "$(npx dotenvx get FIREBASE_PRIVATE_KEY  -f .env.dev)"
} > .dev.vars
echo "wrote .dev.vars"

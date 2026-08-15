#!/usr/bin/env bash

# Starts the local Cloudflare Worker and the Vite dashboard as one development
# session. Ctrl+C stops both processes.
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$root_dir/backend"
web_dir="$root_dir/web"
api_base_url="${VITE_API_BASE_URL:-http://localhost:8787/v1}"
backend_pid=""
web_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  for pid in "$backend_pid" "$web_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$backend_pid" "$web_pid" 2>/dev/null || true
  exit "$status"
}

trap cleanup EXIT INT TERM

if ! command -v npm >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  printf '%s\n' 'npm is required. Install Node 20 or later, then run this script again.' >&2
  exit 1
fi

ensure_dependencies() {
  local service_name="$1"
  local service_dir="$2"
  local required_package="$3"

  if [[ -f "$service_dir/node_modules/$required_package/package.json" ]]; then
    return
  fi

  printf 'Installing %s dependencies (missing %s)...\n' "$service_name" "$required_package"
  if [[ -f "$service_dir/package-lock.json" ]]; then
    (cd "$service_dir" && npm ci)
  else
    (cd "$service_dir" && npm install)
  fi
}

ensure_dependencies 'backend' "$backend_dir" 'wrangler'
ensure_dependencies 'dashboard' "$web_dir" 'vite'

printf '%s\n' 'Starting Pulse Hypr local development…'
printf '  Worker:    http://localhost:8787\n'
printf '  Dashboard: http://localhost:5173\n'
printf '  API base:  %s\n' "$api_base_url"
printf '%s\n' 'Press Ctrl+C to stop both services.'

(cd "$backend_dir" && npm run dev) &
backend_pid=$!

(cd "$web_dir" && VITE_API_BASE_URL="$api_base_url" npm run dev) &
web_pid=$!

wait -n "$backend_pid" "$web_pid"

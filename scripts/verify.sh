#!/usr/bin/env bash

set -eu

scope="${1:-all}"
root_dir="$(git rev-parse --show-toplevel)"

validate_agent_evidence() {
  bash -n "$root_dir/scripts/verify.sh"
  python3 -m json.tool "$root_dir/.claude/settings.example.json" >/dev/null
  python3 -m json.tool "$root_dir/.mcp.json.example" >/dev/null

  for required_file in \
    AGENTS.md \
    CLAUDE.md \
    .claude/commands/verify.md \
    .claude/commands/review.md \
    docs/AGENTIC-ENGINEERING-WORKFLOW.md; do
    test -s "$root_dir/$required_file"
  done
}

verify_backend() {
  (
    cd "$root_dir/backend"
    npm run typecheck
    npm test
  )
}

verify_web() {
  (
    cd "$root_dir/web"
    npm run check
    npm run build
  )
}

verify_changed() {
  changed_files="$({
    git -C "$root_dir" diff --name-only
    git -C "$root_dir" diff --cached --name-only
    git -C "$root_dir" ls-files --others --exclude-standard
  } | sort -u)"

  validate_agent_evidence

  if printf '%s\n' "$changed_files" | grep -q '^backend/'; then
    verify_backend
  fi

  if printf '%s\n' "$changed_files" | grep -q '^web/'; then
    verify_web
  fi
}

case "$scope" in
  all)
    validate_agent_evidence
    verify_backend
    verify_web
    ;;
  changed)
    verify_changed
    ;;
  backend)
    verify_backend
    ;;
  web)
    verify_web
    ;;
  *)
    printf 'Usage: bash scripts/verify.sh [changed|all|backend|web]\n' >&2
    exit 2
    ;;
esac

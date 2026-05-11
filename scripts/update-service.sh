#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[UPDATE] %s\n' "$1"; }
fail() { printf '[UPDATE] ERROR: %s\n' "$1" >&2; exit 1; }

run_step() {
  local label="$1"
  shift
  log "Starting: ${label}"
  if "$@"; then
    log "Success: ${label}"
  else
    fail "Failed: ${label}"
  fi
}

log "Starting CafeScanner safe update from repo root: $ROOT_DIR"
DB_URL=$(awk -F= '/^DATABASE_URL=/{print $2}' .env 2>/dev/null | tr -d '"' || true)
if [[ "${DB_URL}" == file:* ]]; then
  DB_PATH="${DB_URL#file:}"
  mkdir -p backend/backups
  TS=$(date +%Y%m%d-%H%M%S)
  run_step "pre-update backup" cp "$DB_PATH" "backend/backups/cafescanner-pre-update-$TS.db"
fi

run_step "git pull" git pull --ff-only
run_step "npm install" npm install
run_step "npm run build" npm run build

if npm run | grep -q "db:migrate"; then
  run_step "npm run db:migrate" npm run db:migrate
else
  log "Skipping npm run db:migrate (script not defined)."
fi

run_step "restart cafescanner systemd service" sudo systemctl restart cafescanner
log "Update completed successfully. Database was not wiped, reset, or reseeded."

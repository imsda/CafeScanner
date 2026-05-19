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

check_repo_permissions() {
  local current_user current_uid non_owned_path owner owner_uid dist_dir parent_dir
  current_user="$(id -un)"
  current_uid="$(id -u)"

  non_owned_path=$(find "$ROOT_DIR" -mindepth 1 \! -uid "$current_uid" -print -quit)
  if [[ -n "${non_owned_path}" ]]; then
    owner="$(stat -c '%U' "$non_owned_path")"
    owner_uid="$(stat -c '%u' "$non_owned_path")"
    fail "Permission check failed: repository file is not owned by current user '${current_user}'. Path: ${non_owned_path} (owner: ${owner}, uid: ${owner_uid}). Ensure the service/update user owns repo files and avoid sudo/root builds."
  fi

  dist_dir="$ROOT_DIR/backend/dist"
  if [[ -e "$dist_dir" ]]; then
    if [[ ! -w "$dist_dir" ]]; then
      owner="$(stat -c '%U' "$dist_dir")"
      owner_uid="$(stat -c '%u' "$dist_dir")"
      fail "Permission check failed: build output directory is not writable. Path: ${dist_dir} (owner: ${owner}, uid: ${owner_uid}). Ensure the service/update user owns repo files and avoid sudo/root builds."
    fi
  else
    parent_dir="$ROOT_DIR/backend"
    if [[ ! -w "$parent_dir" ]]; then
      owner="$(stat -c '%U' "$parent_dir")"
      owner_uid="$(stat -c '%u' "$parent_dir")"
      fail "Permission check failed: cannot create build output directory ${dist_dir}. Parent path is not writable: ${parent_dir} (owner: ${owner}, uid: ${owner_uid}). Ensure the service/update user owns repo files and avoid sudo/root builds."
    fi
  fi
}

log "Starting CafeScanner safe update from repo root: $ROOT_DIR"
BACKEND_ENV_FILE="backend/.env"
PRISMA_SCHEMA_DIR="backend/prisma"
DB_URL=$(awk -F= '/^DATABASE_URL=/{print $2}' "$BACKEND_ENV_FILE" 2>/dev/null | tr -d '"' || true)

if [[ -z "${DB_URL}" ]]; then
  log "No DATABASE_URL found in ${BACKEND_ENV_FILE}; skipping database backup."
elif [[ "${DB_URL}" == file:* ]]; then
  DB_PATH_RAW="${DB_URL#file:}"

  if [[ "$DB_PATH_RAW" = /* ]]; then
    DB_PATH="$DB_PATH_RAW"
  else
    DB_PATH="${PRISMA_SCHEMA_DIR}/${DB_PATH_RAW}"
  fi

  DB_PATH=$(python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$DB_PATH")
  log "Resolved SQLite DB path: ${DB_PATH}"

  mkdir -p backend/backups
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_PREFIX="backend/backups/cafescanner-pre-update-$TS"

  if [[ -f "$DB_PATH" ]]; then
    run_step "pre-update backup (.db)" cp "$DB_PATH" "${BACKUP_PREFIX}.db"

    if [[ -f "${DB_PATH}-wal" ]]; then
      run_step "pre-update backup (.db-wal)" cp "${DB_PATH}-wal" "${BACKUP_PREFIX}.db-wal"
    else
      log "No WAL file found at ${DB_PATH}-wal; skipping WAL backup."
    fi

    if [[ -f "${DB_PATH}-shm" ]]; then
      run_step "pre-update backup (.db-shm)" cp "${DB_PATH}-shm" "${BACKUP_PREFIX}.db-shm"
    else
      log "No SHM file found at ${DB_PATH}-shm; skipping SHM backup."
    fi
  else
    log "WARNING: SQLite DB file not found at ${DB_PATH}; continuing update without backup."
  fi
else
  log "DATABASE_URL is not SQLite file-based; skipping database backup."
fi

run_step "git pull" git pull --ff-only
run_step "npm install" npm install
run_step "permission diagnostics before build" check_repo_permissions
run_step "npm run build" npm run build

if npm run | grep -q "db:migrate"; then
  run_step "npm run db:migrate" npm run db:migrate
else
  log "Skipping npm run db:migrate (script not defined)."
fi

run_step "restart cafescanner systemd service" sudo systemctl restart cafescanner
log "Update completed successfully. Database was not wiped, reset, or reseeded."

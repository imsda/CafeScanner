#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[UPDATE] %s\n' "$1"; }
fail() { printf '[UPDATE] ERROR: %s\n' "$1" >&2; exit 1; }

ensure_arm64_rollup_compat() {
  # npm can skip optional platform packages, which may leave ARM64 Linux
  # missing Rollup's native binary package after install/update operations.
  if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "aarch64" ]]; then
    local rollup_arm64_pkg_dir="$ROOT_DIR/node_modules/@rollup/rollup-linux-arm64-gnu"
    if [[ ! -d "$rollup_arm64_pkg_dir" ]]; then
      log "ARM64 Rollup dependency missing; installing compatibility package."
      npm install @rollup/rollup-linux-arm64-gnu --save-dev
    fi
  fi
}

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

show_tracked_status() {
  local tracked_status
  tracked_status="$(git status --porcelain --untracked-files=no || true)"

  if [[ -n "$tracked_status" ]]; then
    log "Git tracked status (modified tracked files detected):"
    printf '%s\n' "$tracked_status"
  else
    log "Git tracked status: clean (no modified tracked files)."
  fi
}

ensure_clean_tracked_files() {
  log "Checking git status for tracked-file modifications (untracked/ignored runtime files are safe)."
  show_tracked_status

  if ! git diff --quiet || [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    fail "Update blocked: tracked git files are modified. Commit/stash/revert these tracked file changes before updating."
  fi

  log "No tracked-file modifications detected. Proceeding with update; untracked/ignored runtime files are safe."
}

remove_build_output() {
  local target="$1"

  if [[ ! -e "$target" ]]; then
    log "Cleanup skip: ${target} does not exist."
    return 0
  fi

  if rm -rf "$target"; then
    log "Cleanup removed: ${target}"
    return 0
  fi

  local owner permissions
  owner="$(stat -c '%U:%G' "$target" 2>/dev/null || echo 'unknown')"
  permissions="$(stat -c '%A' "$target" 2>/dev/null || echo 'unknown')"
  fail "Failed to remove build output. Path: ${target}. Owner: ${owner}. Permissions: ${permissions}. Suggested fix: sudo chown -R service-user:service-user repo"
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

SERVICE_STOPPED=0

ensure_service_started_on_exit() {
  if [[ "$SERVICE_STOPPED" -eq 1 ]]; then
    log "Starting service after failure (trap): cafescanner"
    if sudo systemctl start cafescanner; then
      log "Service started successfully in failure trap."
    else
      log "ERROR: Failed to start cafescanner in failure trap. Manual intervention required."
    fi
  fi
}

trap ensure_service_started_on_exit EXIT

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

run_step "validate tracked git status before pull" ensure_clean_tracked_files
run_step "git pull" git pull --ff-only
run_step "npm install" npm install
run_step "ensure ARM64 Rollup compatibility dependency" ensure_arm64_rollup_compat
run_step "permission diagnostics before build" check_repo_permissions
log "Cleaning build artifacts before build (preserving runtime data such as backend/prisma/prisma)."
run_step "cleanup backend/dist" remove_build_output "$ROOT_DIR/backend/dist"
run_step "cleanup frontend/dist" remove_build_output "$ROOT_DIR/frontend/dist"
run_step "cleanup backend/tsconfig.tsbuildinfo" remove_build_output "$ROOT_DIR/backend/tsconfig.tsbuildinfo"
run_step "cleanup frontend/tsconfig.tsbuildinfo" remove_build_output "$ROOT_DIR/frontend/tsconfig.tsbuildinfo"
run_step "npm run build" npm run build

if npm run | grep -q "db:migrate"; then
  log "Stopping service: cafescanner"
  run_step "stop cafescanner systemd service" sudo systemctl stop cafescanner
  SERVICE_STOPPED=1

  log "Migration starting: npm run db:migrate"
  if npm run db:migrate; then
    log "Migration success: npm run db:migrate"
  else
    log "Migration failure: npm run db:migrate"
    exit 1
  fi

  log "Starting service: cafescanner"
  run_step "start cafescanner systemd service" sudo systemctl start cafescanner
  SERVICE_STOPPED=0
else
  log "Skipping npm run db:migrate (script not defined)."
fi

trap - EXIT
log "Update completed successfully. Database was not wiped, reset, or reseeded."

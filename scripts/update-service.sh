#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[UPDATE] %s\n' "$1"; }
fail() { printf '[UPDATE] ERROR: %s\n' "$1" >&2; exit 1; }
git_safe() { timeout 30 git "$@"; }

ARCHITECTURE="$(uname -m)"

# Running the whole update with sudo leaves root-owned backups, node_modules and build
# output in the repo, which makes later updates by the service user fail. The script
# already uses sudo itself for the systemctl steps. Set ALLOW_ROOT_UPDATE=1 only if the
# service genuinely runs as root.
if [[ "${EUID}" -eq 0 && "${ALLOW_ROOT_UPDATE:-0}" != "1" ]]; then
  fail "Do not run this script with sudo or as root. Run it as the service user (e.g. ./scripts/update-service.sh); it asks for sudo only to stop/start the service. If the service runs as root, set ALLOW_ROOT_UPDATE=1."
fi

is_linux_arm64() {
  [[ "$(uname -s)" == "Linux" && ( "$ARCHITECTURE" == "aarch64" || "$ARCHITECTURE" == "arm64" ) ]]
}

ensure_arm64_rollup_compat() {
  # npm can skip optional platform packages, which may leave ARM64 Linux
  # missing Rollup's native binary package after install/update operations.
  # We use --no-save so package.json/package-lock.json are not modified by
  # updater/install scripts; this is a runtime compatibility fix only.
  if is_linux_arm64; then
    log "ARM64 detected; ensuring Rollup native dependency exists."
    npm install --no-save @rollup/rollup-linux-arm64-gnu || fail "Failed to install @rollup/rollup-linux-arm64-gnu on ARM64. Aborting update before build cleanup."
  fi
}

verify_build_dependencies() {
  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    fail "Build dependencies are missing (node_modules not found). Run npm install before updating."
  fi

  if is_linux_arm64; then
    local rollup_arm64_pkg_dir="$ROOT_DIR/node_modules/@rollup/rollup-linux-arm64-gnu"
    if [[ ! -d "$rollup_arm64_pkg_dir" ]]; then
      fail "ARM64 Rollup native dependency is still missing after installation attempt. Aborting before frontend/dist cleanup."
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

diagnostics() {
  log "User: $(id -un)"
  log "UID/GID: $(id -u)/$(id -g)"
  log "HOME: ${HOME:-<unset>}"
  log "PWD: $(pwd)"
  log "Architecture: ${ARCHITECTURE}"
  log "Branch: $(git_safe branch --show-current 2>/dev/null || echo '<unknown>')"
  log "SSH binary: $(command -v ssh || echo '<missing>')"
  log "Git remotes:"
  git_safe remote -v | sed 's/^/[UPDATE]   /'
}

run_git_pull_with_timeout() {
  local pull_output pull_status
  pull_output="$(
    timeout 60 bash -c '
      set -euo pipefail
      export GIT_TERMINAL_PROMPT=0
      export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2"
      git pull --ff-only
    ' 2>&1
  )"
  pull_status=$?
  printf '%s\n' "$pull_output"
  return "$pull_status"
}

handle_git_pull_failure_reason() {
  local output="$1"
  if grep -q "Permission denied (publickey)" <<<"$output"; then
    fail "SSH authentication failed."
  fi
  if grep -qi "Connection timed out" <<<"$output"; then
    fail "GitHub unreachable."
  fi
  if grep -q "Host key verification failed" <<<"$output"; then
    fail "GitHub host key trust issue."
  fi
}

run_git_pull_with_retry() {
  local pull_output
  if pull_output="$(run_git_pull_with_timeout)"; then
    printf '%s\n' "$pull_output"
    return 0
  fi

  printf '%s\n' "$pull_output"
  log "git pull failed; retrying in 5 seconds..."
  sleep 5

  if pull_output="$(run_git_pull_with_timeout)"; then
    printf '%s\n' "$pull_output"
    return 0
  fi

  printf '%s\n' "$pull_output"
  handle_git_pull_failure_reason "$pull_output"
  fail "git pull failed after 2 attempts."
}

show_tracked_status() {
  local tracked_status
  tracked_status="$(git_safe status --porcelain --untracked-files=no || true)"

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

  if ! git_safe diff --quiet || [[ -n "$(git_safe status --porcelain --untracked-files=no)" ]]; then
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

# In-app mode (Settings → Updates) is started by the running service, so it must not stop
# that service: systemd would kill this script with it. It migrates while the app is up and
# finishes with a single restart. Terminal runs keep the safer stop → migrate → start order.
IN_APP_UPDATE="${CAFESCANNER_IN_APP_UPDATE:-0}"
KEEP_PRE_UPDATE_BACKUPS=10

log "Starting CafeScanner safe update from repo root: $ROOT_DIR"
log "Architecture detected: ${ARCHITECTURE}"
diagnostics

if [[ "$IN_APP_UPDATE" == "1" ]]; then
  log "Mode: in-app update (migrate, then restart the service)."
  if ! sudo -n -l systemctl restart cafescanner >/dev/null 2>&1; then
    fail "In-app updates need passwordless sudo for 'systemctl restart cafescanner'. Run ./scripts/update-service.sh from a terminal instead, or add the sudoers rule described in the README."
  fi
fi

# Writes a consistent snapshot of a live (WAL-mode) SQLite database using VACUUM INTO.
snapshot_sqlite_db() {
  node -e '
    const sqlite3 = require("sqlite3");
    const [source, target] = process.argv.slice(1);
    const db = new sqlite3.Database(source, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) { console.error(openError.message); process.exit(1); }
      db.run("PRAGMA busy_timeout = 10000", () => {
        db.run("VACUUM INTO ?", [target], (error) => {
          if (error) { console.error(error.message); process.exit(1); }
          db.close(() => process.exit(0));
        });
      });
    });
  ' "$1" "$2"
}

# Keeps only the newest pre-update backups so the backups folder cannot grow without limit.
prune_pre_update_backups() {
  local old_backup
  while IFS= read -r old_backup; do
    [[ -n "$old_backup" ]] || continue
    rm -f -- "$old_backup" "${old_backup}-wal" "${old_backup}-shm"
    log "Removed old pre-update backup: ${old_backup}"
  done < <(ls -1t backend/backups/cafescanner-pre-update-*.db 2>/dev/null | tail -n "+$((KEEP_PRE_UPDATE_BACKUPS + 1))")
}

BACKEND_ENV_FILE="backend/.env"
PRISMA_SCHEMA_DIR="backend/prisma"
# Everything after the first "=" is the value; drop quotes and any ?query (e.g. ?connection_limit=1).
DB_URL=$(sed -n 's/^DATABASE_URL=//p' "$BACKEND_ENV_FILE" 2>/dev/null | head -n 1 | tr -d "\"'" || true)
DB_URL="${DB_URL%%\?*}"

if [[ -z "${DB_URL}" ]]; then
  log "No DATABASE_URL found in ${BACKEND_ENV_FILE}; skipping database backup."
elif [[ "${DB_URL}" == file:* ]]; then
  DB_PATH_RAW="${DB_URL#file:}"

  if [[ "$DB_PATH_RAW" = /* ]]; then
    DB_PATH="$DB_PATH_RAW"
  else
    DB_PATH="${PRISMA_SCHEMA_DIR}/${DB_PATH_RAW}"
  fi

  DB_PATH=$(realpath -m --relative-to="$ROOT_DIR" "$DB_PATH")
  log "Resolved SQLite DB path: ${DB_PATH}"

  mkdir -p backend/backups
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_FILE="backend/backups/cafescanner-pre-update-$TS.db"

  if [[ -f "$DB_PATH" ]]; then
    log "Starting: pre-update backup (consistent snapshot)"
    if snapshot_sqlite_db "$DB_PATH" "$BACKUP_FILE" && [[ -s "$BACKUP_FILE" ]]; then
      log "Success: pre-update backup written to ${BACKUP_FILE}"
    else
      # Fallback when the sqlite3 module is not installed yet: copy the database and its WAL files.
      log "Snapshot unavailable; falling back to copying the database files."
      rm -f "$BACKUP_FILE"
      run_step "pre-update backup (.db)" cp "$DB_PATH" "$BACKUP_FILE"
      [[ -f "${DB_PATH}-wal" ]] && run_step "pre-update backup (.db-wal)" cp "${DB_PATH}-wal" "${BACKUP_FILE}-wal"
      [[ -f "${DB_PATH}-shm" ]] && run_step "pre-update backup (.db-shm)" cp "${DB_PATH}-shm" "${BACKUP_FILE}-shm"
    fi
    [[ -s "$BACKUP_FILE" ]] || fail "Pre-update backup was not created. Update aborted before changing anything."
    prune_pre_update_backups
  else
    fail "SQLite DB file not found at ${DB_PATH}. Check DATABASE_URL in ${BACKEND_ENV_FILE}. Update aborted before changing anything."
  fi
else
  log "DATABASE_URL is not SQLite file-based; skipping database backup."
fi

run_step "validate tracked git status before pull" ensure_clean_tracked_files
run_step "git pull" run_git_pull_with_retry
# npm ci installs exactly what package-lock.json lists and never rewrites it, so an update
# cannot leave a modified tracked file behind that blocks the next update.
run_step "npm ci" npm ci
run_step "ensure ARM64 Rollup compatibility dependency" ensure_arm64_rollup_compat
run_step "permission diagnostics before build" check_repo_permissions
run_step "verify build dependencies before cleanup" verify_build_dependencies

# Build without taking the running site down: the backend compiles over backend/dist only if
# TypeScript succeeds (noEmitOnError), and the frontend is built into a staging folder that
# replaces frontend/dist in one step, so pages keep loading during the build.
FRONTEND_DIST_DIR="$ROOT_DIR/frontend/dist"
FRONTEND_DIST_NEXT_DIR="$ROOT_DIR/frontend/dist.next"
FRONTEND_DIST_OLD_DIR="$ROOT_DIR/frontend/dist.old"

run_step "cleanup build caches" rm -rf "$ROOT_DIR/backend/tsconfig.tsbuildinfo" "$ROOT_DIR/frontend/tsconfig.tsbuildinfo" "$FRONTEND_DIST_NEXT_DIR" "$FRONTEND_DIST_OLD_DIR" "$ROOT_DIR/frontend/dist.pre-update-backup"
run_step "build backend" npm run build -w backend
if ! npm run build -w frontend -- --outDir dist.next --emptyOutDir; then
  rm -rf "$FRONTEND_DIST_NEXT_DIR"
  fail "Frontend build failed. The previous frontend is still in place; update aborted."
fi
[[ -f "$FRONTEND_DIST_NEXT_DIR/index.html" ]] || fail "Frontend build produced no index.html. The previous frontend is still in place; update aborted."
if [[ -d "$FRONTEND_DIST_DIR" ]]; then
  mv "$FRONTEND_DIST_DIR" "$FRONTEND_DIST_OLD_DIR"
fi
mv "$FRONTEND_DIST_NEXT_DIR" "$FRONTEND_DIST_DIR"
rm -rf "$FRONTEND_DIST_OLD_DIR"
log "Success: build (frontend swapped into place)"

if [[ "$IN_APP_UPDATE" == "1" ]]; then
  run_step "database migrations (npm run db:migrate)" npm run db:migrate
  trap - EXIT
  log "Update completed successfully. Database was not wiped, reset, or reseeded."
  log "Summary: git pull, build and migrations succeeded. Restarting the service now."
  log "UPDATE_RESULT=success"
  # The restart ends this script along with the old service process; nothing may follow it.
  sudo -n systemctl restart cafescanner
  exit 0
fi

log "Stopping service: cafescanner"
run_step "stop cafescanner systemd service" sudo systemctl stop cafescanner
SERVICE_STOPPED=1

run_step "database migrations (npm run db:migrate)" npm run db:migrate

log "Starting service: cafescanner"
run_step "start cafescanner systemd service" sudo systemctl start cafescanner
SERVICE_STOPPED=0

trap - EXIT
log "Update completed successfully. Database was not wiped, reset, or reseeded."
log "Summary:"
log "- git pull: success"
log "- build: success"
log "- migrations: success"
log "- restart: success"
log "UPDATE_RESULT=success"

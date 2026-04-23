#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_MAJOR="${MIN_NODE_MAJOR:-20}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() {
  echo "[setup] $*"
}

fail() {
  echo "[setup] ERROR: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

apt_install_packages() {
  local packages=("$@")

  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" && "${ID_LIKE:-}" != *"debian"* ]]; then
      fail "Automatic package installation currently supports Ubuntu/Debian only. Please install manually: ${packages[*]}"
    fi
  fi

  if ! command_exists apt-get; then
    fail "apt-get not found. Install these manually: ${packages[*]}"
  fi

  local apt_cmd=()
  if [[ "${EUID}" -eq 0 ]]; then
    apt_cmd=(apt-get)
  elif command_exists sudo; then
    apt_cmd=(sudo apt-get)
  else
    fail "sudo is required to install missing dependencies. Install sudo or run this script as root. Missing packages: ${packages[*]}"
  fi

  log "Installing packages via apt: ${packages[*]}"
  "${apt_cmd[@]}" update -y
  "${apt_cmd[@]}" install -y "${packages[@]}"
}

ensure_openssl() {
  if command_exists openssl; then
    log "openssl already installed: $(openssl version | awk '{ print $2 }')"
    return
  fi

  log "Missing dependency: openssl"
  apt_install_packages openssl

  if ! command_exists openssl; then
    fail "openssl installation failed. Please run: sudo apt-get install -y openssl"
  fi

  log "Installed openssl: $(openssl version | awk '{ print $2 }')"
}

setup_nodesource_repo() {
  local apt_cmd=()
  if [[ "${EUID}" -eq 0 ]]; then
    apt_cmd=(apt-get)
  else
    apt_cmd=(sudo apt-get)
  fi

  "${apt_cmd[@]}" install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings

  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    chmod 0644 /etc/apt/keyrings/nodesource.gpg
  fi

  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
}

ensure_node_toolchain() {
  local needs_install=0

  if command_exists node; then
    local node_version
    node_version="$(node --version)"
    local node_major
    node_major="${node_version#v}"
    node_major="${node_major%%.*}"

    if (( node_major < MIN_NODE_MAJOR )); then
      log "Node.js is too old (${node_version}). Need >= v${MIN_NODE_MAJOR}.x"
      needs_install=1
    else
      log "Node.js already installed: ${node_version}"
    fi
  else
    log "Missing dependency: node"
    needs_install=1
  fi

  if ! command_exists npm; then
    log "Missing dependency: npm"
    needs_install=1
  fi

  if ! command_exists npx; then
    log "Missing dependency: npx"
    needs_install=1
  fi

  if (( needs_install == 0 )); then
    log "npm already installed: $(npm --version)"
    log "npx already installed: $(npx --version)"
    return
  fi

  log "Installing Node.js toolchain (NodeSource Node ${NODE_MAJOR}.x)"
  setup_nodesource_repo

  local apt_cmd=()
  if [[ "${EUID}" -eq 0 ]]; then
    apt_cmd=(apt-get)
  elif command_exists sudo; then
    apt_cmd=(sudo apt-get)
  else
    fail "sudo is required to install Node.js. Install sudo or run this script as root."
  fi

  "${apt_cmd[@]}" update -y
  "${apt_cmd[@]}" install -y nodejs

  command_exists node || fail "Node.js installation failed. Try: curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs"
  command_exists npm || fail "npm installation failed with Node.js package."
  command_exists npx || fail "npx installation failed with Node.js package."

  log "Installed Node.js: $(node --version)"
  log "Installed npm: $(npm --version)"
  log "Installed npx: $(npx --version)"
}

check_required_tools() {
  log "Checking required app dependencies"
  ensure_node_toolchain
  ensure_openssl
}

bootstrap_env_file() {
  local env_file="$1"
  local example_file="$2"

  if [[ -f "$env_file" ]]; then
    return
  fi

  if [[ -f "$example_file" ]]; then
    cp "$example_file" "$env_file"
    log "Auto-created $env_file from $example_file"
  fi
}

env_has_key() {
  local env_file="$1"
  local key="$2"

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ || $0 !~ /=/ { next }
    {
      rawKey=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", rawKey)
      if (rawKey == key) {
        found=1
        exit
      }
    }
    END {
      if (found) {
        exit 0
      }
      exit 1
    }
  ' "$env_file"
}

merge_missing_env_keys() {
  local env_file="$1"
  local example_file="$2"

  if [[ ! -f "$env_file" || ! -f "$example_file" ]]; then
    return
  fi

  local line
  local key
  local added=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"

    [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue

    if env_has_key "$env_file" "$key"; then
      continue
    fi

    if (( added == 0 )) && [[ -s "$env_file" ]]; then
      printf '\n' >> "$env_file"
    fi

    printf '%s\n' "$line" >> "$env_file"
    log "Added missing env variable: ${key}"
    added=1
  done < "$example_file"
}

env_get_value() {
  local env_file="$1"
  local key="$2"

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ || $0 !~ /=/ { next }
    {
      rawKey=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", rawKey)
      if (rawKey != key) {
        next
      }

      rawValue=substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", rawValue)

      if ((rawValue ~ /^".*"$/) || (rawValue ~ /^'"'"'.*'"'"'$/)) {
        rawValue=substr(rawValue, 2, length(rawValue) - 2)
      }

      print rawValue
      found=1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  ' "$env_file"
}

set_generated_value_if_placeholder() {
  local env_file="$1"
  local key="$2"
  local placeholder="$3"
  local generated="$4"

  local current
  if ! current="$(env_get_value "$env_file" "$key" 2>/dev/null)"; then
    return
  fi

  if [[ "$current" != "$placeholder" ]]; then
    return
  fi

  local escaped
  escaped=$(printf '%s' "$generated" | sed -e 's/[\\&/]/\\&/g')
  sed -i "s|^${key}=.*|${key}=\"${escaped}\"|" "$env_file"
  log "Generated a secure default for ${key} in ${env_file}"
}

is_sqlite_database_url() {
  local database_url="$1"
  [[ "$database_url" == file:* ]]
}

resolve_sqlite_db_path() {
  local database_url="$1"
  local sqlite_target="${database_url#file:}"

  if [[ "$sqlite_target" == /* ]]; then
    printf '%s\n' "$sqlite_target"
    return
  fi

  printf '%s\n' "backend/${sqlite_target#./}"
}

run_prisma_status_check() {
  log "Checking Prisma migration status"

  if npm run db:status; then
    return
  fi

  cat <<'EOM'
[setup] ERROR: Prisma migration history does not match the current database state.
[setup] This usually means a migration file was changed after being applied, or migration history diverged across clones.
[setup] Refusing to continue because automatic reset would destroy existing operational data.
[setup] Required fix: restore migration history consistency in the repository and add a NEW migration for new schema changes.
[setup] Do NOT edit already-applied migration files and do NOT use prisma migrate reset for normal pulls.
EOM
  exit 1
}

run_prisma_deploy() {
  log "Applying Prisma migrations (non-destructive deploy mode)"

  if npm run db:migrate; then
    return
  fi

  cat <<'EOM'
[setup] ERROR: Failed to apply Prisma migrations in deploy mode.
[setup] Existing data has NOT been deleted.
[setup] Likely cause: repository migration history diverged from this database.
[setup] Required fix: repair migration files at the repository level and add forward-only migrations.
EOM
  exit 1
}

is_placeholder_value() {
  local value="$1"

  shopt -s nocasematch
  if [[ "$value" =~ ^(change[-_]?me.*|replace[-_]?me.*|replace_this.*|your[_-].*|example.*|placeholder.*|todo.*|setme.*)$ ]]; then
    shopt -u nocasematch
    return 0
  fi
  shopt -u nocasematch

  [[ "$value" == *"<"*">"* ]]
}

validate_required_env_vars() {
  local env_file="$1"
  local example_file="$2"

  if [[ ! -f "$example_file" ]]; then
    return 0
  fi

  if [[ ! -f "$env_file" ]]; then
    fail "Missing required env file '$env_file'. Please create or edit $env_file."
  fi

  local missing_keys=()
  local placeholder_keys=()
  local key

  while IFS= read -r key; do
    [[ -z "$key" ]] && continue

    local env_value
    local example_value

    if ! env_value="$(env_get_value "$env_file" "$key" 2>/dev/null)"; then
      missing_keys+=("$key")
      continue
    fi

    if [[ -z "$env_value" ]]; then
      missing_keys+=("$key")
      continue
    fi

    if example_value="$(env_get_value "$example_file" "$key" 2>/dev/null)"; then
      if [[ "$env_value" == "$example_value" ]] && is_placeholder_value "$example_value"; then
        placeholder_keys+=("$key")
      fi
    fi
  done < <(awk -F= '
    /^[[:space:]]*#/ || $0 !~ /=/ { next }
    {
      key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key ~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
        print key
      }
    }
  ' "$example_file")

  if (( ${#missing_keys[@]} > 0 )); then
    log "ERROR: Missing required env variable values in $env_file:"
    for missing_key in "${missing_keys[@]}"; do
      echo "  - $missing_key"
    done
    fail "Please edit $env_file and set the missing values."
  fi

  if (( ${#placeholder_keys[@]} > 0 )); then
    log "ERROR: Placeholder values are still present in $env_file:"
    for placeholder_key in "${placeholder_keys[@]}"; do
      echo "  - $placeholder_key"
    done
    fail "Please replace placeholder values before continuing."
  fi
}

check_required_tools

log "Bootstrapping environment files"
bootstrap_env_file "backend/.env" "backend/.env.example"
bootstrap_env_file "frontend/.env" "frontend/.env.example"
merge_missing_env_keys "backend/.env" "backend/.env.example"
merge_missing_env_keys "frontend/.env" "frontend/.env.example"

set_generated_value_if_placeholder "backend/.env" "SESSION_SECRET" "change-me-super-secret" "$(openssl rand -hex 32)"

log "Validating environment values"
validate_required_env_vars "backend/.env" "backend/.env.example"
validate_required_env_vars "frontend/.env" "frontend/.env.example"

database_url="$(env_get_value "backend/.env" "DATABASE_URL")"

log "Installing npm dependencies (root + workspaces)"
npm install --workspaces --include-workspace-root

if is_sqlite_database_url "$database_url"; then
  sqlite_db_path="$(resolve_sqlite_db_path "$database_url")"

  if [[ -f "$sqlite_db_path" ]]; then
    log "Existing SQLite database detected at ${sqlite_db_path}. Preserving data and validating migration history."
    run_prisma_status_check
  else
    log "No existing SQLite database found at ${sqlite_db_path}. A new database will be created."
  fi
else
  log "Non-SQLite DATABASE_URL detected; running migration status check before deploy."
  run_prisma_status_check
fi

run_prisma_deploy
run_prisma_status_check

log "Seeding database"
npm run db:seed

log "Running full build"
npm run build

log "Setup complete"

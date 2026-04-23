#!/usr/bin/env bash
set -euo pipefail

bootstrap_env_file() {
  local env_file="$1"
  local example_file="$2"

  if [[ -f "$env_file" ]]; then
    return
  fi

  if [[ -f "$example_file" ]]; then
    cp "$example_file" "$env_file"
    echo "[setup] Auto-created $env_file from $example_file"
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
    echo "[setup] Added missing env variable: ${key}"
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
  echo "[setup] Generated a secure default for ${key} in ${env_file}"
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
  echo "[setup] Checking Prisma migration status"

  if npm run db:status; then
    return
  fi

  cat <<'EOF'
[setup] ERROR: Prisma migration history does not match the current database state.
[setup] This usually means a migration file was changed after being applied, or migration history diverged across clones.
[setup] Refusing to continue because automatic reset would destroy existing operational data.
[setup] Required fix: restore migration history consistency in the repository and add a NEW migration for new schema changes.
[setup] Do NOT edit already-applied migration files and do NOT use prisma migrate reset for normal pulls.
EOF
  exit 1
}

run_prisma_deploy() {
  echo "[setup] Applying Prisma migrations (non-destructive deploy mode)"

  if npm run db:migrate; then
    return
  fi

  cat <<'EOF'
[setup] ERROR: Failed to apply Prisma migrations in deploy mode.
[setup] Existing data has NOT been deleted.
[setup] Likely cause: repository migration history diverged from this database.
[setup] Required fix: repair migration files at the repository level and add forward-only migrations.
EOF
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
    echo "[setup] ERROR: Missing required env file '$env_file'."
    echo "[setup] Please create or edit $env_file."
    exit 1
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
    echo "[setup] ERROR: Missing required env variable values in $env_file:"
    for missing_key in "${missing_keys[@]}"; do
      echo "  - $missing_key"
    done
    echo "[setup] Please edit $env_file and set the missing values."
    exit 1
  fi

  if (( ${#placeholder_keys[@]} > 0 )); then
    echo "[setup] ERROR: Placeholder values are still present in $env_file:"
    for placeholder_key in "${placeholder_keys[@]}"; do
      echo "  - $placeholder_key"
    done
    echo "[setup] Please replace placeholder values before continuing."
    exit 1
  fi
}

echo "[setup] Bootstrapping environment files"
bootstrap_env_file "backend/.env" "backend/.env.example"
bootstrap_env_file "frontend/.env" "frontend/.env.example"
merge_missing_env_keys "backend/.env" "backend/.env.example"
merge_missing_env_keys "frontend/.env" "frontend/.env.example"

set_generated_value_if_placeholder "backend/.env" "SESSION_SECRET" "change-me-super-secret" "$(openssl rand -hex 32)"

echo "[setup] Validating environment values"
validate_required_env_vars "backend/.env" "backend/.env.example"
validate_required_env_vars "frontend/.env" "frontend/.env.example"

database_url="$(env_get_value "backend/.env" "DATABASE_URL")"

echo "[setup] Installing npm dependencies (root + workspaces)"
npm install --workspaces --include-workspace-root

if is_sqlite_database_url "$database_url"; then
  sqlite_db_path="$(resolve_sqlite_db_path "$database_url")"

  if [[ -f "$sqlite_db_path" ]]; then
    echo "[setup] Existing SQLite database detected at ${sqlite_db_path}. Preserving data and validating migration history."
    run_prisma_status_check
  else
    echo "[setup] No existing SQLite database found at ${sqlite_db_path}. A new database will be created."
  fi
else
  echo "[setup] Non-SQLite DATABASE_URL detected; running migration status check before deploy."
  run_prisma_status_check
fi

run_prisma_deploy
run_prisma_status_check

echo "[setup] Seeding database"
npm run db:seed

echo "[setup] Running full build"
npm run build

echo "[setup] Setup complete"

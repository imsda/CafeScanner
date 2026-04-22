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

echo "[setup] Installing npm dependencies (root + workspaces)"
npm install --workspaces --include-workspace-root

echo "[setup] Running database migrations"
npm run db:migrate

echo "[setup] Seeding database"
npm run db:seed

echo "[setup] Running full build"
npm run build

echo "[setup] Setup complete"

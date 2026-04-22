#!/usr/bin/env bash
set -euo pipefail

bootstrap_env_file() {
  local env_file="$1"
  local example_file="$2"

  if [[ ! -f "$env_file" && -f "$example_file" ]]; then
    cp "$example_file" "$env_file"
    echo "[setup] Auto-created $env_file from $example_file"
  fi
}

env_key_has_value() {
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

      if ((rawValue ~ /^".*"$/) || (rawValue ~ /^'.*'$/)) {
        rawValue=substr(rawValue, 2, length(rawValue) - 2)
      }

      if (length(rawValue) > 0) {
        found=1
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$env_file"
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
  local key

  while IFS= read -r key; do
    [[ -z "$key" ]] && continue

    if ! env_key_has_value "$env_file" "$key"; then
      missing_keys+=("$key")
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
}

bootstrap_env_file ".env" ".env.example"
bootstrap_env_file "backend/.env" "backend/.env.example"

validate_required_env_vars ".env" ".env.example"
validate_required_env_vars "backend/.env" "backend/.env.example"

npm install
npm run db:migrate
npm run db:seed
npm run build

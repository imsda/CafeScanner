#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER:-manager}}"
ARCHITECTURE="$(uname -m)"

if [[ -z "${SERVICE_USER}" ]]; then
  SERVICE_USER="manager"
fi

echo "Using project root: ${PROJECT_ROOT}"
echo "Using service user: ${SERVICE_USER}"
echo "[UPDATE] Architecture detected: ${ARCHITECTURE}"

run_step() {
  local label="$1"
  shift
  echo "[UPDATE] Starting: ${label}"
  if "$@"; then
    echo "[UPDATE] Success: ${label}"
  else
    echo "[UPDATE] ERROR: Failed: ${label}" >&2
    exit 1
  fi
}

is_linux_arm64() {
  [[ "$(uname -s)" == "Linux" && ( "$ARCHITECTURE" == "aarch64" || "$ARCHITECTURE" == "arm64" ) ]]
}

ensure_arm64_rollup_compat() {
  # npm can skip optional platform packages, which may leave ARM64 Linux
  # missing Rollup's native binary package after install/update operations.
  # We use --no-save so package.json/package-lock.json are not modified by
  # updater/install scripts; this is a runtime compatibility fix only.
  if is_linux_arm64; then
    echo "[UPDATE] ARM64 detected; ensuring Rollup native dependency exists."
    npm install --no-save @rollup/rollup-linux-arm64-gnu || {
      echo "[UPDATE] ERROR: Failed to install @rollup/rollup-linux-arm64-gnu on ARM64." >&2
      exit 1
    }
  fi
}

run_step "npm install" npm install
run_step "ensure ARM64 Rollup compatibility dependency" ensure_arm64_rollup_compat

echo "Building full app for production (frontend + backend)..."
npm run build

SERVICE_FILE="/etc/systemd/system/cafescanner.service"

echo "Writing systemd service file to ${SERVICE_FILE}..."
sudo tee "${SERVICE_FILE}" > /dev/null <<SERVICE
[Unit]
Description=CafeScanner Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${PROJECT_ROOT}
ExecStart=/usr/bin/npm run start -w backend
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=${PROJECT_ROOT}/backend/.env

[Install]
WantedBy=multi-user.target
SERVICE

echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Enabling cafescanner service for boot..."
sudo systemctl enable cafescanner

echo "Restarting cafescanner service..."
sudo systemctl restart cafescanner

echo "CafeScanner service installed and started successfully."
echo "Production app is served from the backend on port 4000 (frontend + API)."

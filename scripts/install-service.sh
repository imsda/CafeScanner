#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER:-manager}}"

if [[ -z "${SERVICE_USER}" ]]; then
  SERVICE_USER="manager"
fi

echo "Using project root: ${PROJECT_ROOT}"
echo "Using service user: ${SERVICE_USER}"

ensure_arm64_rollup_compat() {
  # npm can skip optional platform packages, which may leave ARM64 Linux
  # missing Rollup's native binary package after install/update operations.
  if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "aarch64" ]]; then
    local rollup_arm64_pkg_dir="${PROJECT_ROOT}/node_modules/@rollup/rollup-linux-arm64-gnu"
    if [[ ! -d "$rollup_arm64_pkg_dir" ]]; then
      echo "[UPDATE] ARM64 Rollup dependency missing; installing compatibility package."
      npm install @rollup/rollup-linux-arm64-gnu --save-dev
    fi
  fi
}

ensure_arm64_rollup_compat

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

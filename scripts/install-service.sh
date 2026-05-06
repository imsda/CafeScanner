#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER:-manager}}"

if [[ -z "${SERVICE_USER}" ]]; then
  SERVICE_USER="manager"
fi

echo "Using project root: ${PROJECT_ROOT}"
echo "Using service user: ${SERVICE_USER}"

echo "Building backend for production..."
npm run build -w backend

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

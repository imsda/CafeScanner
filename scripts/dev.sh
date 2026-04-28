#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

export NODE_ENV="${NODE_ENV:-development}"
export BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
export HOST="${HOST:-$BACKEND_HOST}"
export PORT="${PORT:-4000}"
export FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
export FRONTEND_PORT="${FRONTEND_PORT:-5173}"

CERT_DEFAULT="${REPO_ROOT}/certs/dev.crt"
KEY_DEFAULT="${REPO_ROOT}/certs/dev.key"

if [[ -z "${SSL_CERT_FILE:-}" && -z "${SSL_KEY_FILE:-}" && -f "$CERT_DEFAULT" && -f "$KEY_DEFAULT" ]]; then
  export SSL_CERT_FILE="$CERT_DEFAULT"
  export SSL_KEY_FILE="$KEY_DEFAULT"
fi

if [[ -n "${SSL_CERT_FILE:-}" || -n "${SSL_KEY_FILE:-}" ]]; then
  if [[ ! -f "${SSL_CERT_FILE:-}" || ! -f "${SSL_KEY_FILE:-}" ]]; then
    echo "[dev] HTTPS requested, but cert files were not found."
    echo "[dev] Set SSL_CERT_FILE + SSL_KEY_FILE to valid files, or place certs at ${REPO_ROOT}/certs/dev.crt and ${REPO_ROOT}/certs/dev.key."
    exit 1
  fi
  FRONTEND_SCHEME="https"
  echo "[dev] HTTPS frontend enabled with SSL_CERT_FILE=${SSL_CERT_FILE} and SSL_KEY_FILE=${SSL_KEY_FILE}"
else
  FRONTEND_SCHEME="http"
  echo "[dev] HTTPS frontend not enabled (no cert/key found)."
  echo "[dev] To enable HTTPS for mobile camera scanning, set SSL_CERT_FILE and SSL_KEY_FILE (or use ${REPO_ROOT}/certs/dev.crt and ${REPO_ROOT}/certs/dev.key)."
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="<LAN-IP>"
fi

echo "[dev] Backend URL: http://${BACKEND_HOST}:${PORT}"
echo "[dev] Frontend local URL: ${FRONTEND_SCHEME}://localhost:${FRONTEND_PORT}"
echo "[dev] Frontend LAN URL: ${FRONTEND_SCHEME}://${LAN_IP}:${FRONTEND_PORT}"
echo "[dev] Frontend proxies /api -> http://127.0.0.1:4000"

cd "$REPO_ROOT"
npm run dev

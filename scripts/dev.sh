#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="${NODE_ENV:-development}"
export BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
export HOST="${HOST:-$BACKEND_HOST}"
export PORT="${PORT:-4000}"
export FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
export FRONTEND_PORT="${FRONTEND_PORT:-5173}"

npm run dev

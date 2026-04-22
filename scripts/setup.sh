#!/usr/bin/env bash
set -euo pipefail
npm install
cp -n .env.example .env || true
npm run db:migrate
npm run db:seed

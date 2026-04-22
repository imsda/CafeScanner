# CafeScanner

CafeScanner is a self-hostable school cafeteria meal tracking system with QR-based check-in.

## Features

- Admin login with session auth
- People management (create/update/list)
- CSV import with preview + partial commit + validation errors
- Auto-generate code values when missing
- QR badge printing (sheet view + browser print)
- Scan station with camera QR scanner + manual fallback entry
- Meal deduction rules for breakfast/lunch/dinner windows
- Clear success/failure scan states for cafeteria workers
- Cooldown/debounce protection against duplicate rapid scans
- Full transaction audit trail + CSV export
- Settings for school info, meal windows, cooldown, station, sounds, overrides
- Dashboard + basic reports
- SQLite + Prisma for easy local/self-host deployments

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Express + TypeScript
- Database: SQLite
- ORM: Prisma

## Project Structure

- `frontend/` React app
- `backend/` Express API + Prisma schema + seed
- `scripts/` helper scripts for setup/dev/build/start
- `compose.yaml` optional Docker Compose

## Environment Variables

`./scripts/setup.sh` now bootstraps env files automatically on a fresh clone:

- If `.env` is missing and `.env.example` exists, it creates `.env`.
- If `backend/.env` is missing and `backend/.env.example` exists, it creates `backend/.env`.
- Existing `.env` files are never overwritten.

After bootstrapping, setup validates that required keys from each `*.env.example` have non-empty values in the matching `.env`. If anything is missing, setup stops and tells you which file to edit.

Default examples:

```env
DATABASE_URL="file:./prisma/dev.db"
SESSION_SECRET="change-me-super-secret"
DEFAULT_ADMIN_USERNAME="admin"
DEFAULT_ADMIN_PASSWORD="ChangeMeNow123!"
PORT=4000
CLIENT_ORIGIN="http://localhost:5173"
```

## Quick Start (Fresh Machine)

```bash
git clone <your-repo-url>
cd CafeScanner
./scripts/setup.sh
```

On a fresh clone, `./scripts/setup.sh` is the **only required setup command**. It is idempotent and safe to re-run, and it will:
- bootstrap `.env` and `backend/.env` from their `*.example` files without overwriting existing files
- validate required env keys and fail clearly when placeholder values are still present
- install npm dependencies for the root project and all workspaces
- run Prisma migrations
- seed the database
- run the full backend + frontend build

After setup succeeds, start development servers with:

```bash
./scripts/dev.sh
```

This runs:
- backend on `http://localhost:4000`
- frontend on `http://localhost:5173`

## Build + Production Run

```bash
./scripts/build.sh
./scripts/start.sh
```

## Database Setup

Prisma schema is in `backend/prisma/schema.prisma`.

Run manually if needed:

```bash
npm run db:migrate
npm run db:seed
```

## Default Admin Account

Seed creates one admin account from env vars:

- username: `DEFAULT_ADMIN_USERNAME` (default `admin`)
- password: `DEFAULT_ADMIN_PASSWORD` (default `ChangeMeNow123!`)

Change credentials by editing `.env` before running `npm run db:seed`.

## CSV Import Format

Supported columns:

- `firstName`
- `lastName`
- `personId`
- `codeValue`
- `breakfastRemaining`
- `lunchRemaining`
- `dinnerRemaining`
- `active`
- `grade`
- `group`
- `campus`
- `notes`

You can download template at `/api/import/template` (authenticated).

Import flow:
1. Upload CSV in Import page
2. Run Preview (shows row-level errors)
3. Commit partial import (valid rows import, invalid rows reported)

## Meal Logic (Implemented)

Default windows:
- Breakfast `05:00–10:00`
- Lunch `11:00–14:00`
- Dinner `17:00–19:00`

On scan:
1. detect active meal period
2. lookup person by `codeValue`
3. reject unknown code
4. reject inactive person
5. reject outside meal windows
6. reject no remaining meals for detected meal
7. deduct exactly 1 meal in DB transaction
8. write scan log

Balances are clamped to never go below zero.

## Transactions / Audit Trail

Logged fields include:
- timestamp
- scanned value
- matched person (if any)
- detected meal
- result
- failure reason
- station name
- admin user id (if logged in)

Use Transactions page filters endpoint and export CSV at `/api/transactions/export.csv`.

## Docker (Optional)

```bash
docker compose up --build
```

App ports:
- `4000` backend
- `5173` frontend preview/dev port exposure

> Docker is optional; local scripts remain the easiest default path.

## Notes for Schools

- Scanner page is designed for fast, high-contrast tablet use.
- Manual entry fallback is provided if camera permissions fail.
- Scanner implementation is abstracted in `frontend/src/components/QrScanner.tsx` so 1D barcode support can be added later without rewriting app pages.

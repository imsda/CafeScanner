# CafeScanner

CafeScanner is a self-hostable school cafeteria meal tracking system with QR-based check-in.

## Quick Start (Fresh Clone)

```bash
git clone <your-repo-url>
cd CafeScanner
./scripts/setup.sh
```

`./scripts/setup.sh` is the only required setup command. It will:
- bootstrap env files without overwriting existing ones
- validate required env keys and placeholder values
- install root + workspace dependencies
- run Prisma migrations and seed
- run full backend + frontend build verification

If setup fails, it exits with a clear error that identifies what is missing.

## Environment Files

CafeScanner uses these env files:

- `backend/.env` (required, auto-created from `backend/.env.example`)
- `frontend/.env` (auto-created from `frontend/.env.example`)

### Required backend env values

See `backend/.env.example`:

- `DATABASE_URL` (Prisma SQLite path)
- `SESSION_SECRET` (must be changed from placeholder)
- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD`
- `PORT` (backend port, default `4000`)
- `BACKEND_HOST` (default `0.0.0.0`)
- `CLIENT_ORIGIN` (comma-separated allowlist used in production)

### Frontend env values

See `frontend/.env.example`:

- `VITE_API_BASE` (optional override for API URL)
  - default file value: `http://localhost:4000/api`
  - if unset, frontend falls back to `http://<current-hostname>:4000/api`

## Default Admin Credentials

The seed script creates/updates one admin user:

- Username: `DEFAULT_ADMIN_USERNAME` (default: `admin`)
- Password: `DEFAULT_ADMIN_PASSWORD` (default: `ChangeMeNow123!`)

Change these in `backend/.env` before running setup if needed.

## Development Mode

Start both apps:

```bash
./scripts/dev.sh
```

Defaults:
- Backend: `http://0.0.0.0:4000`
- Frontend: `http://0.0.0.0:5173`

### Access from another machine on the LAN

1. Find the IP of the machine running CafeScanner (example: `192.168.1.50`).
2. On another machine, open `http://192.168.1.50:5173`.
3. Frontend API calls will target `http://192.168.1.50:4000/api` by default.

Notes:
- In development (`NODE_ENV=development`), backend CORS allows LAN origins for easier testing.
- In production, backend enforces `CLIENT_ORIGIN` allowlist.

## Production Run

Build and start:

```bash
./scripts/build.sh
./scripts/start.sh
```

Or directly:

```bash
npm run build
npm run start
```

For production hardening, set `NODE_ENV=production` and set a strict `CLIENT_ORIGIN` value in `backend/.env`.

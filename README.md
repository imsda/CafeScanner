# CafeScanner

CafeScanner is a self-hostable school cafeteria meal tracking system with **barcode-first** check-in for camera scanners and USB handheld scanners.

## Quick Start (Fresh Clone)

```bash
git clone <your-repo-url>
cd CafeScanner
./scripts/setup.sh
```

## Prerequisites to install separately

Install these once on the host before running `./scripts/setup.sh`:

- **Git** (required)
  - Used to clone and update this repository.
  - Example: `sudo apt-get install -y git`
- **sudo/root access + apt** (required on Ubuntu/Debian)
  - `setup.sh` installs missing app-runtime packages (Node.js/npm/npx and openssl) with `apt-get` when needed.
- **Database service for non-SQLite deployments** (required only if `DATABASE_URL` points to an external database)
  - `setup.sh` runs Prisma migrations and seeding, but does not install/manage PostgreSQL/MySQL server daemons.
- **Docker** (optional)
  - Useful for containerized deployment workflows; not required for normal local setup with `scripts/setup.sh`.
- **Nginx or another reverse proxy** (optional, production)
  - Needed only for production TLS/domain reverse-proxy setups; intentionally not configured by `scripts/setup.sh`.

## What `./scripts/setup.sh` handles automatically

- Checks required app dependencies and installs missing runtime tools on Ubuntu/Debian when appropriate:
  - Node.js (modern LTS via NodeSource), npm, npx
  - openssl
- Bootstraps `backend/.env` and `frontend/.env` from example files.
- Merges newly added env keys from `*.env.example` into existing env files without overwriting existing values.
- Generates a secure `SESSION_SECRET` automatically when the placeholder value is still present.
- Validates required environment values and fails with clear messages when values are missing/placeholders.
- Installs all npm workspace dependencies (root, backend, frontend).
- Runs Prisma migration status checks and deploy-mode migrations safely.
- Runs seed logic (`npm run db:seed`).
- Runs the full app build (`npm run build`).

## Initial Setup

1. `./scripts/setup.sh`
2. `npm run create-admin -w backend`
3. `npm run promote-owner -w backend`
4. `npm run set-owner-recovery-code -w backend`

## User Roles

- **OWNER**: full access, can arm full application wipe.
- **ADMIN**: full app access, cannot arm full wipe or manage OWNER users.
- **CUSTOM**: access is limited to individually selected tabs/pages.
- **SCANNER**: Scan Station only.

## User Management

Use the Users/Admin flows to:

- add users,
- remove/disable users,
- reset passwords,
- assign roles,
- assign page access for CUSTOM users.

## Environment Files

- `backend/.env` (auto-created from `backend/.env.example`)
  - Running `./scripts/setup.sh` also auto-merges newly added required keys from `backend/.env.example` into an existing `backend/.env` file without overwriting existing values.
- `frontend/.env` (auto-created from `frontend/.env.example`)

### Required backend env values

- `DATABASE_URL`
- `SESSION_SECRET`
- `PORT` (default `4000`)
- `BACKEND_HOST` (default `0.0.0.0`)
- `CLIENT_ORIGIN`
- `BACKUP_DIR` (optional, default `backend/backups`)

### Backup/Restore storage

- OWNER/ADMIN users can create and restore SQLite backups from **Settings → Backups**.
- Backup files are stored on disk in `BACKUP_DIR` (default `backend/backups`).
- In Docker/Compose, mount this directory to persistent storage so backup files survive container recreation.

### Frontend env values

- `VITE_API_BASE` (default `/api`)

## Development Mode

```bash
./scripts/dev.sh
```

Defaults:
- Backend: `http://0.0.0.0:4000`
- Frontend: `http://0.0.0.0:5173`
- Frontend proxies `/api` requests to `http://127.0.0.1:4000` in development.
- Frontend in development mode runs on **port 5173**.

If the dev server reports `EADDRINUSE` (typically port `4000`), stop stale processes and restart:

```bash
pkill -f "tsx watch src/index.ts"
pkill -f "vite"
```

### Traefik reverse-proxy flow (same-origin API)

When running behind Traefik, use same-origin browser API calls (`/api/...`) so the browser never calls `http://localhost:4000` directly.

- Set `frontend/.env` to `VITE_API_BASE=/api`
- Request flow: `Browser -> HTTPS domain -> Traefik -> Vite -> /api proxy -> backend`

This keeps login/session cookie flows on same-origin `/api` requests from the browser perspective while still routing API traffic to the local backend process.

### HTTPS development for mobile camera scanning

Camera scanning on phones requires a secure context (`https://...` or `http://localhost`).

#### 1) Generate a self-signed certificate

Create a cert for your local machine/LAN use:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout certs/dev.key \
  -out certs/dev.crt \
  -days 365 \
  -subj "/CN=localhost"
```

You can also use your own certificate and key files; paths are configurable.

#### 2) Start dev server over HTTPS

`./scripts/dev.sh` will automatically enable HTTPS when both files exist:

- `certs/dev.crt`
- `certs/dev.key`

Or you can point to custom files:

```bash
SSL_CERT_FILE=/path/to/dev.crt SSL_KEY_FILE=/path/to/dev.key ./scripts/dev.sh
```

The script prints local + LAN frontend URLs and whether HTTPS is enabled.

#### 3) LAN access from phones/tablets

- Dev frontend binds to `0.0.0.0` so other machines can connect.
- Open the HTTPS LAN URL printed by `./scripts/dev.sh` (for example `https://192.168.1.25:5173`).
- API calls remain same-origin (`/api/...`) and are proxied by Vite to backend HTTP, so the browser never calls an HTTP API directly (avoids mixed-content issues).

#### 4) Self-signed cert trust notes

- Mobile browsers may warn that the cert is not trusted.
- You usually must trust/install the self-signed cert on the phone for camera access to behave reliably.
- If trust is not established, browsers may block access before camera permission can be requested.

## Barcode Scanning Notes

- Camera mode supports common 1D barcode formats (Code 128, Code 39, Code 93, Codabar, EAN-8/13, ITF, UPC-A/E) and QR fallback.
- Camera mode starts only after tapping **Start Camera Scanner**, which explicitly triggers browser permission flow and prioritizes the rear camera when available.
- If the page is not secure, scanner UI explains that camera scanning requires HTTPS or localhost (instead of incorrectly reporting generic camera support failure).
- If camera mode is denied/unavailable, operators can continue service using USB scanner or manual ID entry mode.

## USB Scanner / Manual Entry Notes

- Use **USB Scanner / Manual Entry** mode on the scan station.
- Keep focus on the barcode input; most USB scanners act like keyboard typing + Enter.
- Camera, USB scanner, and manual submit all post to the same `/api/scan` deduction route.

## Production Run

```bash
./scripts/build.sh
./scripts/start.sh
```

### Docker Compose persistence recommendation

If you use `compose.yaml`, persist both SQLite data and backups:

```yaml
volumes:
  - ./backend/prisma:/app/backend/prisma
  - ./backend/backups:/app/backend/backups
```

## Production Service Setup

```bash
./scripts/setup.sh
sudo ./scripts/install-service.sh
```

After service install/start:
- Frontend is served by the backend process on **port 4000** (no Vite dev server in production).
- API remains available under `/api` on the same origin (for example `http://SERVER-IP:4000/api/health`).
- Open the app at `http://SERVER-IP:4000`.

Check status:

```bash
./scripts/service-status.sh
```

View logs:

```bash
./scripts/service-logs.sh
```

Restart:

```bash
./scripts/service-restart.sh
```

### Service update/build permissions

- Do **not** run `./scripts/update-service.sh` (or production builds) with `sudo`/root unless your service also runs as root.
- The service/update user should own repository files, including `backend/dist`, so build artifacts remain writable.

## Meal Tracking Modes

CafeScanner uses exactly one global **meal tracking mode** at a time (`Settings → Meal tracking mode`). There is no mixed mode in normal operation.

- **Camp Meeting** (`camp_meeting`)
  - Uses ticket-style `MealEntitlement` rows (one row = one entitlement; rows are never collapsed by `reg_id`).
  - Scan ID is `reg_id` (shared family/person key), and scanners pick the specific `guest_name` row when multiple options are available for the same meal/day.
  - Meal types map as: `breakfast -> BREAKFAST`, `lunch -> LUNCH`, `supper -> DINNER`.
- **Tally Up** (`tally`)
  - Each scan increments `breakfastCount`, `lunchCount`, or `dinnerCount`.
  - `totalMealsCount` is also incremented for every successful meal scan.
  - No “out of meals” blocking is enforced in this mode.

`Setting.mealTrackingMode` is stored in the database and persists across rebuilds, restarts, and redeploys as long as the database is preserved.

### Google Sheets Sync (all meal tracking modes)

Use this exact Google Sheet header row:

`ticket_id,reg_id,guest_name,meal_type,meal_day,meal_date,ticket_type,price,redeemed,redeemed_at,redeemed_by,notes`

Behavior:
- CSV import: `ticket_id` is used as the stable key (stored as `sourceTicketId`).
- Google Sheet import: each row uses a stable row key `google:<sheetName>:row:<rowNumber>` for `sourceTicketId` so duplicate `ticket_id` values do not overwrite each other.
- `reg_id` maps to scanner `personId` / shared family ID.
- `guest_name` is the individual name for that specific ticket row.
- Each row imports as its own entitlement (no grouping/collapsing by `reg_id`).
- On redemption, local SQLite updates first (`redeemed`, `redeemedAt`, `redeemedBy`), and sync writes are queued.
- Write-back updates only columns: `redeemed` (`yes`), `redeemed_at` (timestamp), `redeemed_by` (selected guest).
- Automatic write-back runs at configured sync interval and only during configured meal windows plus 10 minutes for all modes.
- OWNER/ADMIN can trigger manual write-back anytime via API endpoint `POST /api/import/google-sheet/write-back-now`.
- OWNER/ADMIN can trigger manual transaction log sync via API endpoint `POST /api/import/google-sheet/write-log-now` (Settings button: **Sync LOG now**).
- If Google Sheets is unavailable, scanning still works (SQLite remains source of truth); retries occur on the next sync.

Transaction LOG tab behavior (all modes: Camp Meeting, Tally Up, Count Down):
- A dedicated tab named `LOG` is auto-created when needed.
- `LOG` header row is auto-created/fixed to exactly: `Time,Value,Meal,Result,Reason,Person,Station`.
- Rows are appended from local `ScanTransaction` records only (local DB remains source of truth).
- Mapping: `Time=timestamp`, `Value=scannedValue`, `Meal=mealType`, `Result=result`, `Reason=failureReason`, `Person=linked person full name or entitlementPersonName`, `Station=stationName`.
- Duplicate prevention: each transaction has `googleLogSyncedAt`; only rows where this is `NULL` are appended, then marked synced only after successful append.
- Existing `LOG` rows are never cleared/overwritten; formatting/filtering is preserved as much as possible because sync uses append-only writes.

Tally Up / Count Down sheet format:

`ID,Name,Breakfast,Lunch,Dinner,Total`

- **Tally Up import**: imports `ID` + `Name` only and updates/creates `Person` by stable `ID` (`personId` / `codeValue`).
- **Tally Up write-back (lifetime)**: writes current local `Breakfast/Lunch/Dinner/Total` tally counts (`Total = Breakfast + Lunch + Dinner`) to the main configured tab.
- **Tally Up write-back (weekly)**: writes current-week successful scan totals from local `ScanTransaction` records into a separate weekly tab (default tab: `Weekly Tally`) using columns: `Week Starting, Week Ending, ID, Name, Breakfast, Lunch, Dinner, Total`.
- **Tally Up write-back (both)**: performs both lifetime write-back (main tab) and weekly write-back (weekly tab).
- Weekly tab behavior: auto-creates the weekly tab and header if missing, updates/appends only current-week rows, and preserves historical rows.
- **Count Down import**: imports `ID`, `Name`, and remaining `Breakfast/Lunch/Dinner` balances; if `Total` conflicts, per-meal columns are preferred.
- **Count Down write-back**: writes current local remaining balances and recomputed `Total`.
- Re-imports update existing people instead of duplicating.

Template download:
- Settings → Google Sheets Sync → **Download Template** generates a CSV header template for the active mode.
- Filenames:
  - `camp-meeting-google-sheet-template.csv`
  - `tally-up-google-sheet-template.csv`
  - `count-down-google-sheet-template.csv`

Service-account configuration (recommended):
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- Optional: `GOOGLE_SHEETS_RANGE` (default `Sheet1!A:L`)
- Optional: `GOOGLE_SHEETS_TAB` (default `Sheet1`)

### Switching meal tracking mode

Switching between modes is a destructive admin action:

- confirmation modal requires typing the exact phrase `SWITCH MODE`,
- on confirmation, the app updates `Setting.mealTrackingMode`,
- then clears operational data (`Person`, `ScanTransaction`, and `ImportHistory`),
- while preserving login accounts and other settings.

## Admin: Clear Database

Admins can now use **Settings → System: Clear Database** to run a destructive reset.

- This action is **admin-only** in both frontend visibility and backend authorization.
- Confirmation requires typing the exact phrase: `CLEAR DATABASE`.
- The action deletes:
  - all `Person` records,
  - all `ScanTransaction` history,
  - all `ImportHistory` records.
- The action preserves:
  - admin/scanner login accounts (`AdminUser`),
  - app settings (`Setting`) including the currently selected meal tracking mode.

## Admin: Delete Individual Person

Admins can delete one specific person record from **People** without clearing the whole system.

- This action is **admin-only** in both frontend visibility and backend authorization.
- The delete confirmation modal shows the person name and `personId`.
- Confirmation requires typing the exact phrase: `DELETE USER`.
- The action deletes only the selected person and related scan transaction records tied to that person.
- The action does **not** delete:
  - other people,
  - admin/scanner login accounts (`AdminUser`),
  - system settings (`Setting`) or the selected meal tracking mode.

## Prisma Migration Workflow (Data-Safe)

### Non-negotiable rule: applied migrations are immutable

Once a migration has been applied to any shared environment/database, do **not** edit its SQL file.

- ✅ Make schema changes by creating a **new** migration.
- ❌ Do not rewrite old migration files.

Rewriting applied migrations causes Prisma migration history drift and often leads to reset prompts.

### Normal setup/update behavior

`./scripts/setup.sh` now uses Prisma deploy-mode migrations so existing databases are updated in place:

- preserves existing SQLite data,
- applies only pending migrations,
- does **not** run `prisma migrate reset`,
- fails with a clear message when migration history diverges instead of silently encouraging destructive actions.

### Commands

- `npm run db:migrate` → safe apply (`prisma migrate deploy`)
- `npm run db:status` → inspect migration history/state
- `npm run db:seed` → ensure default records exist without overwriting existing operational data

### Creating future schema changes correctly

Use a development migration command when you intentionally change the Prisma schema:

```bash
npm run prisma:migrate:dev -w backend -- --name <descriptive_change_name>
```

Then commit:

1. the updated `backend/prisma/schema.prisma`,
2. the new folder under `backend/prisma/migrations/`,
3. any code changes that rely on the schema update.

Destructive reset flows are admin-initiated app actions only (for explicit maintenance), not part of normal pull/setup updates.

## Password Recovery

- Reset password: `npm run reset-password -w backend`

## OWNER Recovery Code

- Set/update OWNER recovery code: `npm run set-owner-recovery-code -w backend`

## Create Scanner User

- `npm run create-scanner -w backend`

## Full Application Wipe

1. Login as OWNER.
2. Open **Settings → Danger Zone → Arm Full Application Wipe**.
3. Copy the one-time token.
4. Run: `npm run full-wipe -w backend -- --token <token>`
5. Type: `DELETE EVERYTHING`
6. Re-run setup and bootstrap:
   - `./scripts/setup.sh`
   - `npm run create-admin -w backend`
   - `npm run promote-owner -w backend`

## Database/Data Safety

- `./scripts/setup.sh` preserves existing data.
- Normal setup does not reset users.
- Full wipe is the only script that deletes everything.
- Full wipe requires OWNER web authorization plus terminal token.


## Production Workflow
- Run `scripts/setup.sh` for first-time setup; it preserves existing DB/users and avoids destructive resets.
- Production serves `frontend/dist` from backend on port 4000 (`/api/*` unchanged).
- Use reverse proxy (Traefik) with HTTPS and forward to `http://127.0.0.1:4000`.

## Update Workflow
- Use `scripts/update-service.sh` only. It creates a pre-update SQLite backup, pulls fast-forward changes, installs deps, builds, runs migrations (if present), and restarts `cafescanner`.

## Backup/Restore Workflow
- Use System backup download/restore routes. Restore now validates SQLite file headers before replacement.
- Recommended: scheduled filesystem backups of `backend/backups`, DB file, and `-wal`/`-shm` files.

## Service Management
- `sudo systemctl status cafescanner`
- `sudo systemctl restart cafescanner`
- `journalctl -u cafescanner -f`

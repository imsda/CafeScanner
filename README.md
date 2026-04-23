# CafeScanner

CafeScanner is a self-hostable school cafeteria meal tracking system with **barcode-first** check-in for camera scanners and USB handheld scanners.

## Quick Start (Fresh Clone)

```bash
git clone <your-repo-url>
cd CafeScanner
./scripts/setup.sh
```

## Default Login Credentials

Seeded from `backend/.env` (or defaults below):

- **Admin**
  - Username: `DEFAULT_ADMIN_USERNAME` (default `admin`)
  - Password: `DEFAULT_ADMIN_PASSWORD` (default `AdminPass123!Dev`)
- **Scanner-only**
  - Username: `DEFAULT_SCANNER_USERNAME` (default `scanner`)
  - Password: `DEFAULT_SCANNER_PASSWORD` (default `ScannerPass123!Dev`)

Scanner-only accounts can sign in and use the scan station, but cannot access admin pages.

## Environment Files

- `backend/.env` (auto-created from `backend/.env.example`)
  - Running `./scripts/setup.sh` also auto-merges newly added required keys from `backend/.env.example` into an existing `backend/.env` file without overwriting existing values.
- `frontend/.env` (auto-created from `frontend/.env.example`)

### Required backend env values

- `DATABASE_URL`
- `SESSION_SECRET`
- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD`
- `DEFAULT_SCANNER_USERNAME`
- `DEFAULT_SCANNER_PASSWORD`
- `PORT` (default `4000`)
- `BACKEND_HOST` (default `0.0.0.0`)
- `CLIENT_ORIGIN`

### Frontend env values

- `VITE_API_BASE` (default `/api`)
- `VITE_DEV_BACKEND_TARGET` (default `http://127.0.0.1:4000`)

## Development Mode

```bash
./scripts/dev.sh
```

Defaults:
- Backend: `http://0.0.0.0:4000`
- Frontend: `http://0.0.0.0:5173`
- Frontend proxies `/api` requests to backend in development.

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

## Meal Tracking Modes

CafeScanner uses exactly one global **meal tracking mode** at a time (`Settings → Meal tracking mode`). There is no mixed mode in normal operation.

- **Count Down** (`countdown`)
  - Each scan deducts from `breakfastRemaining`, `lunchRemaining`, or `dinnerRemaining`.
  - If a meal balance is already `0`, the scan is rejected with “no meals remaining.”
- **Tally Up** (`tally`)
  - Each scan increments `breakfastCount`, `lunchCount`, or `dinnerCount`.
  - `totalMealsCount` is also incremented for every successful meal scan.
  - No “out of meals” blocking is enforced in this mode.

`Setting.mealTrackingMode` is stored in the database and persists across rebuilds, restarts, and redeploys as long as the database is preserved.

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

## Schema / Migration Updates

A new migration `0004_meal_tracking_mode_and_tallies` adds:

- `Person.breakfastCount`
- `Person.lunchCount`
- `Person.dinnerCount`
- `Person.totalMealsCount`
- `Setting.mealTrackingMode` (`countdown` or `tally`)

Existing setup scripts remain compatible; run setup/migrations/seed as usual:

```bash
./scripts/setup.sh
npm run db:migrate
npm run db:seed
```

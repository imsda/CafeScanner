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
  - Password: `DEFAULT_ADMIN_PASSWORD` (default `ChangeMeNow123!`)
- **Scanner-only**
  - Username: `DEFAULT_SCANNER_USERNAME` (default `scanner`)
  - Password: `DEFAULT_SCANNER_PASSWORD` (default `ScanMeals123!`)

Scanner-only accounts can sign in and use the scan station, but cannot access admin pages.

## Environment Files

- `backend/.env` (auto-created from `backend/.env.example`)
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

- `VITE_API_BASE` (optional)

## Barcode Scanning Notes

- Camera mode supports common 1D barcode formats (Code 128, Code 39, Code 93, Codabar, EAN-8/13, ITF, UPC-A/E) and QR fallback.
- Scan station now uses barcode wording in the UI and result states.
- Camera mode uses a **Start Scanner** action to trigger browser camera permission reliably.

## USB Scanner / Manual Entry Notes

- Use **USB Scanner / Manual Entry** mode on the scan station.
- Keep focus on the barcode input; most USB scanners act like keyboard typing + Enter.
- Camera, USB scanner, and manual submit all post to the same `/api/scan` deduction route.

## Development Mode

```bash
./scripts/dev.sh
```

Defaults:
- Backend: `http://0.0.0.0:4000`
- Frontend: `http://0.0.0.0:5173`

## Production Run

```bash
./scripts/build.sh
./scripts/start.sh
```

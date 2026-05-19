import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import peopleRoutes from './routes/people.js';
import settingsRoutes from './routes/settings.js';
import scanRoutes from './routes/scan.js';
import transactionRoutes from './routes/transactions.js';
import importRoutes from './routes/import.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';
import systemRoutes from './routes/system.js';
import usersRoutes from './routes/users.js';
import { requireAdmin, requireAuth, requirePageAccess } from './middleware/auth.js';
import { configureSqlitePragmas } from './db.js';
import { ensureSettingsInitialized } from './services/settingsService.js';
import { startCampMeetingSheetSyncScheduler } from './services/campMeetingSheetSyncService.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const host = process.env.BACKEND_HOST || process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const behindProxy = (process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false';

const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const frontendDistDir = path.resolve(currentDir, '../../frontend/dist');
const frontendIndexPath = path.join(frontendDistDir, 'index.html');


const SQLiteStore = connectSqlite3(session);
const sessionStoreDir = path.resolve(currentDir, '../data');
fs.mkdirSync(sessionStoreDir, { recursive: true });
const sessionStore = new SQLiteStore({
  db: 'sessions.sqlite',
  dir: sessionStoreDir,
  table: 'sessions',
  expired: {
    clear: true,
    intervalMs: 1000 * 60 * 15
  }
} as any);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (!isProduction) {
        callback(null, true);
        return;
      }

      if (configuredOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    }
  })
);
app.use(express.json());
if (behindProxy) app.set('trust proxy', 1);

app.use(
  session({
    store: sessionStore as session.Store,
    secret: process.env.SESSION_SECRET || (isProduction ? (()=>{throw new Error('SESSION_SECRET is required in production');})() : 'change-me'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8, sameSite: 'lax', secure: isProduction && behindProxy }
  })
);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);

app.use('/api/scan', requireAuth, requirePageAccess('SCAN'), scanRoutes);
app.use('/api/people', requireAuth, requirePageAccess('PEOPLE'), peopleRoutes);
app.use('/api/settings', requireAuth, requirePageAccess('SETTINGS'), settingsRoutes);
app.use('/api/transactions', requireAuth, requirePageAccess('TRANSACTIONS'), transactionRoutes);
app.use('/api/import', requireAuth, requirePageAccess('IMPORT'), importRoutes);
app.use('/api/dashboard', requireAuth, requirePageAccess('DASHBOARD'), dashboardRoutes);
app.use('/api/reports', requireAuth, requirePageAccess('REPORTS'), reportRoutes);
app.use('/api/system', requireAuth, requirePageAccess('SETTINGS'), systemRoutes);
app.use('/api/users', requireAuth, requireAdmin, usersRoutes);

if (isProduction) {
  console.log(`[FRONTEND] mode=${isProduction ? 'production' : 'development'} distPath=${frontendDistDir} indexExists=${fs.existsSync(frontendIndexPath)}`);
  if (fs.existsSync(frontendDistDir)) {
    app.use(express.static(frontendDistDir));
    console.log(`[FRONTEND] Serving static frontend from ${frontendDistDir}`);
  } else {
    console.warn(`[FRONTEND] Build output not found at ${frontendDistDir}. Run: npm run build`);
  }
}

app.use('/api', (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error && error.message ? error.message : 'Internal server error';
  console.error('[API] Unhandled error.', error);
  res.status(500).json({ error: message });
});

if (isProduction) {
  app.get('*', (_req, res) => {
    if (!fs.existsSync(frontendIndexPath)) {
      res.status(503).send('Frontend build is missing. Please run: npm run build');
      return;
    }

    res.sendFile(frontendIndexPath);
  });
}

app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);
  if (!isProduction) {
    console.log('Development frontend is available via Vite on port 5173.');
  } else {
    console.log('Production frontend is served by backend on port 4000.');
  }

  void (async () => {
    try {
      await configureSqlitePragmas();
      await ensureSettingsInitialized();
      startCampMeetingSheetSyncScheduler();
      console.log('[SETTINGS] Initialization check completed at startup.');
    } catch (error) {
      console.error('[STARTUP] Scheduler/settings initialization failed; backend will continue running.', error);
    }
  })();
});

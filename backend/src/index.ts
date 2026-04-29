import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
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

const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
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

app.use('/api', (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error && error.message ? error.message : 'Internal server error';
  console.error('[API] Unhandled error.', error);
  res.status(500).json({ error: message });
});

app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);

  void (async () => {
    await configureSqlitePragmas();
    await ensureSettingsInitialized();
    startCampMeetingSheetSyncScheduler();
    console.log('[SETTINGS] Initialization check completed at startup.');
  })();
});

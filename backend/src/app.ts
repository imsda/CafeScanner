import express from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import cors from 'cors';
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
import homeLeaveRoutes from './routes/homeLeaves.js';
import metaRoutes from './routes/meta.js';
import { refreshSessionUser, requireAdmin, requireAuth, requirePageAccess } from './middleware/auth.js';

const isProduction = process.env.NODE_ENV === 'production';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDistDir = path.resolve(currentDir, '../../frontend/dist');
const frontendIndexPath = path.join(frontendDistDir, 'index.html');

// TRUST_PROXY: "true" trusts one proxy hop, "false" trusts none, anything else is passed
// to Express as-is (e.g. "loopback", an IP or CIDR list). The default only trusts a
// reverse proxy on the same host, so direct clients cannot spoof X-Forwarded-For.
function parseTrustProxy(value: string | undefined): boolean | number | string {
  const normalized = (value ?? '').trim();
  if (!normalized) return 'loopback';
  if (normalized.toLowerCase() === 'true') return 1;
  if (normalized.toLowerCase() === 'false') return false;
  return normalized;
}

function createSqliteSessionStore(): session.Store {
  const SQLiteStore = connectSqlite3(session);
  const sessionStoreDir = path.resolve(currentDir, '../data');
  fs.mkdirSync(sessionStoreDir, { recursive: true });
  return new SQLiteStore({
    db: 'sessions.sqlite',
    dir: sessionStoreDir,
    table: 'sessions',
    expired: {
      clear: true,
      intervalMs: 1000 * 60 * 15
    }
  } as any) as session.Store;
}

function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) throw new Error('SESSION_SECRET is required in production');
  return 'change-me';
}

const apiErrorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
    return res.status(400).json({ error: `Invalid request: ${details.join('; ')}`, details });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Record not found.' });
    if (error.code === 'P2002') return res.status(409).json({ error: 'A record with that value already exists.' });
  }
  // Errors raised by body-parser and similar middleware carry a 4xx status (e.g. malformed JSON).
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Bad request.' });
  }
  console.error('[API] Unhandled error.', error);
  const message = error instanceof Error && error.message ? error.message : 'Internal server error';
  res.status(500).json({ error: message });
};

export type CreateAppOptions = {
  // Defaults to the SQLite store in backend/data; tests pass an in-memory store.
  sessionStore?: session.Store;
  // Serve the built frontend (production only by default).
  serveFrontend?: boolean;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const serveFrontend = options.serveFrontend ?? isProduction;
  const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        // Same-origin requests carry no Origin header; development allows any origin.
        if (!origin || !isProduction || configuredOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      }
    })
  );
  app.use(express.json());
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

  app.use(
    session({
      store: options.sessionStore ?? createSqliteSessionStore(),
      secret: sessionSecret(),
      resave: false,
      saveUninitialized: false,
      // 'auto' marks the cookie Secure only on HTTPS requests (directly or via a trusted
      // proxy's X-Forwarded-Proto), so plain-HTTP LAN access on :4000 still works.
      cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8, sameSite: 'lax', secure: isProduction ? 'auto' : false }
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', refreshSessionUser);
  app.use('/api/auth', authRoutes);
  app.use('/api/meta', requireAuth, metaRoutes);

  app.use('/api/scan', requireAuth, requirePageAccess('SCAN'), scanRoutes);
  app.use('/api/people', requireAuth, requirePageAccess('PEOPLE'), peopleRoutes);
  app.use('/api/settings', requireAuth, requirePageAccess('SETTINGS'), settingsRoutes);
  app.use('/api/transactions', requireAuth, requirePageAccess('TRANSACTIONS'), transactionRoutes);
  app.use('/api/import', requireAuth, requirePageAccess('IMPORT'), importRoutes);
  app.use('/api/dashboard', requireAuth, requirePageAccess('DASHBOARD'), dashboardRoutes);
  app.use('/api/reports', requireAuth, requirePageAccess('REPORTS'), reportRoutes);
  app.use('/api/home-leaves', requireAuth, requirePageAccess('HOME_LEAVES'), homeLeaveRoutes);
  app.use('/api/system', requireAuth, requirePageAccess('SETTINGS'), systemRoutes);
  app.use('/api/users', requireAuth, requireAdmin, usersRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use('/api', apiErrorHandler);

  if (serveFrontend) {
    console.log(`[FRONTEND] mode=${isProduction ? 'production' : 'development'} distPath=${frontendDistDir} indexExists=${fs.existsSync(frontendIndexPath)}`);
    if (fs.existsSync(frontendDistDir)) {
      app.use(express.static(frontendDistDir));
      console.log(`[FRONTEND] Serving static frontend from ${frontendDistDir}`);
    } else {
      console.warn(`[FRONTEND] Build output not found at ${frontendDistDir}. Run: npm run build`);
    }

    app.get('*', (_req, res) => {
      if (!fs.existsSync(frontendIndexPath)) {
        res.status(503).send('Frontend build is missing. Please run: npm run build');
        return;
      }
      res.sendFile(frontendIndexPath);
    });
  }

  return app;
}

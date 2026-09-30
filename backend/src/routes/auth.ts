import { asyncRouter } from '../utils/asyncRouter.js';
import bcrypt from 'bcryptjs';
import { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';

const router = asyncRouter();
const loginAttempts = new Map<string, { count: number; first: number }>();
const ALL_PAGES = ['DASHBOARD', 'SCAN', 'PEOPLE', 'IMPORT', 'BADGES', 'TRANSACTIONS', 'REPORTS', 'HOME_LEAVES', 'SETTINGS', 'USER_MANAGEMENT'] as const;
const SCANNER_PAGES = ['SCAN'] as const;
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

function regenerateSession(req: Request) {
  return new Promise<void>((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
}

function allowedPagesFor(role: 'OWNER' | 'ADMIN' | 'SCANNER' | 'CUSTOM', customPages: string[]): string[] {
  if (role === 'OWNER' || role === 'ADMIN') return [...ALL_PAGES];
  if (role === 'SCANNER') return [...SCANNER_PAGES];
  return customPages;
}

router.post('/login', async (req, res) => {
  // req.ip honours the app's `trust proxy` setting, so a client cannot spoof X-Forwarded-For to dodge the limit.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 20;
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > windowMs) { rec.count = 0; rec.first = now; }
  if (rec.count >= maxAttempts) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Username and password are required.' });
  const { username, password } = parsed.data;
  const user = await prisma.adminUser.findUnique({ where: { username } });
  if (!user) { rec.count += 1; loginAttempts.set(ip, rec); return res.status(401).json({ error: 'Invalid credentials' }); }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) { rec.count += 1; loginAttempts.set(ip, rec); return res.status(401).json({ error: 'Invalid credentials' }); }

  const pageAccess = await prisma.userPageAccess.findMany({ where: { adminUserId: user.id } });
  const allowedPages = allowedPagesFor(user.role, pageAccess.map((entry) => entry.page));
  // Issue a fresh session ID on login to prevent session fixation.
  await regenerateSession(req);
  req.session.adminUserId = user.id;
  req.session.role = user.role;
  req.session.allowedPages = allowedPages;
  loginAttempts.delete(ip);
  res.json({ id: user.id, username: user.username, role: user.role, allowedPages });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  if (!req.session.adminUserId) return res.status(401).json({ error: 'Unauthorized' });

  const user = await prisma.adminUser.findUnique({
    where: { id: req.session.adminUserId },
    select: { id: true, username: true, role: true, pageAccess: { select: { page: true } } }
  });

  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const allowedPages = allowedPagesFor(user.role, user.pageAccess.map((entry) => entry.page));
  req.session.role = user.role;
  req.session.allowedPages = allowedPages;
  res.json({ id: user.id, username: user.username, role: user.role, allowedPages });
});

export default router;

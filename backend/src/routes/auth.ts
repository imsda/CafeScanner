import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const router = Router();
const ALL_PAGES = ['DASHBOARD', 'SCAN', 'PEOPLE', 'IMPORT', 'BADGES', 'TRANSACTIONS', 'REPORTS', 'SETTINGS', 'USER_MANAGEMENT'] as const;

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.adminUser.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const pageAccess = await prisma.userPageAccess.findMany({ where: { adminUserId: user.id } });
  const allowedPages = user.role === 'ADMIN' ? [...ALL_PAGES] : pageAccess.map((entry) => entry.page);
  req.session.adminUserId = user.id;
  req.session.role = user.role;
  req.session.allowedPages = allowedPages;
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

  const allowedPages = user.role === 'ADMIN' ? [...ALL_PAGES] : user.pageAccess.map((entry) => entry.page);
  req.session.role = user.role;
  req.session.allowedPages = allowedPages;
  res.json({ id: user.id, username: user.username, role: user.role, allowedPages });
});

export default router;

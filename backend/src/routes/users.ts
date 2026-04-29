import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { AppPage } from '@prisma/client';
import { prisma } from '../db.js';

const router = Router();

const ALL_PAGES: AppPage[] = [AppPage.DASHBOARD, AppPage.SCAN, AppPage.PEOPLE, AppPage.IMPORT, AppPage.BADGES, AppPage.TRANSACTIONS, AppPage.REPORTS, AppPage.SETTINGS, AppPage.USER_MANAGEMENT];

function normalizePages(input: unknown): AppPage[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(ALL_PAGES);
  return [...new Set(input.filter((page): page is AppPage => typeof page === 'string' && allowed.has(page as AppPage)))];
}

router.get('/', async (_req, res) => {
  const users = await prisma.adminUser.findMany({
    orderBy: { username: 'asc' },
    include: { pageAccess: true }
  });

  res.json(users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    allowedPages: user.role === 'ADMIN' ? [...ALL_PAGES] : user.pageAccess.map((entry) => entry.page)
  })));
});

router.post('/', async (req, res) => {
  const { username, password, role, allowedPages } = req.body as { username?: string; password?: string; role?: 'ADMIN' | 'SCANNER'; allowedPages?: string[] };
  if (!username || !password || password.length < 4) return res.status(400).json({ error: 'Username and password (min 4 chars) are required' });

  const safeRole = role === 'SCANNER' ? 'SCANNER' : 'ADMIN';
  const safePages = normalizePages(allowedPages);
  const passwordHash = await bcrypt.hash(password, 10);

  const created = await prisma.adminUser.create({
    data: {
      username,
      passwordHash,
      role: safeRole,
      pageAccess: safeRole === 'ADMIN' ? undefined : { createMany: { data: safePages.map((page) => ({ page })) } }
    },
  });
  const createdAccess = await prisma.userPageAccess.findMany({ where: { adminUserId: created.id } });

  res.status(201).json({
    id: created.id,
    username: created.username,
    role: created.role,
    allowedPages: created.role === 'ADMIN' ? [...ALL_PAGES] : createdAccess.map((entry) => entry.page)
  });
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { password, role, allowedPages } = req.body as { password?: string; role?: 'ADMIN' | 'SCANNER'; allowedPages?: string[] };
  const safeRole = role === 'SCANNER' ? 'SCANNER' : role === 'ADMIN' ? 'ADMIN' : existing.role;
  const safePages = normalizePages(allowedPages);

  const updated = await prisma.$transaction(async (tx) => {
    if (existing.id === req.session.adminUserId && safeRole !== 'ADMIN') {
      throw new Error('You cannot remove your own admin role');
    }

    await tx.adminUser.update({
      where: { id },
      data: {
        role: safeRole,
        passwordHash: password && password.length >= 4 ? await bcrypt.hash(password, 10) : undefined
      }
    });

    await tx.userPageAccess.deleteMany({ where: { adminUserId: id } });
    if (safeRole !== 'ADMIN' && safePages.length > 0) {
      await tx.userPageAccess.createMany({ data: safePages.map((page) => ({ adminUserId: id, page })) });
    }

    return tx.adminUser.findUnique({ where: { id }, include: { pageAccess: true } });
  });

  res.json({
    id: updated!.id,
    username: updated!.username,
    role: updated!.role,
    allowedPages: updated!.role === 'ADMIN' ? [...ALL_PAGES] : updated!.pageAccess.map((entry) => entry.page)
  });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.role === 'ADMIN') {
    const adminCount = await prisma.adminUser.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin account' });
  }
  if (id === req.session.adminUserId) return res.status(400).json({ error: 'You cannot delete your own account' });

  await prisma.adminUser.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;

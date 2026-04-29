import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { AppPage, UserRole } from '@prisma/client';
import { prisma } from '../db.js';

const router = Router();
const ALL_PAGES: AppPage[] = [AppPage.DASHBOARD, AppPage.SCAN, AppPage.PEOPLE, AppPage.IMPORT, AppPage.BADGES, AppPage.TRANSACTIONS, AppPage.REPORTS, AppPage.SETTINGS, AppPage.USER_MANAGEMENT];
const SCANNER_PAGES: AppPage[] = [AppPage.SCAN];

function getAllowedPages(role: UserRole, customPages: AppPage[]): AppPage[] {
  if (role === 'OWNER' || role === 'ADMIN') return [...ALL_PAGES];
  if (role === 'SCANNER') return [...SCANNER_PAGES];
  return customPages;
}
const isOwnerSession = (req: any) => req.session?.role === 'OWNER';

function normalizePages(input: unknown): AppPage[] { if (!Array.isArray(input)) return []; const allowed = new Set(ALL_PAGES); return [...new Set(input.filter((p): p is AppPage => typeof p === 'string' && allowed.has(p as AppPage)))]; }

router.get('/', async (_req, res) => { const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' }, include: { pageAccess: true } }); res.json(users.map((u)=>({id:u.id,username:u.username,role:u.role,createdAt:u.createdAt,updatedAt:u.updatedAt,allowedPages:getAllowedPages(u.role,u.pageAccess.map(e=>e.page))}))); });

router.post('/', async (req, res) => {
  const { username, password, role, allowedPages } = req.body as any;
  if (!username || !password || password.length < 4) return res.status(400).json({ error: 'Username and password (min 4 chars) are required' });
  const requestedRole: UserRole = role === 'OWNER' ? 'OWNER' : role === 'SCANNER' ? 'SCANNER' : role === 'CUSTOM' ? 'CUSTOM' : 'ADMIN';
  if (requestedRole === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can create OWNER users' });
  const safeRole: UserRole = requestedRole;
  const safePages = normalizePages(allowedPages);
  const passwordHash = await bcrypt.hash(password, 10);
  const created = await prisma.adminUser.create({ data: { username, passwordHash, role: safeRole, pageAccess: safeRole === 'CUSTOM' ? { createMany: { data: safePages.map((page) => ({ page })) } } : undefined } });
  const createdAccess = await prisma.userPageAccess.findMany({ where: { adminUserId: created.id } });
  res.status(201).json({ id: created.id, username: created.username, role: created.role, allowedPages: getAllowedPages(created.role, createdAccess.map((entry) => entry.page)) });
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id); if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
  const existing = await prisma.adminUser.findUnique({ where: { id } }); if (!existing) return res.status(404).json({ error: 'User not found' });
  if (existing.role === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can manage OWNER users' });
  const { password, role, allowedPages } = req.body as any;
  const requestedRole: UserRole = role === 'OWNER' ? 'OWNER' : role === 'SCANNER' ? 'SCANNER' : role === 'CUSTOM' ? 'CUSTOM' : role === 'ADMIN' ? 'ADMIN' : existing.role;
  if (requestedRole === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can assign OWNER role' });
  if (existing.role === 'OWNER' && requestedRole !== 'OWNER') {
    const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } });
    if (ownerCount <= 1) return res.status(400).json({ error: 'Cannot demote the last OWNER' });
  }
  const safePages = normalizePages(allowedPages);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id }, data: { role: requestedRole, passwordHash: password && password.length >= 4 ? await bcrypt.hash(password, 10) : undefined } });
    await tx.userPageAccess.deleteMany({ where: { adminUserId: id } });
    if (requestedRole === 'CUSTOM' && safePages.length > 0) await tx.userPageAccess.createMany({ data: safePages.map((page) => ({ adminUserId: id, page })) });
    return tx.adminUser.findUnique({ where: { id }, include: { pageAccess: true } });
  });
  res.json({ id: updated!.id, username: updated!.username, role: updated!.role, allowedPages: getAllowedPages(updated!.role, updated!.pageAccess.map((entry) => entry.page)) });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id); if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
  const target = await prisma.adminUser.findUnique({ where: { id } }); if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can manage OWNER users' });
  if (target.role === 'OWNER') { const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } }); if (ownerCount <= 1) return res.status(400).json({ error: 'Cannot delete the last OWNER' }); }
  if (id === req.session.adminUserId) return res.status(400).json({ error: 'You cannot delete your own account' });
  await prisma.adminUser.delete({ where: { id } }); res.json({ ok: true });
});

export default router;

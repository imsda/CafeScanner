import { asyncRouter } from '../utils/asyncRouter.js';
import bcrypt from 'bcryptjs';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { allowedPagesFor, normalizeCustomPages } from '../utils/pages.js';

const router = asyncRouter();

const roleSchema = z.enum(['OWNER', 'ADMIN', 'SCANNER', 'CUSTOM']);
const createUserSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  role: roleSchema.default('ADMIN'),
  allowedPages: z.array(z.string()).optional()
});
const updateUserSchema = z.object({
  password: z.string().optional(),
  role: roleSchema.optional(),
  allowedPages: z.array(z.string()).optional()
});

const isOwnerSession = (req: Request) => req.session.role === 'OWNER';

function minPasswordLength(role: UserRole) {
  return role === 'SCANNER' ? 4 : 12;
}

function parseUserId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toUserResponse(user: { id: number; username: string; role: UserRole; pageAccess: Array<{ page: Parameters<typeof allowedPagesFor>[1][number] }>; createdAt?: Date; updatedAt?: Date }) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    ...(user.createdAt ? { createdAt: user.createdAt, updatedAt: user.updatedAt } : {}),
    allowedPages: allowedPagesFor(user.role, user.pageAccess.map((entry) => entry.page))
  };
}

router.get('/', async (_req, res) => {
  const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' }, include: { pageAccess: true } });
  res.json(users.map(toUserResponse));
});

router.post('/', async (req, res) => {
  const { username, password, role, allowedPages } = createUserSchema.parse(req.body);
  if (role === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can create OWNER users' });

  const minPassword = minPasswordLength(role);
  if (password.length < minPassword) {
    return res.status(400).json({ error: `Password must be at least ${minPassword} characters for ${role} accounts` });
  }

  const pages = normalizeCustomPages(allowedPages);
  const passwordHash = await bcrypt.hash(password, 10);
  const created = await prisma.adminUser.create({
    data: { username, passwordHash, role, pageAccess: role === 'CUSTOM' ? { createMany: { data: pages.map((page) => ({ page })) } } : undefined },
    include: { pageAccess: true }
  });
  res.status(201).json(toUserResponse(created));
});

router.patch('/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const existing = await prisma.adminUser.findUnique({ where: { id }, include: { pageAccess: true } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (existing.role === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can manage OWNER users' });

  const { password, role, allowedPages } = updateUserSchema.parse(req.body);
  const requestedRole: UserRole = role ?? existing.role;
  if (requestedRole === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can assign OWNER role' });
  if (existing.role === 'OWNER' && requestedRole !== 'OWNER') {
    const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } });
    if (ownerCount <= 1) return res.status(400).json({ error: 'Cannot demote the last OWNER' });
  }
  const minPassword = minPasswordLength(requestedRole);
  if (password && password.length < minPassword) {
    return res.status(400).json({ error: `Password must be at least ${minPassword} characters for ${requestedRole} accounts` });
  }

  const pages = allowedPages === undefined
    ? normalizeCustomPages(existing.pageAccess.map((entry) => entry.page))
    : normalizeCustomPages(allowedPages);
  const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id }, data: { role: requestedRole, passwordHash } });
    await tx.userPageAccess.deleteMany({ where: { adminUserId: id } });
    if (requestedRole === 'CUSTOM' && pages.length > 0) await tx.userPageAccess.createMany({ data: pages.map((page) => ({ adminUserId: id, page })) });
    return tx.adminUser.findUniqueOrThrow({ where: { id }, include: { pageAccess: true } });
  });
  res.json(toUserResponse(updated));
});

router.delete('/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'OWNER' && !isOwnerSession(req)) return res.status(403).json({ error: 'Only OWNER can manage OWNER users' });
  if (target.role === 'OWNER') {
    const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } });
    if (ownerCount <= 1) return res.status(400).json({ error: 'Cannot delete the last OWNER' });
  }
  if (id === req.session.adminUserId) return res.status(400).json({ error: 'You cannot delete your own account' });
  await prisma.adminUser.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;

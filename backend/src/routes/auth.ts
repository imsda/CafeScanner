import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.adminUser.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.adminUserId = user.id;
  req.session.role = user.role;
  res.json({ id: user.id, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  if (!req.session.adminUserId) return res.status(401).json({ error: 'Unauthorized' });

  const user = await prisma.adminUser.findUnique({
    where: { id: req.session.adminUserId },
    select: { id: true, username: true, role: true }
  });

  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  req.session.role = user.role;
  res.json(user);
});

export default router;

import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

router.get('/', async (_req, res) => {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  res.json(settings);
});

router.put('/', async (req, res) => {
  const updated = await prisma.setting.update({ where: { id: 1 }, data: req.body });
  res.json(updated);
});

export default router;

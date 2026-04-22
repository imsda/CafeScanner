import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

router.get('/meal-usage', async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86400000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const grouped = await prisma.scanTransaction.groupBy({
    by: ['mealType', 'result'],
    where: { timestamp: { gte: from, lte: to } },
    _count: { id: true }
  });
  res.json({ from, to, grouped });
});

export default router;

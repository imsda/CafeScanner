import { Router } from 'express';
import { startOfDay } from 'date-fns';
import { prisma } from '../db.js';

const router = Router();

router.get('/summary', async (_req, res) => {
  const today = startOfDay(new Date());
  const [totalPeople, activePeople, scansToday, failedScansToday, breakfasts, lunches, dinners] = await Promise.all([
    prisma.person.count(),
    prisma.person.count({ where: { active: true } }),
    prisma.scanTransaction.count({ where: { timestamp: { gte: today } } }),
    prisma.scanTransaction.count({ where: { timestamp: { gte: today }, result: 'FAILURE' } }),
    prisma.scanTransaction.count({ where: { timestamp: { gte: today }, result: 'SUCCESS', mealType: 'BREAKFAST' } }),
    prisma.scanTransaction.count({ where: { timestamp: { gte: today }, result: 'SUCCESS', mealType: 'LUNCH' } }),
    prisma.scanTransaction.count({ where: { timestamp: { gte: today }, result: 'SUCCESS', mealType: 'DINNER' } })
  ]);

  res.json({ totalPeople, activePeople, scansToday, failedScansToday, breakfastsServedToday: breakfasts, lunchesServedToday: lunches, dinnersServedToday: dinners });
});

export default router;

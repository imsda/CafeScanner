import { asyncRouter } from '../utils/asyncRouter.js';
import { prisma } from '../db.js';
import { localDateKey, resolveTimezone, startOfLocalDay } from '../utils/timezone.js';

const router = asyncRouter();

router.get('/summary', async (_req, res) => {
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { timezone: true } });
  const timezone = resolveTimezone(settings?.timezone);
  // "Today" is the school's calendar day, not the server's.
  const today = startOfLocalDay(localDateKey(new Date(), timezone), timezone);
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

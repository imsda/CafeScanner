import { MealType, ScanResult } from '@prisma/client';
import { Router } from 'express';
import { endOfDay, startOfDay } from 'date-fns';
import { Parser } from 'json2csv';
import { prisma } from '../db.js';

const router = Router();

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

router.get('/summary', async (req, res) => {
  const from = startOfDay(parseDate(req.query.from, new Date()));
  const to = endOfDay(parseDate(req.query.to, new Date()));

  const [transactions, people, settings] = await Promise.all([
    prisma.scanTransaction.findMany({
      where: { timestamp: { gte: from, lte: to } },
      include: {
        person: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            personId: true
          }
        }
      },
      orderBy: { timestamp: 'desc' }
    }),
    prisma.person.findMany({
      where: { active: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        personId: true,
        breakfastRemaining: true,
        lunchRemaining: true,
        dinnerRemaining: true,
        breakfastCount: true,
        lunchCount: true,
        dinnerCount: true,
        totalMealsCount: true
      }
    }),
    prisma.setting.findUnique({ where: { id: 1 }, select: { mealTrackingMode: true } })
  ]);

  const mealCounts = { BREAKFAST: 0, LUNCH: 0, DINNER: 0 };
  let failedScans = 0;

  const perPersonMap = new Map<number, { personId: string; firstName: string; lastName: string; breakfasts: number; lunches: number; dinners: number; total: number }>();

  for (const tx of transactions) {
    if (tx.result === ScanResult.FAILURE) {
      failedScans += 1;
      continue;
    }

    if (tx.mealType === MealType.BREAKFAST || tx.mealType === MealType.LUNCH || tx.mealType === MealType.DINNER) {
      mealCounts[tx.mealType] += 1;
    }

    if (tx.person) {
      const existing = perPersonMap.get(tx.person.id) ?? {
        personId: tx.person.personId,
        firstName: tx.person.firstName,
        lastName: tx.person.lastName,
        breakfasts: 0,
        lunches: 0,
        dinners: 0,
        total: 0
      };

      if (tx.mealType === MealType.BREAKFAST) existing.breakfasts += 1;
      if (tx.mealType === MealType.LUNCH) existing.lunches += 1;
      if (tx.mealType === MealType.DINNER) existing.dinners += 1;
      existing.total += 1;
      perPersonMap.set(tx.person.id, existing);
    }
  }

  const remainingBalanceSummary = people.reduce(
    (acc, person) => {
      acc.breakfastRemaining += person.breakfastRemaining;
      acc.lunchRemaining += person.lunchRemaining;
      acc.dinnerRemaining += person.dinnerRemaining;
      return acc;
    },
    { breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0 }
  );

  const tallySummary = people.reduce(
    (acc, person) => {
      acc.breakfastCount += person.breakfastCount;
      acc.lunchCount += person.lunchCount;
      acc.dinnerCount += person.dinnerCount;
      acc.totalMealsCount += person.totalMealsCount;
      return acc;
    },
    { breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalMealsCount: 0 }
  );

  const mealTotalsByPerson = Array.from(perPersonMap.values()).sort((a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName));

  res.json({
    from,
    to,
    mealTrackingMode: settings?.mealTrackingMode ?? 'countdown',
    stats: {
      scans: transactions.length,
      breakfastsServed: mealCounts.BREAKFAST,
      lunchesServed: mealCounts.LUNCH,
      dinnersServed: mealCounts.DINNER,
      failedScans
    },
    mealTotalsByPerson,
    perPersonUsage: mealTotalsByPerson,
    remainingBalanceSummary,
    tallySummary,
    transactions
  });
});

router.get('/meal-totals.csv', async (req, res) => {
  const from = startOfDay(parseDate(req.query.from, new Date()));
  const to = endOfDay(parseDate(req.query.to, new Date()));

  const transactions = await prisma.scanTransaction.findMany({
    where: { timestamp: { gte: from, lte: to }, result: ScanResult.SUCCESS },
    include: {
      person: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          personId: true
        }
      }
    }
  });

  const perPersonMap = new Map<number, { name: string; personId: string; totalMeals: number; breakfast: number; lunch: number; dinner: number }>();

  for (const tx of transactions) {
    if (!tx.person) continue;

    const existing = perPersonMap.get(tx.person.id) ?? {
      name: `${tx.person.firstName} ${tx.person.lastName}`.trim(),
      personId: tx.person.personId,
      totalMeals: 0,
      breakfast: 0,
      lunch: 0,
      dinner: 0
    };

    if (tx.mealType === MealType.BREAKFAST) existing.breakfast += 1;
    if (tx.mealType === MealType.LUNCH) existing.lunch += 1;
    if (tx.mealType === MealType.DINNER) existing.dinner += 1;
    existing.totalMeals += 1;
    perPersonMap.set(tx.person.id, existing);
  }

  const rows = Array.from(perPersonMap.values()).sort((a, b) => b.totalMeals - a.totalMeals || a.name.localeCompare(b.name));
  const parser = new Parser({
    fields: ['name', 'personId', 'totalMeals', 'breakfast', 'lunch', 'dinner']
  });

  const csv = parser.parse(rows as unknown as Record<string, unknown>[]);
  res.header('Content-Type', 'text/csv');
  res.attachment('meal-totals-by-person.csv');
  res.send(csv);
});

router.get('/export.csv', async (req, res) => {
  const from = startOfDay(parseDate(req.query.from, new Date()));
  const to = endOfDay(parseDate(req.query.to, new Date()));

  const rows = await prisma.scanTransaction.findMany({
    where: { timestamp: { gte: from, lte: to } },
    include: { person: true },
    orderBy: { timestamp: 'desc' }
  });

  const parser = new Parser({
    fields: [
      'timestamp',
      'scannedValue',
      'mealType',
      'result',
      'failureReason',
      'stationName',
      'person.firstName',
      'person.lastName',
      'person.personId'
    ]
  });

  const csv = parser.parse(rows as unknown as Record<string, unknown>[]);
  res.header('Content-Type', 'text/csv');
  res.attachment('report-transactions.csv');
  res.send(csv);
});

export default router;

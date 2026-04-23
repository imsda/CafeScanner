import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { Router } from 'express';
import { endOfDay, startOfDay } from 'date-fns';
import { Parser } from 'json2csv';
import { prisma } from '../db.js';
import { getMealTotalsByPerson } from '../services/mealTotalsReport.js';

const router = Router();

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, yearRaw, monthRaw, dayRaw] = dateOnlyMatch;
    const year = Number(yearRaw);
    const monthIndex = Number(monthRaw) - 1;
    const day = Number(dayRaw);
    const parsedLocal = new Date(year, monthIndex, day);

    if (
      Number.isNaN(parsedLocal.getTime())
      || parsedLocal.getFullYear() !== year
      || parsedLocal.getMonth() !== monthIndex
      || parsedLocal.getDate() !== day
    ) {
      return fallback;
    }

    return parsedLocal;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function resolveDateRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const fromQuery = query.startDate ?? query.from;
  const toQuery = query.endDate ?? query.to;

  const from = startOfDay(parseDate(fromQuery, new Date(0)));
  const to = endOfDay(parseDate(toQuery, new Date()));

  return { from, to };
}

router.get('/summary', async (req, res) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

  const [transactions, people, settings, entitlementAgg] = await Promise.all([
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
    prisma.setting.findUnique({ where: { id: 1 }, select: { mealTrackingMode: true } }),
    prisma.mealEntitlement.aggregate({
      _count: { _all: true },
      where: {}
    })
  ]);

  const mealCounts = { BREAKFAST: 0, LUNCH: 0, DINNER: 0 };
  let failedScans = 0;

  for (const tx of transactions) {
    if (tx.result === ScanResult.FAILURE) {
      failedScans += 1;
      continue;
    }

    if (tx.mealType === MealType.BREAKFAST || tx.mealType === MealType.LUNCH || tx.mealType === MealType.DINNER) {
      mealCounts[tx.mealType] += 1;
    }
  }

  const mealTrackingMode = settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;
  const mealTotalsByPerson = await getMealTotalsByPerson({ from, to, mealTrackingMode });

  const redeemedEntitlements = await prisma.mealEntitlement.count({
    where: {
      redeemed: true,
      redeemedAt: { gte: from, lte: to }
    }
  });


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

  res.json({
    from,
    to,
    mealTrackingMode,
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
    entitlementSummary: {
      totalEntitlements: entitlementAgg._count._all,
      totalRedeemed: redeemedEntitlements,
      totalRemaining: Math.max(0, entitlementAgg._count._all - redeemedEntitlements)
    },
    transactions
  });
});

router.get('/meal-totals.csv', async (req, res) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { mealTrackingMode: true } });
  const mealTrackingMode = settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[reports/meal-totals.csv] input', {
      from: from.toISOString(),
      to: to.toISOString(),
      mode: mealTrackingMode
    });
  }

  const reportRows = await getMealTotalsByPerson({ from, to, mealTrackingMode });

  if (process.env.NODE_ENV !== 'production') {
    console.log('[reports/meal-totals.csv] rows', reportRows.length);
  }

  const rows = reportRows.map((row) => ({
    name: `${row.firstName} ${row.lastName}`.trim(),
    personId: row.personId,
    totalMeals: row.total,
    breakfast: row.breakfasts,
    lunch: row.lunches,
    dinner: row.dinners
  }));

  const parser = new Parser({
    fields: ['name', 'personId', 'totalMeals', 'breakfast', 'lunch', 'dinner']
  });

  const csv = parser.parse(rows as unknown as Record<string, unknown>[]);
  res.header('Content-Type', 'text/csv');
  res.attachment('meal-totals-by-person.csv');
  res.send(csv);
});

router.get('/export.csv', async (req, res) => {
  const { from, to } = resolveDateRange(req.query as Record<string, unknown>);

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
      'entitlementId',
      'entitlementPersonName',
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

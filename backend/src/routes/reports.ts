import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { asyncRouter } from '../utils/asyncRouter.js';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { STUDENT_PERSON_TYPES } from '../utils/personType.js';
import { toCsv } from '../utils/csv.js';
import { endOfLocalDay, localDateKey, parseQueryDate, resolveTimezone } from '../utils/timezone.js';
import { prisma } from '../db.js';
import { getMealTotalsByPerson } from '../services/mealTotalsReport.js';
import { clearStudentMealWarning, getStudentsNotEating } from '../services/studentMealWarningService.js';

const router = asyncRouter();

router.get('/students-not-eating', async (_req, res) => {
  res.json(await getStudentsNotEating());
});

const warningSettingsSchema = z.object({ villageStudentMealWarningsEnabled: z.boolean() });

// Admin-only switch shown on the Reports page; also editable via PUT /api/settings.
router.put('/students-not-eating/settings', requireAdmin, async (req, res) => {
  const { villageStudentMealWarningsEnabled } = warningSettingsSchema.parse(req.body);
  await prisma.setting.update({ where: { id: 1 }, data: { villageStudentMealWarningsEnabled } });
  console.log(`[ADMIN_ACTION] villageStudentMealWarningsEnabled=${villageStudentMealWarningsEnabled} by userId=${req.session.adminUserId ?? 'unknown'}`);
  res.json(await getStudentsNotEating());
});

router.post('/students-not-eating/:personId/clear', async (req, res) => {
  const personId = Number(req.params.personId);
  if (!Number.isInteger(personId) || personId <= 0) return res.status(400).json({ error: 'Invalid student.' });
  try {
    return res.json({ ok: true, person: await clearStudentMealWarning(personId) });
  } catch {
    return res.status(404).json({ error: 'Student warning not found.' });
  }
});

// Date-only startDate/endDate (or from/to) values are whole days in the school timezone.
// Defaults: from the beginning of records until the end of today.
async function resolveDateRange(query: Record<string, unknown>): Promise<{ from: Date; to: Date }> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { timezone: true } });
  const timezone = resolveTimezone(settings?.timezone);
  const from = parseQueryDate(query.startDate ?? query.from, timezone, 'start') ?? new Date(0);
  const to = parseQueryDate(query.endDate ?? query.to, timezone, 'end') ?? endOfLocalDay(localDateKey(new Date(), timezone), timezone);
  return { from, to };
}

router.get('/summary', async (req, res) => {
  const { from, to } = await resolveDateRange(req.query as Record<string, unknown>);

  const [transactions, people, settings, entitlementAgg] = await Promise.all([
    prisma.scanTransaction.findMany({
      where: { timestamp: { gte: from, lte: to } },
      include: {
        person: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            personId: true,
            personType: true
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

  const tallySummary = mealTrackingMode === MealTrackingMode.tally
    ? {
        breakfastCount: mealCounts.BREAKFAST,
        lunchCount: mealCounts.LUNCH,
        dinnerCount: mealCounts.DINNER,
        totalMealsCount: mealCounts.BREAKFAST + mealCounts.LUNCH + mealCounts.DINNER
      }
    : people.reduce(
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

// Optional ?personType= filter for the meal totals export (matches the Reports page filter).
const mealTotalsFilterSchema = z.object({
  personType: z.enum(['ALL', 'ALL_STUDENTS', 'STUDENT', 'VILLAGE_STUDENT', 'STAFF', 'GUEST']).default('ALL')
});

function matchesPersonTypeFilter(personType: string, filter: z.infer<typeof mealTotalsFilterSchema>['personType']) {
  if (filter === 'ALL') return true;
  if (filter === 'ALL_STUDENTS') return STUDENT_PERSON_TYPES.includes(personType as (typeof STUDENT_PERSON_TYPES)[number]);
  return personType === filter;
}

router.get('/meal-totals.csv', async (req, res) => {
  const { personType: personTypeFilter } = mealTotalsFilterSchema.parse(req.query);
  const { from, to } = await resolveDateRange(req.query as Record<string, unknown>);
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

  const rows = reportRows.filter((row) => matchesPersonTypeFilter(row.personType, personTypeFilter)).map((row) => ({
    name: `${row.firstName} ${row.lastName}`.trim(),
    personId: row.personId,
    personType: row.personType,
    totalMeals: row.total,
    breakfast: row.breakfasts,
    lunch: row.lunches,
    dinner: row.dinners
  }));

  const csv = toCsv(rows, ['name', 'personId', 'personType', 'totalMeals', 'breakfast', 'lunch', 'dinner']);
  res.header('Content-Type', 'text/csv');
  res.attachment(personTypeFilter === 'ALL' ? 'meal-totals-by-person.csv' : `meal-totals-by-person-${personTypeFilter.toLowerCase().replace(/_/g, '-')}.csv`);
  res.send(csv);
});

router.get('/export.csv', async (req, res) => {
  const { from, to } = await resolveDateRange(req.query as Record<string, unknown>);

  const rows = await prisma.scanTransaction.findMany({
    where: { timestamp: { gte: from, lte: to } },
    include: { person: true },
    orderBy: { timestamp: 'desc' }
  });

  const csv = toCsv(rows, [
    'timestamp', 'scannedValue', 'mealType', 'result', 'failureReason', 'stationName',
    'entitlementId', 'entitlementPersonName', 'person.firstName', 'person.lastName', 'person.personId', 'person.personType'
  ]);
  res.header('Content-Type', 'text/csv');
  res.attachment('report-transactions.csv');
  res.send(csv);
});

export default router;

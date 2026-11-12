import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { asyncRouter } from '../utils/asyncRouter.js';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { STUDENT_PERSON_TYPES } from '../utils/personType.js';
import { toCsv } from '../utils/csv.js';
import { endOfLocalDay, localDateKey, parseQueryDate, resolveTimezone } from '../utils/timezone.js';
import { prisma } from '../db.js';
import { EXPORT_ROW_LIMIT } from './transactions.js';
import { getMealTotalsByPerson } from '../services/mealTotalsReport.js';
import { clearStudentMealWarning, getStudentsNotEating, invalidateStudentWarningCache } from '../services/studentMealWarningService.js';

const router = asyncRouter();

router.get('/students-not-eating', async (_req, res) => {
  res.json(await getStudentsNotEating());
});

const warningSettingsSchema = z.object({ villageStudentMealWarningsEnabled: z.boolean() });

// Admin-only switch shown on the Reports page; also editable via PUT /api/settings.
router.put('/students-not-eating/settings', requireAdmin, async (req, res) => {
  const { villageStudentMealWarningsEnabled } = warningSettingsSchema.parse(req.body);
  await prisma.setting.update({ where: { id: 1 }, data: { villageStudentMealWarningsEnabled } });
  invalidateStudentWarningCache();
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

  const range = { timestamp: { gte: from, lte: to } };

  // Aggregates only: the scans themselves are never loaded or returned here
  // (GET /api/transactions serves the rows, paged).
  const [scans, scanGroups, personSums, settings, totalEntitlements, redeemedEntitlements] = await Promise.all([
    prisma.scanTransaction.count({ where: range }),
    prisma.scanTransaction.groupBy({ by: ['mealType', 'result'], where: range, _count: { _all: true } }),
    prisma.person.aggregate({
      where: { active: true },
      _sum: {
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
    prisma.mealEntitlement.count(),
    prisma.mealEntitlement.count({ where: { redeemed: true, redeemedAt: { gte: from, lte: to } } })
  ]);

  const mealCounts = { BREAKFAST: 0, LUNCH: 0, DINNER: 0 };
  let failedScans = 0;

  for (const group of scanGroups) {
    if (group.result === ScanResult.FAILURE) {
      failedScans += group._count._all;
      continue;
    }

    if (group.mealType === MealType.BREAKFAST || group.mealType === MealType.LUNCH || group.mealType === MealType.DINNER) {
      mealCounts[group.mealType] += group._count._all;
    }
  }

  const mealTrackingMode = settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;
  const mealTotalsByPerson = await getMealTotalsByPerson({ from, to, mealTrackingMode });

  const remainingBalanceSummary = {
    breakfastRemaining: personSums._sum.breakfastRemaining ?? 0,
    lunchRemaining: personSums._sum.lunchRemaining ?? 0,
    dinnerRemaining: personSums._sum.dinnerRemaining ?? 0
  };

  const tallySummary = mealTrackingMode === MealTrackingMode.tally
    ? {
        breakfastCount: mealCounts.BREAKFAST,
        lunchCount: mealCounts.LUNCH,
        dinnerCount: mealCounts.DINNER,
        totalMealsCount: mealCounts.BREAKFAST + mealCounts.LUNCH + mealCounts.DINNER
      }
    : {
        breakfastCount: personSums._sum.breakfastCount ?? 0,
        lunchCount: personSums._sum.lunchCount ?? 0,
        dinnerCount: personSums._sum.dinnerCount ?? 0,
        totalMealsCount: personSums._sum.totalMealsCount ?? 0
      };

  res.json({
    from,
    to,
    mealTrackingMode,
    stats: {
      scans,
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
      totalEntitlements,
      totalRedeemed: redeemedEntitlements,
      totalRemaining: Math.max(0, totalEntitlements - redeemedEntitlements)
    }
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
    orderBy: { timestamp: 'desc' },
    // Same cap as the Transactions export, so one request cannot load an unbounded history.
    take: EXPORT_ROW_LIMIT
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

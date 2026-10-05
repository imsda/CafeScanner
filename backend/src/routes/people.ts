import { asyncRouter } from '../utils/asyncRouter.js';
import { prisma } from '../db.js';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { PERSON_TYPE_VALUES } from '../utils/personType.js';
import { localMealDay, resolveTimezone } from '../utils/timezone.js';

const router = asyncRouter();
// People are not login accounts, so the phrase says PERSON (it used to say USER).
const DELETE_CONFIRMATION_PHRASE = 'DELETE PERSON';

function parseIdParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Invalid person id'), { status: 400 });
  return id;
}

const adjustBalanceSchema = z.object({
  breakfastDelta: z.number().int().default(0),
  lunchDelta: z.number().int().default(0),
  dinnerDelta: z.number().int().default(0)
});

const balance = z.number().int().nonnegative();
const bulkSetSchema = z.object({
  breakfast: balance.optional(),
  lunch: balance.optional(),
  dinner: balance.optional(),
  grade: z.string().optional(),
  group: z.string().optional(),
  campus: z.string().optional()
});

const personSchema = z.object({
  personType: z.enum(PERSON_TYPE_VALUES).default('GUEST'),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  personId: z.string().min(1),
  codeValue: z.string().optional(),
  breakfastRemaining: z.number().int().nonnegative().default(0),
  lunchRemaining: z.number().int().nonnegative().default(0),
  dinnerRemaining: z.number().int().nonnegative().default(0),
  breakfastCount: z.number().int().nonnegative().default(0),
  lunchCount: z.number().int().nonnegative().default(0),
  dinnerCount: z.number().int().nonnegative().default(0),
  totalMealsCount: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
  grade: z.string().optional().nullable(),
  group: z.string().optional().nullable(),
  campus: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

router.get('/', async (req, res) => {
  const showInactive = req.query.showInactive === 'true';
  const [people, settings] = await Promise.all([
    prisma.person.findMany({ where: showInactive ? {} : { active: true }, orderBy: [{ lastName: 'asc' }] }),
    prisma.setting.findUnique({ where: { id: 1 }, select: { timezone: true } })
  ]);

  const todayMealDay = localMealDay(new Date(), resolveTimezone(settings?.timezone));

  type MealBreakdown = {
    total: number;
    redeemed: number;
    BREAKFAST: { total: number; redeemed: number; available: number; todayAvailable: number };
    LUNCH: { total: number; redeemed: number; available: number; todayAvailable: number };
    DINNER: { total: number; redeemed: number; available: number; todayAvailable: number };
  };

  const createMealBreakdown = (): MealBreakdown => ({
    total: 0,
    redeemed: 0,
    BREAKFAST: { total: 0, redeemed: 0, available: 0, todayAvailable: 0 },
    LUNCH: { total: 0, redeemed: 0, available: 0, todayAvailable: 0 },
    DINNER: { total: 0, redeemed: 0, available: 0, todayAvailable: 0 }
  });

  const summaryByPersonId = new Map<string, MealBreakdown>();
  const [
    totalsByPersonAndMeal,
    redeemedByPersonAndMeal,
    availableByPersonAndMeal,
    todayAvailableByPersonAndMeal
  ] = await Promise.all([
    prisma.mealEntitlement.groupBy({
      by: ['personId', 'mealType'],
      where: { mealType: { in: ['BREAKFAST', 'LUNCH', 'DINNER'] } },
      _count: { _all: true }
    }),
    prisma.mealEntitlement.groupBy({
      by: ['personId', 'mealType'],
      where: { mealType: { in: ['BREAKFAST', 'LUNCH', 'DINNER'] }, redeemed: true },
      _count: { _all: true }
    }),
    prisma.mealEntitlement.groupBy({
      by: ['personId', 'mealType'],
      where: { mealType: { in: ['BREAKFAST', 'LUNCH', 'DINNER'] }, redeemed: false },
      _count: { _all: true }
    }),
    prisma.mealEntitlement.groupBy({
      by: ['personId', 'mealType'],
      where: {
        mealType: { in: ['BREAKFAST', 'LUNCH', 'DINNER'] },
        redeemed: false,
        mealDay: todayMealDay
      },
      _count: { _all: true }
    })
  ]);

  const ensureSummary = (personId: string): MealBreakdown => {
    const existing = summaryByPersonId.get(personId);
    if (existing) return existing;
    const created = createMealBreakdown();
    summaryByPersonId.set(personId, created);
    return created;
  };

  for (const row of totalsByPersonAndMeal) {
    const personId = row.personId.trim();
    const mealType = row.mealType as 'BREAKFAST' | 'LUNCH' | 'DINNER';
    if (!personId) continue;
    const summary = ensureSummary(personId);
    summary.total += row._count._all;
    summary[mealType].total += row._count._all;
  }

  for (const row of redeemedByPersonAndMeal) {
    const personId = row.personId.trim();
    const mealType = row.mealType as 'BREAKFAST' | 'LUNCH' | 'DINNER';
    if (!personId) continue;
    const summary = ensureSummary(personId);
    summary.redeemed += row._count._all;
    summary[mealType].redeemed += row._count._all;
  }

  for (const row of availableByPersonAndMeal) {
    const personId = row.personId.trim();
    const mealType = row.mealType as 'BREAKFAST' | 'LUNCH' | 'DINNER';
    if (!personId) continue;
    const summary = ensureSummary(personId);
    summary[mealType].available += row._count._all;
  }

  for (const row of todayAvailableByPersonAndMeal) {
    const personId = row.personId.trim();
    const mealType = row.mealType as 'BREAKFAST' | 'LUNCH' | 'DINNER';
    if (!personId) continue;
    const summary = ensureSummary(personId);
    summary[mealType].todayAvailable += row._count._all;
  }

  const entitlementNames = await prisma.mealEntitlement.groupBy({
    by: ['personId', 'personName'],
    where: {
      personName: {
        not: null
      }
    },
    _count: { _all: true }
  });

  const namesByPersonId = new Map<string, string[]>();
  for (const row of entitlementNames) {
    const id = row.personId.trim();
    const name = (row.personName || '').trim();
    if (!id || !name) continue;
    const existing = namesByPersonId.get(id) ?? [];
    if (!existing.includes(name)) existing.push(name);
    namesByPersonId.set(id, existing);
  }

  const enriched = people.map((person) => {
    const summary = summaryByPersonId.get(person.personId) ?? createMealBreakdown();
    const associatedNames = namesByPersonId.get(person.personId) ?? [`${person.firstName} ${person.lastName}`.trim()];
    return {
      ...person,
      associatedNames,
      associatedNamesSummary: associatedNames.join(', '),
      campMeetingEntitlements: summary.total,
      campMeetingRedeemed: summary.redeemed,
      campMeetingRemaining: Math.max(0, summary.total - summary.redeemed),
      breakfastTotal: summary.BREAKFAST.total,
      lunchTotal: summary.LUNCH.total,
      dinnerTotal: summary.DINNER.total,
      breakfastAvailable: summary.BREAKFAST.available,
      lunchAvailable: summary.LUNCH.available,
      dinnerAvailable: summary.DINNER.available,
      breakfastRedeemed: summary.BREAKFAST.redeemed,
      lunchRedeemed: summary.LUNCH.redeemed,
      dinnerRedeemed: summary.DINNER.redeemed,
      todayBreakfastAvailable: summary.BREAKFAST.todayAvailable,
      todayLunchAvailable: summary.LUNCH.todayAvailable,
      todayDinnerAvailable: summary.DINNER.todayAvailable
    };
  });

  res.json(enriched);
});

router.post('/', async (req, res) => {
  const payload = personSchema.parse(req.body);
  const person = await prisma.person.create({ data: { ...payload, codeValue: payload.codeValue || nanoid(10) } });
  res.status(201).json(person);
});

router.put('/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  const payload = personSchema.partial().parse(req.body);

  const hasAnyTallyField = payload.breakfastCount !== undefined || payload.lunchCount !== undefined || payload.dinnerCount !== undefined;
  if (hasAnyTallyField) {
    const existing = await prisma.person.findUniqueOrThrow({
      where: { id },
      select: { breakfastCount: true, lunchCount: true, dinnerCount: true }
    });

    const breakfastCount = payload.breakfastCount ?? existing.breakfastCount;
    const lunchCount = payload.lunchCount ?? existing.lunchCount;
    const dinnerCount = payload.dinnerCount ?? existing.dinnerCount;
    payload.totalMealsCount = breakfastCount + lunchCount + dinnerCount;
  }

  const person = await prisma.person.update({ where: { id }, data: payload });
  res.json(person);
});

router.post('/adjust-balance/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  const { breakfastDelta, lunchDelta, dinnerDelta } = adjustBalanceSchema.parse(req.body ?? {});
  // Read and write in one transaction so a concurrent scan's decrement is not lost.
  const updated = await prisma.$transaction(async (tx) => {
    const person = await tx.person.findUniqueOrThrow({ where: { id } });
    return tx.person.update({
      where: { id },
      data: {
        breakfastRemaining: Math.max(0, person.breakfastRemaining + breakfastDelta),
        lunchRemaining: Math.max(0, person.lunchRemaining + lunchDelta),
        dinnerRemaining: Math.max(0, person.dinnerRemaining + dinnerDelta)
      }
    });
  });
  res.json(updated);
});

router.post('/reset-tallies/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  const updated = await prisma.person.update({
    where: { id },
    data: {
      breakfastCount: 0,
      lunchCount: 0,
      dinnerCount: 0,
      totalMealsCount: 0
    }
  });
  res.json(updated);
});

router.post('/bulk-set', async (req, res) => {
  const { breakfast, lunch, dinner, grade, group, campus } = bulkSetSchema.parse(req.body ?? {});
  const where = { active: true, ...(grade ? { grade } : {}), ...(group ? { group } : {}), ...(campus ? { campus } : {}) };
  const result = await prisma.person.updateMany({ where, data: { breakfastRemaining: breakfast, lunchRemaining: lunch, dinnerRemaining: dinner } });
  res.json(result);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid person id' });
  }

  const confirmationPhrase = typeof req.body?.confirmationPhrase === 'string' ? req.body.confirmationPhrase : '';
  if (confirmationPhrase !== DELETE_CONFIRMATION_PHRASE) {
    return res.status(400).json({ error: `confirmationPhrase must match "${DELETE_CONFIRMATION_PHRASE}"` });
  }

  const person = await prisma.person.findUnique({ where: { id }, select: { id: true, personId: true, firstName: true, lastName: true } });
  if (!person) {
    return res.status(404).json({ error: 'Person not found' });
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const deletedTransactions = await tx.scanTransaction.deleteMany({ where: { personId: id } });
    await tx.person.delete({ where: { id } });
    return deletedTransactions.count;
  });

  return res.json({
    ok: true,
    deletedPerson: person,
    deletedTransactions: deleted
  });
});

export default router;

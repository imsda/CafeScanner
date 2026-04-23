import { Router } from 'express';
import { prisma } from '../db.js';
import { z } from 'zod';
import { nanoid } from 'nanoid';

const router = Router();
const DELETE_CONFIRMATION_PHRASE = 'DELETE USER';

const personSchema = z.object({
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
  const people = await prisma.person.findMany({ where: showInactive ? {} : { active: true }, orderBy: [{ lastName: 'asc' }] });

  const entitlementGroups = await prisma.mealEntitlement.groupBy({
    by: ['personId', 'redeemed'],
    _count: { _all: true }
  });

  const summaryByPersonId = new Map<string, { total: number; redeemed: number }>();
  for (const row of entitlementGroups) {
    const existing = summaryByPersonId.get(row.personId) ?? { total: 0, redeemed: 0 };
    existing.total += row._count._all;
    if (row.redeemed) existing.redeemed += row._count._all;
    summaryByPersonId.set(row.personId, existing);
  }

  const enriched = people.map((person) => {
    const summary = summaryByPersonId.get(person.personId) ?? { total: 0, redeemed: 0 };
    return {
      ...person,
      campMeetingEntitlements: summary.total,
      campMeetingRedeemed: summary.redeemed,
      campMeetingRemaining: Math.max(0, summary.total - summary.redeemed)
    };
  });

  res.json(enriched);
});

router.post('/', async (req, res) => {
  const payload = personSchema.parse(req.body);
  const person = await prisma.person.create({ data: { ...payload, codeValue: payload.codeValue || nanoid(10) } });
  res.json(person);
});

router.put('/:id', async (req, res) => {
  const payload = personSchema.partial().parse(req.body);
  const person = await prisma.person.update({ where: { id: Number(req.params.id) }, data: payload });
  res.json(person);
});

router.post('/adjust-balance/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { breakfastDelta = 0, lunchDelta = 0, dinnerDelta = 0 } = req.body;
  const person = await prisma.person.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.person.update({
    where: { id },
    data: {
      breakfastRemaining: Math.max(0, person.breakfastRemaining + breakfastDelta),
      lunchRemaining: Math.max(0, person.lunchRemaining + lunchDelta),
      dinnerRemaining: Math.max(0, person.dinnerRemaining + dinnerDelta)
    }
  });
  res.json(updated);
});

router.post('/reset-tallies/:id', async (req, res) => {
  const id = Number(req.params.id);
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
  const { breakfast, lunch, dinner, grade, group, campus } = req.body;
  const where: any = { active: true };
  if (grade) where.grade = grade;
  if (group) where.group = group;
  if (campus) where.campus = campus;
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

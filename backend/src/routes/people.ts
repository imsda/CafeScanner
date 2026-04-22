import { Router } from 'express';
import { prisma } from '../db.js';
import { z } from 'zod';
import { nanoid } from 'nanoid';

const router = Router();

const personSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  personId: z.string().min(1),
  codeValue: z.string().optional(),
  breakfastRemaining: z.number().int().nonnegative().default(0),
  lunchRemaining: z.number().int().nonnegative().default(0),
  dinnerRemaining: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
  grade: z.string().optional().nullable(),
  group: z.string().optional().nullable(),
  campus: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

router.get('/', async (req, res) => {
  const showInactive = req.query.showInactive === 'true';
  const people = await prisma.person.findMany({ where: showInactive ? {} : { active: true }, orderBy: [{ lastName: 'asc' }] });
  res.json(people);
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

router.post('/bulk-set', async (req, res) => {
  const { breakfast, lunch, dinner, grade, group, campus } = req.body;
  const where: any = { active: true };
  if (grade) where.grade = grade;
  if (group) where.group = group;
  if (campus) where.campus = campus;
  const result = await prisma.person.updateMany({ where, data: { breakfastRemaining: breakfast, lunchRemaining: lunch, dinnerRemaining: dinner } });
  res.json(result);
});

export default router;

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';

const router = Router();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const homeLeaveSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  startDate: z.string().regex(datePattern, 'Start date must use YYYY-MM-DD'),
  endDate: z.string().regex(datePattern, 'End date must use YYYY-MM-DD')
}).superRefine((value, context) => {
  const validDate = (input: string) => {
    const [year, month, day] = input.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  };
  if (!validDate(value.startDate)) context.addIssue({ code: 'custom', path: ['startDate'], message: 'Start date is invalid' });
  if (!validDate(value.endDate)) context.addIssue({ code: 'custom', path: ['endDate'], message: 'End date is invalid' });
  if (value.endDate < value.startDate) context.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
});

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/', async (_req, res) => {
  const homeLeaves = await prisma.homeLeave.findMany({ orderBy: [{ startDate: 'desc' }, { name: 'asc' }] });
  res.json(homeLeaves);
});

router.post('/', async (req, res) => {
  const parsed = homeLeaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid home leave' });
  const created = await prisma.homeLeave.create({ data: parsed.data });
  res.status(201).json(created);
});

router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid home leave id' });
  const parsed = homeLeaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid home leave' });
  const existing = await prisma.homeLeave.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Home leave not found' });
  res.json(await prisma.homeLeave.update({ where: { id }, data: parsed.data }));
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid home leave id' });
  const deleted = await prisma.homeLeave.deleteMany({ where: { id } });
  if (!deleted.count) return res.status(404).json({ error: 'Home leave not found' });
  res.json({ ok: true });
});

export default router;

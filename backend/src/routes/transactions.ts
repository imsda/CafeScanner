import { Router } from 'express';
import { prisma } from '../db.js';
import { Parser } from 'json2csv';

const router = Router();

router.get('/', async (req, res) => {
  const { from, to, mealType, result, station, personId } = req.query;
  const where: any = {};
  if (from || to) where.timestamp = {};
  if (from) where.timestamp.gte = new Date(String(from));
  if (to) where.timestamp.lte = new Date(String(to));
  if (mealType) where.mealType = mealType;
  if (result) where.result = result;
  if (station) where.stationName = String(station);
  if (personId) where.personId = Number(personId);

  const rows = await prisma.scanTransaction.findMany({ where, include: { person: true }, orderBy: { timestamp: 'desc' }, take: 1000 });
  res.json(rows);
});

router.get('/export.csv', async (req, res) => {
  const rows = await prisma.scanTransaction.findMany({ include: { person: true }, orderBy: { timestamp: 'desc' } });
  const parser = new Parser({ fields: ['timestamp', 'scannedValue', 'mealType', 'result', 'failureReason', 'stationName', 'entitlementId', 'entitlementPersonName', 'person.firstName', 'person.lastName', 'person.personId'] });
  const csv = parser.parse(rows as any[]);
  res.header('Content-Type', 'text/csv');
  res.attachment('transactions.csv');
  res.send(csv);
});

export default router;

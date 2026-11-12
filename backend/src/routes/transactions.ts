import { MealType, ScanResult } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncRouter } from '../utils/asyncRouter.js';
import { prisma } from '../db.js';
import { toCsv } from '../utils/csv.js';
import { parseQueryDate, resolveTimezone } from '../utils/timezone.js';

const router = asyncRouter();

const TRANSACTION_CSV_FIELDS = ['timestamp', 'scannedValue', 'mealType', 'result', 'failureReason', 'stationName', 'entitlementId', 'entitlementPersonName', 'person.firstName', 'person.lastName', 'person.personId', 'person.personType'];
// Exports are capped so a single request cannot load an unbounded history into memory.
export const EXPORT_ROW_LIMIT = 100_000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  mealType: z.nativeEnum(MealType).optional(),
  result: z.nativeEnum(ScanResult).optional(),
  station: z.string().optional(),
  personId: z.coerce.number().int().positive().optional(),
  // Free-text search: name, Person ID or scanned value.
  q: z.string().trim().max(100).optional()
});

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0)
});

// Every word must match at least one of: scanned value, person name, Person ID, ticket holder name.
function buildSearch(q: string | undefined): Prisma.ScanTransactionWhereInput {
  const words = (q ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return {};
  return {
    AND: words.map((word): Prisma.ScanTransactionWhereInput => ({
      OR: [
        { scannedValue: { contains: word } },
        { entitlementPersonName: { contains: word } },
        { person: { is: { OR: [{ firstName: { contains: word } }, { lastName: { contains: word } }, { personId: { contains: word } }] } } }
      ]
    }))
  };
}

async function buildWhere(query: unknown): Promise<Prisma.ScanTransactionWhereInput> {
  const filters = filterSchema.parse(query);
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { timezone: true } });
  const timezone = resolveTimezone(settings?.timezone);
  // Date-only values (YYYY-MM-DD) are whole days in the school timezone.
  const from = parseQueryDate(filters.from, timezone, 'start');
  const to = parseQueryDate(filters.to, timezone, 'end');
  return {
    ...(from || to ? { timestamp: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(filters.mealType ? { mealType: filters.mealType } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(filters.station ? { stationName: filters.station } : {}),
    ...(filters.personId ? { personId: filters.personId } : {}),
    ...buildSearch(filters.q)
  };
}

// Paged: ?limit= (default 200, max 1000) and ?offset=. The body is a plain array of rows;
// the total number of matching rows is returned in the X-Total-Count header.
router.get('/', async (req, res) => {
  const { limit, offset } = pageSchema.parse(req.query);
  const where = await buildWhere(req.query);
  const [total, rows] = await Promise.all([
    prisma.scanTransaction.count({ where }),
    prisma.scanTransaction.findMany({ where, include: { person: true }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], take: limit, skip: offset })
  ]);
  res.header('X-Total-Count', String(total));
  res.header('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(rows);
});

router.get('/export.csv', async (req, res) => {
  const rows = await prisma.scanTransaction.findMany({ where: await buildWhere(req.query), include: { person: true }, orderBy: { timestamp: 'desc' }, take: EXPORT_ROW_LIMIT });
  res.header('Content-Type', 'text/csv');
  res.attachment('transactions.csv');
  res.send(toCsv(rows, TRANSACTION_CSV_FIELDS));
});

export default router;

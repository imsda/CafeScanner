import { MealDay, MealType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma, withSqliteTimeoutRetry } from '../db.js';

const REQUIRED_HEADERS = ['ticket_id', 'reg_id', 'guest_name', 'meal_type', 'meal_day', 'meal_date', 'ticket_type', 'price', 'redeemed', 'redeemed_at', 'redeemed_by', 'notes'] as const;

type HeaderName = typeof REQUIRED_HEADERS[number];

type RawInputRow = Record<string, string>;

type NormalizedCampMeetingRow = {
  rowNumber: number;
  sourceTicketId: string;
  originalTicketId: string;
  personId: string;
  personName: string;
  mealType: MealType;
  mealDay: MealDay;
  mealDate: string;
  redeemed: boolean;
  notes: string | null;
};

export type CampMeetingImportSummary = {
  totalRows: number;
  validRows: number;
  duplicateTicketIdCount: number;
  skippedRows: number;
  skippedRowReasons: Array<{ row: number; reason: string }>;
  peopleCreated: number;
  peopleUpdated: number;
  entitlementsCreated: number;
  entitlementsUpdated: number;
  uniqueRegIdCount: number;
  errors: string[];
};

type CampMeetingImportSource = 'csv' | 'google_sheet';

type NormalizeOptions = {
  source: CampMeetingImportSource;
  sheetName?: string;
};

type ImportOptions = NormalizeOptions;

function normalizeHeaderName(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizePersonId(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeMealType(value: string): MealType | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'breakfast') return MealType.BREAKFAST;
  if (normalized === 'lunch') return MealType.LUNCH;
  if (normalized === 'dinner' || normalized === 'supper') return MealType.DINNER;
  return null;
}

function normalizeMealDay(value: string): MealDay | null {
  const normalized = String(value || '').trim().toLowerCase();
  const dayMap: Record<string, MealDay> = {
    sun: MealDay.SUN, sunday: MealDay.SUN,
    mon: MealDay.MON, monday: MealDay.MON,
    tue: MealDay.TUE, tues: MealDay.TUE, tuesday: MealDay.TUE,
    wed: MealDay.WED, wednesday: MealDay.WED,
    thu: MealDay.THU, thur: MealDay.THU, thurs: MealDay.THU, thursday: MealDay.THU,
    fri: MealDay.FRI, friday: MealDay.FRI,
    sat: MealDay.SAT, saturday: MealDay.SAT
  };
  return dayMap[normalized] ?? null;
}

function normalizeMealDate(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const mmddyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!mmddyy) return null;
  const [, m, d, yy] = mmddyy;
  const fullYear = 2000 + Number(yy);
  const month = Number(m);
  const day = Number(d);
  const dt = new Date(fullYear, month - 1, day);
  if (dt.getFullYear() !== fullYear || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseBool(value: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const normalized = fullName.trim().replace(/\s+/g, ' ');
  if (!normalized) return { firstName: 'Unknown', lastName: '' };
  const parts = normalized.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function mapRowsToCampMeetingInput(rows: string[][]): { inputRows: RawInputRow[]; errors: string[] } {
  if (!rows.length) return { inputRows: [], errors: ['no valid rows'] };
  const header = rows[0] || [];
  const indexByHeader = new Map<string, number>();
  header.forEach((cell, idx) => {
    const key = normalizeHeaderName(cell);
    if (key) indexByHeader.set(key, idx);
  });

  const missing = REQUIRED_HEADERS.filter((h) => !indexByHeader.has(h));
  if (missing.length) {
    return { inputRows: [], errors: [`Invalid header row. Missing required headers: ${missing.join(', ')}`] };
  }

  const inputRows: RawInputRow[] = rows.slice(1).map((row) => {
    const mapped: RawInputRow = {};
    for (const key of REQUIRED_HEADERS) {
      mapped[key] = String(row[indexByHeader.get(key) ?? -1] || '');
    }
    return mapped;
  });

  return { inputRows, errors: [] };
}

function buildSourceTicketId(rawTicketId: string, rowNumber: number, options: NormalizeOptions): string {
  if (options.source === 'google_sheet') {
    const safeSheetName = (options.sheetName || 'Sheet1').trim() || 'Sheet1';
    return `google:${safeSheetName}:row:${rowNumber}`;
  }
  return rawTicketId || `sheet-row-${rowNumber}`;
}

export function normalizeCampMeetingRows(inputRows: RawInputRow[], options: NormalizeOptions = { source: 'csv' }): { validRows: NormalizedCampMeetingRow[]; skipped: Array<{ row: number; reason: string }>; totalRows: number; uniqueRegIds: Set<string>; duplicateTicketIdCount: number } {
  const validRows: NormalizedCampMeetingRow[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const uniqueRegIds = new Set<string>();
  const seenTicketIds = new Set<string>();
  const duplicateTicketIds = new Set<string>();

  inputRows.forEach((raw, idx) => {
    const rowNumber = idx + 2;
    const personId = normalizePersonId(raw.reg_id);
    const personName = String(raw.guest_name || '').trim();
    const mealType = normalizeMealType(raw.meal_type);
    const mealDay = normalizeMealDay(raw.meal_day);
    const mealDate = normalizeMealDate(raw.meal_date);

    if (!personId) return skipped.push({ row: rowNumber, reason: 'missing reg_id' });
    if (!personName) return skipped.push({ row: rowNumber, reason: 'missing guest_name' });
    if (!mealType) return skipped.push({ row: rowNumber, reason: 'invalid meal_type' });
    if (!mealDay) return skipped.push({ row: rowNumber, reason: 'invalid meal_day' });
    if (mealDate === null) return skipped.push({ row: rowNumber, reason: 'invalid meal_date' });

    const originalTicketId = String(raw.ticket_id || '').trim();
    if (originalTicketId) {
      if (seenTicketIds.has(originalTicketId)) duplicateTicketIds.add(originalTicketId);
      else seenTicketIds.add(originalTicketId);
    }
    const sourceTicketId = buildSourceTicketId(originalTicketId, rowNumber, options);
    uniqueRegIds.add(personId);
    validRows.push({
      rowNumber,
      sourceTicketId,
      originalTicketId,
      personId,
      personName,
      mealType,
      mealDay,
      mealDate: mealDate ?? '',
      redeemed: parseBool(raw.redeemed),
      notes: String(raw.notes || '').trim() || null
    });
  });

  return { validRows, skipped, totalRows: inputRows.length, uniqueRegIds, duplicateTicketIdCount: duplicateTicketIds.size };
}

export async function importCampMeetingRows(inputRows: RawInputRow[], options: ImportOptions = { source: 'csv' }): Promise<CampMeetingImportSummary> {
  const { validRows, skipped, totalRows, uniqueRegIds, duplicateTicketIdCount } = normalizeCampMeetingRows(inputRows, options);
  const summary: CampMeetingImportSummary = {
    totalRows,
    validRows: validRows.length,
    duplicateTicketIdCount,
    skippedRows: skipped.length,
    skippedRowReasons: skipped,
    peopleCreated: 0,
    peopleUpdated: 0,
    entitlementsCreated: 0,
    entitlementsUpdated: 0,
    uniqueRegIdCount: uniqueRegIds.size,
    errors: skipped.map((s) => `Row ${s.row} skipped (${s.reason})`)
  };

  if (options.source === 'google_sheet' && duplicateTicketIdCount > 0) {
    console.log('[SHEET_IMPORT] Duplicate ticket_id detected; using row-based source keys.');
  }

  for (const row of validRows) {
    const existingPerson = await prisma.person.findUnique({ where: { personId: row.personId }, select: { id: true } });
    const nameParts = splitName(row.personName);
    if (existingPerson) {
      summary.peopleUpdated += 1;
      await withSqliteTimeoutRetry(`import.campMeeting.person.${row.rowNumber}`, () => prisma.person.update({
        where: { personId: row.personId },
        data: { firstName: nameParts.firstName, lastName: nameParts.lastName, active: true }
      }));
    } else {
      summary.peopleCreated += 1;
      await withSqliteTimeoutRetry(`import.campMeeting.person.${row.rowNumber}`, () => prisma.person.create({
        data: { personId: row.personId, codeValue: nanoid(10), firstName: nameParts.firstName, lastName: nameParts.lastName, active: true }
      }));
    }

    const existingEntitlement = await prisma.mealEntitlement.findUnique({ where: { sourceTicketId: row.sourceTicketId }, select: { id: true } });
    await withSqliteTimeoutRetry(`import.campMeeting.entitlement.${row.rowNumber}`, () => prisma.mealEntitlement.upsert({
      where: { sourceTicketId: row.sourceTicketId },
      update: {
        personId: row.personId,
        personName: row.personName,
        mealType: row.mealType,
        mealDay: row.mealDay,
        mealDate: row.mealDate,
        redeemed: row.redeemed,
        notes: row.notes || (row.originalTicketId ? `ticket_id=${row.originalTicketId}` : null),
        sourceSheetRow: row.rowNumber
      },
      create: {
        sourceTicketId: row.sourceTicketId,
        sourceSheetRow: row.rowNumber,
        personId: row.personId,
        personName: row.personName,
        mealType: row.mealType,
        mealDay: row.mealDay,
        mealDate: row.mealDate,
        redeemed: row.redeemed,
        notes: row.notes || (row.originalTicketId ? `ticket_id=${row.originalTicketId}` : null)
      }
    }));
    if (existingEntitlement) summary.entitlementsUpdated += 1;
    else summary.entitlementsCreated += 1;
  }

  return summary;
}

import type { MealDay } from '@prisma/client';

// Single fallback for an unset school timezone (matches the Setting.timezone schema default).
export const DEFAULT_TIMEZONE = 'Etc/UTC';

export function resolveTimezone(timezone: string | null | undefined): string {
  return timezone && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

/** YYYY-MM-DD for the calendar day `date` falls on in `timezone`. */
export function localDateKey(date: Date, timezone: string): string {
  const { year, month, day } = localParts(date, timezone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MEAL_DAYS: MealDay[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Day of the week `date` falls on in `timezone`. */
export function localMealDay(date: Date, timezone: string): MealDay {
  const { year, month, day } = localParts(date, timezone);
  return MEAL_DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

// Milliseconds the zone is ahead of UTC at `date`.
function zoneOffsetMs(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight at the start of `dateKey` (YYYY-MM-DD) in `timezone`. */
export function startOfLocalDay(dateKey: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  const firstOffset = zoneOffsetMs(new Date(guess), timezone);
  let instant = guess - firstOffset;
  // Re-check in case a DST transition falls between the guess and the real instant.
  const secondOffset = zoneOffsetMs(new Date(instant), timezone);
  if (secondOffset !== firstOffset) instant = guess - secondOffset;
  return new Date(instant);
}

/** The last millisecond of `dateKey` (YYYY-MM-DD) in `timezone`. */
export function endOfLocalDay(dateKey: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextKey = next.toISOString().slice(0, 10);
  return new Date(startOfLocalDay(nextKey, timezone).getTime() - 1);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a query-string date. A plain YYYY-MM-DD is a calendar day in the school
 * timezone (start or end of that day); anything else must be a full timestamp.
 * Returns null for missing values and throws for invalid ones.
 */
export function parseQueryDate(value: unknown, timezone: string, edge: 'start' | 'end'): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const dateOnly = text.match(DATE_ONLY);
  if (dateOnly) {
    const check = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
    if (check.toISOString().slice(0, 10) !== text) throw new InvalidDateError(text);
    return edge === 'start' ? startOfLocalDay(text, timezone) : endOfLocalDay(text, timezone);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new InvalidDateError(text);
  return parsed;
}

export class InvalidDateError extends Error {
  status = 400;
  constructor(value: string) {
    super(`Invalid date: ${value}`);
  }
}

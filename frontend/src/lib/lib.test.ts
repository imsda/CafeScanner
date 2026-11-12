import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatDateTime, formatPersonType, humanizeCode, modeLabel, normalizeTimeValue } from './format';
import { CUSTOM_ASSIGNABLE_PAGE_LABELS, homePathFor } from './pages';
import { matchesPersonTypeFilter, mealTotalsByPersonType, personTypeSortRank, sumMealTotals } from './personTypeTotals';

describe('format helpers', () => {
  it('labels person types, modes and codes for people rather than machines', () => {
    expect(formatPersonType('STUDENT')).toBe('Dorm Student');
    expect(formatPersonType('VILLAGE_STUDENT')).toBe('Village Student');
    expect(modeLabel('tally')).toBe('Tally Up');
    expect(humanizeCode('NO_ACTIVE_MEAL_PERIOD')).toBe('No active meal period');
  });

  it('normalises 12-hour times and leaves unparseable input alone', () => {
    expect(normalizeTimeValue('7:30 PM')).toBe('19:30');
    expect(normalizeTimeValue('12:05 am')).toBe('00:05');
    expect(normalizeTimeValue('08:15')).toBe('08:15');
    expect(normalizeTimeValue('soon')).toBe('soon');
  });

  it('formats timestamps in the school timezone, not the device timezone', () => {
    const chicago = formatDateTime('2030-01-16T03:00:00Z', 'America/Chicago');
    const utc = formatDateTime('2030-01-16T03:00:00Z', 'Etc/UTC');
    expect(chicago).toContain('15'); // still 15 January in Chicago
    expect(utc).toContain('16');
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('not a date')).toBe('not a date');
  });

  it('formats date-only values without shifting the day', () => {
    expect(formatDateOnly('2030-01-15')).toMatch(/15/);
    expect(formatDateOnly('not-a-date')).toBe('not-a-date');
  });
});

describe('page access helpers', () => {
  it('sends a user to their first permitted page', () => {
    expect(homePathFor(['REPORTS', 'SCAN'])).toBe('/scan');
    expect(homePathFor(['BADGES'])).toBe('/badges');
    expect(homePathFor([])).toBeNull();
  });

  it('never offers User Management to custom users', () => {
    expect(CUSTOM_ASSIGNABLE_PAGE_LABELS.some((entry) => entry.key === 'USER_MANAGEMENT')).toBe(false);
  });
});

describe('meal totals by person type', () => {
  const rows = [
    { personType: 'STUDENT', breakfasts: 1, lunches: 1, dinners: 0, total: 2 },
    { personType: 'VILLAGE_STUDENT', breakfasts: 0, lunches: 1, dinners: 0, total: 1 },
    { personType: 'STAFF', breakfasts: 0, lunches: 2, dinners: 1, total: 3 },
    { personType: 'GUEST', breakfasts: 0, lunches: 0, dinners: 4, total: 4 },
  ];

  it('filters by type, with "all students" covering dorm and village', () => {
    expect(rows.filter((row) => matchesPersonTypeFilter(row.personType, 'ALL_STUDENTS'))).toHaveLength(2);
    expect(rows.filter((row) => matchesPersonTypeFilter(row.personType, 'VILLAGE_STUDENT'))).toHaveLength(1);
    expect(rows.filter((row) => matchesPersonTypeFilter(row.personType, 'ALL'))).toHaveLength(4);
  });

  it('sums meals and builds the breakdown table with subtotal and total rows', () => {
    expect(sumMealTotals(rows)).toEqual({ people: 4, breakfasts: 1, lunches: 4, dinners: 5, total: 10 });
    const breakdown = Object.fromEntries(mealTotalsByPersonType(rows).map((row) => [row.filter, row.totals.total]));
    expect(breakdown).toEqual({ STUDENT: 2, VILLAGE_STUDENT: 1, ALL_STUDENTS: 3, STAFF: 3, GUEST: 4, ALL: 10 });
  });

  it('orders types dorm, village, staff, guest', () => {
    const order = ['GUEST', 'STAFF', 'VILLAGE_STUDENT', 'STUDENT'].sort((a, b) => personTypeSortRank(a) - personTypeSortRank(b));
    expect(order).toEqual(['STUDENT', 'VILLAGE_STUDENT', 'STAFF', 'GUEST']);
  });
});

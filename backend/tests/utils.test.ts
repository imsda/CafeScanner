import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, toCsv } from '../src/utils/csv.js';
import { endOfLocalDay, localDateKey, localMealDay, parseQueryDate, startOfLocalDay } from '../src/utils/timezone.js';
import { isHHmm, normalizeTimeValue } from '../src/utils/time.js';

test('CSV cells are quoted and spreadsheet formulas are neutralised', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  for (const value of ['+1', '-1', '@SUM(A1)']) assert.equal(csvCell(value), `'${value}`);
  assert.equal(csvCell(-5), '-5', 'numbers are not formula text');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(new Date('2030-01-02T03:04:05Z')), '2030-01-02T03:04:05.000Z');
  assert.equal(toCsv([{ a: 1, person: { name: 'X' } }, { a: 2 }], ['a', 'person.name']), 'a,person.name\r\n1,X\r\n2,');
});

test('local day boundaries follow the school timezone, including DST changes', () => {
  assert.equal(startOfLocalDay('2030-01-15', 'America/Chicago').toISOString(), '2030-01-15T06:00:00.000Z');
  assert.equal(endOfLocalDay('2030-01-15', 'America/Chicago').toISOString(), '2030-01-16T05:59:59.999Z');
  // 2030-03-10 is the US spring-forward day: a 23-hour day.
  assert.equal(startOfLocalDay('2030-03-10', 'America/Chicago').toISOString(), '2030-03-10T06:00:00.000Z');
  assert.equal(startOfLocalDay('2030-03-11', 'America/Chicago').toISOString(), '2030-03-11T05:00:00.000Z');
  assert.equal(startOfLocalDay('2030-01-15', 'Etc/UTC').toISOString(), '2030-01-15T00:00:00.000Z');
  assert.equal(localDateKey(new Date('2030-01-16T03:00:00Z'), 'America/Chicago'), '2030-01-15');
  assert.equal(localMealDay(new Date('2030-01-16T03:00:00Z'), 'America/Chicago'), 'TUE');
});

test('query dates: date-only values are whole school days; invalid values are 400s', () => {
  assert.equal(parseQueryDate(undefined, 'Etc/UTC', 'start'), null);
  assert.equal(parseQueryDate('2030-01-15', 'America/Chicago', 'end')?.toISOString(), '2030-01-16T05:59:59.999Z');
  assert.equal(parseQueryDate('2030-01-15T12:00:00Z', 'America/Chicago', 'start')?.toISOString(), '2030-01-15T12:00:00.000Z');
  for (const bad of ['garbage', '2030-02-30']) {
    assert.throws(() => parseQueryDate(bad, 'Etc/UTC', 'start'), (error: Error & { status?: number }) => error.status === 400);
  }
});

test('meal times normalise to 24-hour HH:mm', () => {
  assert.equal(normalizeTimeValue('7:30 pm'), '19:30');
  assert.equal(normalizeTimeValue('12:05 AM'), '00:05');
  assert.equal(normalizeTimeValue('08:15'), '08:15');
  assert.equal(normalizeTimeValue('13:00 PM'), '13:00 PM');
  assert.equal(isHHmm('24:00'), false);
  assert.equal(isHHmm('23:59'), true);
});

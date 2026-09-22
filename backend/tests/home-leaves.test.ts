import assert from 'node:assert/strict';
import test from 'node:test';
import { countUnexcusedCompleteDays } from '../src/services/homeLeaveService.js';

test('home leave dates are excluded inclusively from complete missed days', () => {
  const missedDays = countUnexcusedCompleteDays(
    new Date('2026-12-17T18:00:00-06:00'),
    new Date('2027-01-06T10:00:00-06:00'),
    'America/Chicago',
    [{ startDate: '2026-12-18', endDate: '2027-01-04' }]
  );
  assert.equal(missedDays, 1, 'only January 5 should be an unexcused complete day');
});

test('overlapping home leaves never subtract the same day twice', () => {
  const missedDays = countUnexcusedCompleteDays(
    new Date('2026-09-01T12:00:00-05:00'),
    new Date('2026-09-08T09:00:00-05:00'),
    'America/Chicago',
    [
      { startDate: '2026-09-02', endDate: '2026-09-05' },
      { startDate: '2026-09-04', endDate: '2026-09-06' }
    ]
  );
  assert.equal(missedDays, 1, 'September 7 should be the only unexcused complete day');
});

test('the academy timezone controls whether today is complete', () => {
  const missedDays = countUnexcusedCompleteDays(
    new Date('2026-09-20T17:00:00Z'),
    new Date('2026-09-22T03:00:00Z'),
    'America/Chicago',
    []
  );
  assert.equal(missedDays, 0, 'it is still September 21 in Chicago, so September 21 is not complete');
});

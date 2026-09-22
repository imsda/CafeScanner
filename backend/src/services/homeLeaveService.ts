export type HomeLeaveRange = { startDate: string; endDate: string };

const DAY_MS = 86_400_000;

function localDaySerial(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => Number(parts.find((part) => part.type === type)?.value || 0);
  return Math.floor(Date.UTC(value('year'), value('month') - 1, value('day')) / DAY_MS);
}

function dateOnlySerial(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function countUnexcusedCompleteDays(
  baseline: Date, now: Date, timezone: string, homeLeaves: HomeLeaveRange[]
): number {
  const firstCompleteDay = localDaySerial(baseline, timezone) + 1;
  const lastCompleteDay = localDaySerial(now, timezone) - 1;
  if (lastCompleteDay < firstCompleteDay) return 0;

  const leaveRanges = homeLeaves.map((leave) => ({
    start: dateOnlySerial(leave.startDate), end: dateOnlySerial(leave.endDate)
  }));
  let missedDays = 0;
  for (let day = firstCompleteDay; day <= lastCompleteDay; day += 1) {
    if (!leaveRanges.some((leave) => day >= leave.start && day <= leave.end)) missedDays += 1;
  }
  return missedDays;
}

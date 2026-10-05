import type { Setting, MealType } from '@prisma/client';
import { resolveTimezone } from './timezone.js';

function isWithinWindow(nowHHMM: string, start: string, end: string): boolean {
  return nowHHMM >= start && nowHHMM <= end;
}

function localTimeHHMM(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } /* h23: midnight is 00:xx, never 24:xx */).format(now);
}

export function detectMealType(now = new Date(), settings: Setting): MealType | null {
  const current = localTimeHHMM(now, resolveTimezone(settings.timezone));

  if (isWithinWindow(current, settings.breakfastStart, settings.breakfastEnd)) return 'BREAKFAST';
  if (isWithinWindow(current, settings.lunchStart, settings.lunchEnd)) return 'LUNCH';
  if (isWithinWindow(current, settings.dinnerStart, settings.dinnerEnd)) return 'DINNER';
  return null;
}

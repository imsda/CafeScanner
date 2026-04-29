import type { Setting, MealType } from '@prisma/client';

function isWithinWindow(nowHHMM: string, start: string, end: string): boolean {
  return nowHHMM >= start && nowHHMM <= end;
}

function localTimeHHMM(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

export function detectMealType(now = new Date(), settings: Setting): MealType | null {
  const current = localTimeHHMM(now, settings.timezone || 'America/Chicago');

  if (isWithinWindow(current, settings.breakfastStart, settings.breakfastEnd)) return 'BREAKFAST';
  if (isWithinWindow(current, settings.lunchStart, settings.lunchEnd)) return 'LUNCH';
  if (isWithinWindow(current, settings.dinnerStart, settings.dinnerEnd)) return 'DINNER';
  return null;
}

export function mealField(mealType: MealType): 'breakfastRemaining' | 'lunchRemaining' | 'dinnerRemaining' {
  if (mealType === 'BREAKFAST') return 'breakfastRemaining';
  if (mealType === 'LUNCH') return 'lunchRemaining';
  return 'dinnerRemaining';
}

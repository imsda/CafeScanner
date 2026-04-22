import type { Setting, MealType } from '@prisma/client';

function isWithinWindow(nowHHMM: string, start: string, end: string): boolean {
  return nowHHMM >= start && nowHHMM <= end;
}

export function detectMealType(now = new Date(), settings: Setting): MealType | null {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const current = `${hh}:${mm}`;

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

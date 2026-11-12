export type MealWindowSettings = {
  breakfastStart?: string | null; breakfastEnd?: string | null;
  lunchStart?: string | null; lunchEnd?: string | null;
  dinnerStart?: string | null; dinnerEnd?: string | null;
};

export function isWithinMealWindowPlus10Minutes(d: Date, tz: string, settings: MealWindowSettings): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = fmt.format(d).split(':').map(Number);
  // Some ICU versions format midnight as "24:xx" with hour12: false.
  const now = (h % 24) * 60 + m;
  const windows: Array<[string | null | undefined, string | null | undefined]> = [
    [settings.breakfastStart, settings.breakfastEnd],
    [settings.lunchStart, settings.lunchEnd],
    [settings.dinnerStart, settings.dinnerEnd]
  ];
  return windows.some(([s, e]) => {
    if (!s || !e) return false;
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
    return now >= sh * 60 + sm && now <= eh * 60 + em + 10;
  });
}

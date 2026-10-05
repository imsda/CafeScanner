export function isWithinMealWindowPlus10Minutes(d: Date, tz: string, settings: any): boolean {
  const fmt = new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false});
  const [h,m] = fmt.format(d).split(':').map(Number);
  const now = h*60+m;
  const windows: Array<[string, string]> = [[settings.breakfastStart,settings.breakfastEnd],[settings.lunchStart,settings.lunchEnd],[settings.dinnerStart,settings.dinnerEnd]];
  return windows.some(([s,e])=>{
    if (!s || !e) return false;
    const [sh,sm]=s.split(':').map(Number); const [eh,em]=e.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
    return now >= sh*60+sm && now <= eh*60+em+10;
  });
}
function getLocalTimeHHMM(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function calculateActiveWindow(d: Date, tz: string, settings: any): string | null {
  const [h,m] = getLocalTimeHHMM(d, tz).split(':').map(Number);
  const now = h * 60 + m;
  const windows: Array<{ key: string; start?: string; end?: string }> = [
    { key: 'breakfast', start: settings.breakfastStart, end: settings.breakfastEnd },
    { key: 'lunch', start: settings.lunchStart, end: settings.lunchEnd },
    { key: 'dinner', start: settings.dinnerStart, end: settings.dinnerEnd }
  ];
  for (const window of windows) {
    if (!window.start || !window.end) continue;
    const [sh,sm]=window.start.split(':').map(Number); const [eh,em]=window.end.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) continue;
    if (now >= sh*60+sm && now <= eh*60+em+10) return `${window.key} (${window.start}-${window.end}+10m)`;
  }
  return null;
}

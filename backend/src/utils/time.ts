// Accepts HH:mm or 12-hour "h:mm AM/PM" input and returns 24-hour HH:mm.
// Values that cannot be parsed are returned trimmed so callers can reject them.
export function normalizeTimeValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) return trimmed;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  if (Number.isNaN(hour12) || Number.isNaN(minute) || hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return trimmed;
  const hour24 = (hour12 % 12) + (suffix === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function isHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

import type { MealTrackingMode, PersonType } from "../api/types";

export function normalizeTimeValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) return trimmed;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  const hour24 = (hour12 % 12) + (suffix === "PM" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function renderStoredTimeValue(timeValue: string): string {
  return normalizeTimeValue(timeValue);
}

export function formatMealLabel(meal: string): string {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
}

// Ordered by the numeric User Type codes used in People and Google Sheets.
export const PERSON_TYPE_OPTIONS: Array<{ value: PersonType; code: number; label: string }> = [
  { value: "STUDENT", code: 1, label: "Dorm Student" },
  { value: "STAFF", code: 2, label: "Staff" },
  { value: "GUEST", code: 3, label: "Guest" },
  { value: "VILLAGE_STUDENT", code: 4, label: "Village Student" },
];

export function formatPersonType(personType: string): string {
  return PERSON_TYPE_OPTIONS.find((option) => option.value === personType)?.label ?? formatMealLabel(personType);
}

export function modeLabel(mode: MealTrackingMode): string {
  if (mode === "camp_meeting") return "Camp Meeting";
  if (mode === "countdown") return "Count Down";
  return "Tally Up";
}

/** "NO_ACTIVE_MEAL_PERIOD" → "No active meal period". */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Formats a timestamp for display. Pass the school timezone (from useSchoolMeta) so every
 * station shows the same local time regardless of the device's own clock settings.
 */
export function formatDateTime(value: string | Date | null | undefined, timezone?: string): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined);
  } catch {
    return date.toLocaleString();
  }
}

/** Formats a calendar date stored as YYYY-MM-DD without shifting it across time zones. */
export function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", weekday: "short" });
}

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

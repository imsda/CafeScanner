import type { Settings } from "../api/types";
import { normalizeTimeValue } from "./format";

export const TIMEZONE_OPTIONS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Etc/UTC",
] as const;

export function normalizeSettingsForTimeAndTimezone(source: Settings): Settings {
  return {
    ...source,
    timezone: TIMEZONE_OPTIONS.includes(source.timezone as (typeof TIMEZONE_OPTIONS)[number])
      ? source.timezone
      : "America/Chicago",
    breakfastStart: normalizeTimeValue(source.breakfastStart),
    breakfastEnd: normalizeTimeValue(source.breakfastEnd),
    lunchStart: normalizeTimeValue(source.lunchStart),
    lunchEnd: normalizeTimeValue(source.lunchEnd),
    dinnerStart: normalizeTimeValue(source.dinnerStart),
    dinnerEnd: normalizeTimeValue(source.dinnerEnd),
  };
}

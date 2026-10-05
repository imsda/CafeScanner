// Camp-meeting registration IDs are stored uppercased on import, so scans must
// normalise the same way or a lowercase/mixed-case scan never matches.
export function normalizeCampMeetingPersonId(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

// Countdown/tally person IDs are stored as imported (case preserved).
export function normalizePersonId(value: unknown): string {
  return String(value ?? '').trim();
}

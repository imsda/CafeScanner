export function formatDateInputValue(date: Date): string {
  const offsetDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60000,
  );
  return offsetDate.toISOString().slice(0, 10);
}

export function getRangeForPreset(
  preset: "today" | "week" | "month" | "year" | "last7",
): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (preset === "week") {
    const day = start.getDay();
    const offsetToMonday = (day + 6) % 7;
    start.setDate(start.getDate() - offsetToMonday);
  } else if (preset === "month") {
    start.setDate(1);
  } else if (preset === "year") {
    start.setMonth(0, 1);
  } else if (preset === "last7") {
    start.setDate(start.getDate() - 6);
  }

  return {
    from: formatDateInputValue(start),
    to: formatDateInputValue(end),
  };
}

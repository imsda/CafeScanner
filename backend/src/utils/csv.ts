// Minimal RFC 4180 CSV writer for exports.
//
// Cells are read by dotted path ("person.firstName"). Text that a spreadsheet would
// treat as a formula (starting with = + - @ tab or CR) is prefixed with an apostrophe,
// because names and IDs come from imports and must never execute in Excel/Sheets.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function readPath(row: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), row);
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'string') text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly unknown[], fields: readonly string[]): string {
  const lines = [fields.map(csvCell).join(',')];
  for (const row of rows) lines.push(fields.map((field) => csvCell(readPath(row, field))).join(','));
  return lines.join('\r\n');
}

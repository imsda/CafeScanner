import type { PersonType } from '@prisma/client';

export function parsePersonType(value: string): PersonType | undefined {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  const types: Record<string, PersonType> = { '1': 'STUDENT', STUDENT: 'STUDENT', '2': 'STAFF', STAFF: 'STAFF', '3': 'GUEST', GUEST: 'GUEST' };
  if (!types[normalized]) throw new Error('User Type must be 1/Student, 2/Staff, or 3/Guest.');
  return types[normalized];
}

// Canonicalize by header so old sheets and reordered columns remain usable.
export function peopleSheetRows(rows: string[][]): string[][] {
  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim().toLowerCase().replace(/[ _-]/g, ''));
  const required = ['id', 'name', 'breakfast', 'lunch', 'dinner', 'total'];
  const indices = required.map((key) => headers.indexOf(key));
  if (indices.some((index) => index < 0)) throw new Error('Sheet requires ID, Name, Breakfast, Lunch, Dinner, and Total columns.');
  const typeIndex = headers.findIndex((key) => key === 'usertype' || key === 'persontype');
  return rows.slice(1).map((row) => [...indices.map((index) => String(row[index] ?? '')), typeIndex < 0 ? '' : String(row[typeIndex] ?? '')]);
}

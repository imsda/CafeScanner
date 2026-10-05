import type { PersonType } from '@prisma/client';

const PERSON_TYPE_CODES: Record<string, PersonType> = {
  '1': 'STUDENT', STUDENT: 'STUDENT', DORM: 'STUDENT', DORMSTUDENT: 'STUDENT',
  '2': 'STAFF', STAFF: 'STAFF',
  '3': 'GUEST', GUEST: 'GUEST',
  '4': 'VILLAGE_STUDENT', VILLAGE: 'VILLAGE_STUDENT', VILLAGESTUDENT: 'VILLAGE_STUDENT'
};

export function parsePersonType(value: string): PersonType | undefined {
  // Case-insensitive; spaces, underscores and hyphens are ignored ("Village Student" = "village_student").
  const normalized = value.trim().toUpperCase().replace(/[\s_-]/g, '');
  if (!normalized) return undefined;
  const type = PERSON_TYPE_CODES[normalized];
  if (!type) throw new Error('User Type must be 1/Student (Dorm), 2/Staff, 3/Guest, or 4/Village Student.');
  return type;
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

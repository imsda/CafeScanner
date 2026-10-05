import type { PersonType } from "../api/types";

export type PersonTypeFilter = "ALL" | "ALL_STUDENTS" | PersonType;

export const PERSON_TYPE_FILTER_OPTIONS: Array<{ value: PersonTypeFilter; label: string }> = [
  { value: "ALL", label: "All types" },
  { value: "ALL_STUDENTS", label: "All students" },
  { value: "STUDENT", label: "Dorm students" },
  { value: "VILLAGE_STUDENT", label: "Village students" },
  { value: "STAFF", label: "Staff" },
  { value: "GUEST", label: "Guests" },
];

export function personTypeFilterLabel(filter: PersonTypeFilter): string {
  return PERSON_TYPE_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? filter;
}

export function matchesPersonTypeFilter(personType: string, filter: PersonTypeFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "ALL_STUDENTS") return personType === "STUDENT" || personType === "VILLAGE_STUDENT";
  return personType === filter;
}

type MealRow = { personType: string; breakfasts: number; lunches: number; dinners: number; total: number };
export type MealTotals = { people: number; breakfasts: number; lunches: number; dinners: number; total: number };

export function sumMealTotals(rows: readonly MealRow[]): MealTotals {
  return rows.reduce<MealTotals>(
    (acc, row) => ({
      people: acc.people + 1,
      breakfasts: acc.breakfasts + row.breakfasts,
      lunches: acc.lunches + row.lunches,
      dinners: acc.dinners + row.dinners,
      total: acc.total + row.total,
    }),
    { people: 0, breakfasts: 0, lunches: 0, dinners: 0, total: 0 },
  );
}

// Rows of the "Meals by Person Type" table, in display order. Subtotal/total rows are flagged for styling.
const BREAKDOWN_ROWS: Array<{ filter: PersonTypeFilter; label: string; summary?: boolean }> = [
  { filter: "STUDENT", label: "Dorm students" },
  { filter: "VILLAGE_STUDENT", label: "Village students" },
  { filter: "ALL_STUDENTS", label: "All students", summary: true },
  { filter: "STAFF", label: "Staff" },
  { filter: "GUEST", label: "Guests" },
  { filter: "ALL", label: "Total", summary: true },
];

export function mealTotalsByPersonType(rows: readonly MealRow[]) {
  return BREAKDOWN_ROWS.map((entry) => ({
    ...entry,
    totals: sumMealTotals(rows.filter((row) => matchesPersonTypeFilter(row.personType, entry.filter))),
  }));
}

// Sort order when sorting by type: students first (dorm, then village), then staff, then guests.
const PERSON_TYPE_SORT_ORDER: Record<string, number> = { STUDENT: 0, VILLAGE_STUDENT: 1, STAFF: 2, GUEST: 3 };

export function personTypeSortRank(personType: string): number {
  return PERSON_TYPE_SORT_ORDER[personType] ?? 99;
}

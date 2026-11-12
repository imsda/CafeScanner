import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';

export interface MealTotalsRow {
  personId: string;
  firstName: string;
  lastName: string;
  personType: string;
  breakfasts: number;
  lunches: number;
  dinners: number;
  total: number;
}

function addMealCount(mealType: MealType | null, row: MealTotalsRow, count: number): void {
  if (mealType === MealType.BREAKFAST) row.breakfasts += count;
  if (mealType === MealType.LUNCH) row.lunches += count;
  if (mealType === MealType.DINNER) row.dinners += count;
  // Every counted meal adds to the total, including MANUAL/NONE meal types.
  row.total += count;
}

export async function getMealTotalsByPerson(params: { from: Date; to: Date; mealTrackingMode: MealTrackingMode }): Promise<MealTotalsRow[]> {
  const { from, to, mealTrackingMode } = params;

  if (mealTrackingMode === MealTrackingMode.camp_meeting) {
    const entitlements = await prisma.mealEntitlement.findMany({
      where: {
        redeemed: true,
        redeemedAt: { gte: from, lte: to }
      },
      select: { personId: true, personName: true, mealType: true }
    });

    const people = await prisma.person.findMany({
      select: { personId: true, firstName: true, lastName: true, personType: true }
    });
    const personById = new Map(people.map((p) => [p.personId, p]));

    const rowsByPersonId = new Map<string, MealTotalsRow>();

    for (const entitlement of entitlements) {
      const person = personById.get(entitlement.personId);
      const fallbackName = (entitlement.personName || '').trim();
      const [firstNameFromCsv, ...rest] = fallbackName.split(' ');
      const lastNameFromCsv = rest.join(' ').trim();

      const existing = rowsByPersonId.get(entitlement.personId) ?? {
        personId: entitlement.personId,
        firstName: person?.firstName || firstNameFromCsv || 'Unknown',
        lastName: person?.lastName || lastNameFromCsv,
        personType: person?.personType || 'GUEST',
        breakfasts: 0,
        lunches: 0,
        dinners: 0,
        total: 0
      };

      addMealCount(entitlement.mealType, existing, 1);
      rowsByPersonId.set(entitlement.personId, existing);
    }

    return Array.from(rowsByPersonId.values()).sort((a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName));
  }

  // Aggregate in the database: one row per (person, meal type) instead of one per scan.
  const groups = await prisma.scanTransaction.groupBy({
    by: ['personId', 'mealType'],
    where: { timestamp: { gte: from, lte: to }, result: ScanResult.SUCCESS, personId: { not: null } },
    _count: { _all: true }
  });
  if (groups.length === 0) return [];

  const people = await prisma.person.findMany({
    select: { id: true, firstName: true, lastName: true, personId: true, personType: true }
  });
  const personById = new Map(people.map((person) => [person.id, person]));

  const perPersonMap = new Map<number, MealTotalsRow>();

  for (const group of groups) {
    const person = group.personId === null ? undefined : personById.get(group.personId);
    if (!person) continue;

    const existing = perPersonMap.get(person.id) ?? {
      personId: person.personId,
      firstName: person.firstName,
      lastName: person.lastName,
      personType: person.personType,
      breakfasts: 0,
      lunches: 0,
      dinners: 0,
      total: 0
    };

    addMealCount(group.mealType, existing, group._count._all);
    perPersonMap.set(person.id, existing);
  }

  return Array.from(perPersonMap.values()).sort(
    (a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.personId.localeCompare(b.personId)
  );
}

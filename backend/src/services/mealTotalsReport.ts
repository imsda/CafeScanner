import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';

export interface MealTotalsRow {
  personId: string;
  firstName: string;
  lastName: string;
  breakfasts: number;
  lunches: number;
  dinners: number;
  total: number;
}

function mapMealCount(mealType: MealType | null, row: MealTotalsRow): void {
  if (mealType === MealType.BREAKFAST) row.breakfasts += 1;
  if (mealType === MealType.LUNCH) row.lunches += 1;
  if (mealType === MealType.DINNER) row.dinners += 1;
}

export async function getMealTotalsByPerson(params: { from: Date; to: Date; mealTrackingMode: MealTrackingMode }): Promise<MealTotalsRow[]> {
  const { from, to, mealTrackingMode } = params;

  if (mealTrackingMode === MealTrackingMode.tally) {
    const people = await prisma.person.findMany({
      where: { active: true },
      select: {
        firstName: true,
        lastName: true,
        personId: true,
        breakfastCount: true,
        lunchCount: true,
        dinnerCount: true,
        totalMealsCount: true
      }
    });

    return people
      .map((person) => ({
        personId: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        breakfasts: person.breakfastCount,
        lunches: person.lunchCount,
        dinners: person.dinnerCount,
        total: person.totalMealsCount
      }))
      .filter((person) => person.total > 0)
      .sort((a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName));
  }

  if (mealTrackingMode === MealTrackingMode.camp_meeting) {
    const entitlements = await prisma.mealEntitlement.findMany({
      where: {
        redeemed: true,
        redeemedAt: { gte: from, lte: to }
      }
    });

    const people = await prisma.person.findMany({
      select: { personId: true, firstName: true, lastName: true }
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
        breakfasts: 0,
        lunches: 0,
        dinners: 0,
        total: 0
      };

      mapMealCount(entitlement.mealType, existing);
      existing.total += 1;
      rowsByPersonId.set(entitlement.personId, existing);
    }

    return Array.from(rowsByPersonId.values()).sort((a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName));
  }

  const transactions = await prisma.scanTransaction.findMany({
    where: { timestamp: { gte: from, lte: to }, result: ScanResult.SUCCESS },
    include: {
      person: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          personId: true
        }
      }
    }
  });

  const perPersonMap = new Map<number, MealTotalsRow>();

  for (const tx of transactions) {
    if (!tx.person) continue;

    const existing = perPersonMap.get(tx.person.id) ?? {
      personId: tx.person.personId,
      firstName: tx.person.firstName,
      lastName: tx.person.lastName,
      breakfasts: 0,
      lunches: 0,
      dinners: 0,
      total: 0
    };

    mapMealCount(tx.mealType, existing);
    existing.total += 1;
    perPersonMap.set(tx.person.id, existing);
  }

  return Array.from(perPersonMap.values()).sort((a, b) => b.total - a.total || a.lastName.localeCompare(b.lastName));
}

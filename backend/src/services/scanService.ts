import { MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { detectMealType } from '../utils/meal.js';

function normalizePersonId(value: string): string {
  return value.trim();
}

function localDateKey(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(date);
}

function deriveDisplayName(personName?: string | null): { firstName: string; lastName: string } {
  const normalized = (personName || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return { firstName: 'Camp Meeting Guest', lastName: '' };

  const parts = normalized.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

const tallyFieldByMeal: Record<MealType, 'breakfastCount' | 'lunchCount' | 'dinnerCount' | null> = {
  BREAKFAST: 'breakfastCount',
  LUNCH: 'lunchCount',
  DINNER: 'dinnerCount',
  MANUAL: null,
  NONE: null
};

export async function processScan(rawPersonId: string, options?: { manualMealOverride?: MealType; adminUserId?: number }) {
  const personIdValue = normalizePersonId(rawPersonId);
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error('Settings not found');

  const detectedMeal = options?.manualMealOverride && settings.allowManualMealOverride
    ? options.manualMealOverride
    : detectMealType(new Date(), settings);

  const latest = await prisma.scanTransaction.findFirst({
    where: { scannedValue: personIdValue },
    orderBy: { timestamp: 'desc' }
  });

  if (latest) {
    const elapsedSeconds = (Date.now() - latest.timestamp.getTime()) / 1000;
    if (elapsedSeconds < settings.scannerCooldownSeconds) {
      await prisma.scanTransaction.create({
        data: {
          scannedValue: personIdValue,
          mealType: detectedMeal ?? 'NONE',
          result: ScanResult.FAILURE,
          failureReason: 'COOLDOWN_ACTIVE',
          stationName: settings.stationName,
          adminUserId: options?.adminUserId
        }
      });
      return { ok: false, error: 'Please wait before scanning this ID again.', reason: 'COOLDOWN_ACTIVE' };
    }
  }

  if (!detectedMeal) {
    await prisma.scanTransaction.create({
      data: {
        scannedValue: personIdValue,
        mealType: 'NONE',
        result: ScanResult.FAILURE,
        failureReason: 'NO_ACTIVE_MEAL_PERIOD',
        stationName: settings.stationName,
        adminUserId: options?.adminUserId
      }
    });
    return { ok: false, error: 'No active meal period right now.', reason: 'NO_ACTIVE_MEAL_PERIOD' };
  }

  return prisma.$transaction(async (tx) => {
    const mode = settings.mealTrackingMode ?? MealTrackingMode.camp_meeting;

    if (mode === MealTrackingMode.camp_meeting) {
      const todayKey = localDateKey(new Date(), settings.timezone || 'Etc/UTC');

      const entitlement = await tx.mealEntitlement.findFirst({
        where: {
          personId: personIdValue,
          mealType: detectedMeal,
          mealDate: todayKey,
          redeemed: false
        },
        orderBy: { id: 'asc' }
      });

      if (!entitlement) {
        const person = await tx.person.findUnique({ where: { personId: personIdValue } });
        await tx.scanTransaction.create({
          data: {
            scannedValue: personIdValue,
            mealType: detectedMeal,
            result: ScanResult.FAILURE,
            failureReason: 'NO_MEAL_ENTITLEMENT',
            personId: person?.id,
            stationName: settings.stationName,
            adminUserId: options?.adminUserId
          }
        });

        return {
          ok: false,
          error: 'No unused meal entitlement remains for this ID for this meal and day.',
          reason: 'NO_MEAL_ENTITLEMENT',
          person,
          mealType: detectedMeal
        };
      }

      const linkedPerson = await tx.person.findUnique({ where: { personId: personIdValue } });

      await tx.mealEntitlement.update({
        where: { id: entitlement.id },
        data: {
          redeemed: true,
          redeemedAt: new Date()
        }
      });

      await tx.scanTransaction.create({
        data: {
          scannedValue: personIdValue,
          mealType: detectedMeal,
          result: ScanResult.SUCCESS,
          personId: linkedPerson?.id,
          entitlementId: entitlement.id,
          entitlementPersonName: entitlement.personName,
          stationName: settings.stationName,
          adminUserId: options?.adminUserId
        }
      });

      const displayName = deriveDisplayName(entitlement.personName);
      return {
        ok: true,
        person: {
          id: linkedPerson?.id,
          personId: personIdValue,
          firstName: displayName.firstName,
          lastName: displayName.lastName,
          breakfastRemaining: linkedPerson?.breakfastRemaining ?? 0,
          lunchRemaining: linkedPerson?.lunchRemaining ?? 0,
          dinnerRemaining: linkedPerson?.dinnerRemaining ?? 0,
          breakfastCount: linkedPerson?.breakfastCount ?? 0,
          lunchCount: linkedPerson?.lunchCount ?? 0,
          dinnerCount: linkedPerson?.dinnerCount ?? 0,
          totalMealsCount: linkedPerson?.totalMealsCount ?? 0,
          active: linkedPerson?.active ?? true
        },
        mealType: detectedMeal,
        mealTrackingMode: mode,
        redeemedEntitlement: {
          id: entitlement.id,
          personName: entitlement.personName,
          personId: entitlement.personId,
          mealDate: entitlement.mealDate
        }
      };
    }

    const person = await tx.person.findUnique({ where: { personId: personIdValue } });
    if (!person) {
      await tx.scanTransaction.create({ data: { scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE, failureReason: 'INVALID_PERSON_ID', stationName: settings.stationName, adminUserId: options?.adminUserId } });
      return { ok: false, error: 'Invalid person ID.', reason: 'INVALID_PERSON_ID' };
    }

    if (!person.active) {
      await tx.scanTransaction.create({ data: { scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE, failureReason: 'INACTIVE_PERSON', personId: person.id, stationName: settings.stationName, adminUserId: options?.adminUserId } });
      return { ok: false, error: 'Person is inactive.', reason: 'INACTIVE_PERSON', person };
    }

    const tallyField = tallyFieldByMeal[detectedMeal];
    const tallyData = tallyField
      ? {
          [tallyField]: { increment: 1 },
          totalMealsCount: { increment: 1 }
        }
      : { totalMealsCount: { increment: 1 } };

    const updated = await tx.person.update({
      where: { id: person.id },
      data: tallyData
    });

    await tx.scanTransaction.create({
      data: {
        scannedValue: personIdValue,
        mealType: detectedMeal,
        result: ScanResult.SUCCESS,
        personId: person.id,
        stationName: settings.stationName,
        adminUserId: options?.adminUserId
      }
    });

    return { ok: true, person: updated, mealType: detectedMeal, mealTrackingMode: mode };
  });
}

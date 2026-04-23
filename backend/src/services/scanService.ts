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
    const person = await tx.person.findUnique({ where: { personId: personIdValue } });
    if (!person) {
      await tx.scanTransaction.create({ data: { scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE, failureReason: 'INVALID_PERSON_ID', stationName: settings.stationName, adminUserId: options?.adminUserId } });
      return { ok: false, error: 'Invalid person ID.', reason: 'INVALID_PERSON_ID' };
    }

    if (!person.active) {
      await tx.scanTransaction.create({ data: { scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE, failureReason: 'INACTIVE_PERSON', personId: person.id, stationName: settings.stationName, adminUserId: options?.adminUserId } });
      return { ok: false, error: 'Person is inactive.', reason: 'INACTIVE_PERSON', person };
    }

    const mode = settings.mealTrackingMode ?? MealTrackingMode.camp_meeting;

    if (mode === MealTrackingMode.camp_meeting) {
      const todayKey = localDateKey(new Date(), settings.timezone || 'Etc/UTC');

      const entitlement = await tx.mealEntitlement.findFirst({
        where: {
          personId: person.personId,
          mealType: detectedMeal,
          mealDate: todayKey,
          redeemed: false
        },
        orderBy: { id: 'asc' }
      });

      if (!entitlement) {
        await tx.scanTransaction.create({
          data: {
            scannedValue: personIdValue,
            mealType: detectedMeal,
            result: ScanResult.FAILURE,
            failureReason: 'NO_MEAL_ENTITLEMENT',
            personId: person.id,
            stationName: settings.stationName,
            adminUserId: options?.adminUserId
          }
        });

        return { ok: false, error: 'No meal available for this person for this meal and day.', reason: 'NO_MEAL_ENTITLEMENT', person, mealType: detectedMeal };
      }

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
          personId: person.id,
          stationName: settings.stationName,
          adminUserId: options?.adminUserId
        }
      });

      return { ok: true, person, mealType: detectedMeal, mealTrackingMode: mode };
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

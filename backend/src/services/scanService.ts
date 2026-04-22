import { MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { detectMealType, mealField } from '../utils/meal.js';

function normalizePersonId(value: string): string {
  return value.trim();
}

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

    const field = mealField(detectedMeal);
    if (person[field] <= 0) {
      await tx.scanTransaction.create({ data: { scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE, failureReason: 'NO_MEALS_REMAINING', personId: person.id, stationName: settings.stationName, adminUserId: options?.adminUserId } });
      return { ok: false, error: `No ${detectedMeal.toLowerCase()} meals remaining.`, reason: 'NO_MEALS_REMAINING', person, mealType: detectedMeal };
    }

    const updated = await tx.person.update({
      where: { id: person.id },
      data: { [field]: { decrement: 1 } }
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

    return { ok: true, person: updated, mealType: detectedMeal };
  });
}

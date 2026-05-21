import { MealDay, MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { detectMealType } from '../utils/meal.js';

function normalizeCampMeetingPersonId(value: string): string {
  return value.trim();
}

function normalizePersonId(value: string): string {
  return value.trim();
}

function localMealDay(date: Date, timezone: string): MealDay {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  }).format(date).toUpperCase();

  const mealDayMap: Record<string, MealDay> = {
    SUN: MealDay.SUN,
    MON: MealDay.MON,
    TUE: MealDay.TUE,
    WED: MealDay.WED,
    THU: MealDay.THU,
    FRI: MealDay.FRI,
    SAT: MealDay.SAT
  };

  return mealDayMap[weekday] ?? MealDay.SUN;
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

const remainingFieldByMeal: Record<MealType, 'breakfastRemaining' | 'lunchRemaining' | 'dinnerRemaining' | null> = {
  BREAKFAST: 'breakfastRemaining',
  LUNCH: 'lunchRemaining',
  DINNER: 'dinnerRemaining',
  MANUAL: null,
  NONE: null
};

const noRemainingErrorByMeal: Record<MealType, string> = {
  BREAKFAST: 'No breakfasts remaining',
  LUNCH: 'No lunches remaining',
  DINNER: 'No dinners remaining',
  MANUAL: 'No meals remaining',
  NONE: 'No meals remaining'
};

async function redeemCampMeetingEntitlement(params: {
  tx: any;
  settings: { stationName: string; timezone: string | null; mealTrackingMode: MealTrackingMode | null };
  adminUserId?: number;
  personIdValue: string;
  detectedMeal: MealType;
  todayMealDay: MealDay;
  entitlementId: number;
}) {
  const { tx, settings, adminUserId, personIdValue, detectedMeal, todayMealDay, entitlementId } = params;

  const entitlement = await tx.mealEntitlement.findFirst({
    where: {
      id: entitlementId,
      personId: personIdValue,
      mealType: detectedMeal,
      mealDay: todayMealDay,
      redeemed: false
    }
  });

  if (!entitlement) {
    await tx.scanTransaction.create({
      data: {
        scannedValue: personIdValue,
        mealType: detectedMeal,
        result: ScanResult.FAILURE,
        failureReason: 'INVALID_ENTITLEMENT_SELECTION',
        stationName: settings.stationName,
        adminUserId
      }
    });

    return {
      ok: false,
      error: 'The selected person is no longer available for this meal.',
      reason: 'INVALID_ENTITLEMENT_SELECTION'
    };
  }

  const linkedPerson = await tx.person.findUnique({ where: { personId: personIdValue } });

  await tx.mealEntitlement.update({
    where: { id: entitlement.id },
    data: {
      redeemed: true,
      redeemedAt: new Date(),
      redeemedBy: entitlement.personName || null,
      sheetSyncedAt: null
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
      adminUserId
    }
  });

  const remainingAvailableTodayForMeal = await tx.mealEntitlement.count({
    where: {
      personId: personIdValue,
      mealType: detectedMeal,
      mealDay: todayMealDay,
      redeemed: false
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
    scannedValue: personIdValue,
    mealTrackingMode: settings.mealTrackingMode ?? MealTrackingMode.camp_meeting,
    remainingAvailableTodayForMeal,
    redeemedEntitlement: {
      id: entitlement.id,
      personName: entitlement.personName,
      personId: entitlement.personId,
      mealDate: entitlement.mealDate,
      mealDay: entitlement.mealDay
    }
  };
}

export async function processScan(rawPersonId: string, options?: { manualMealOverride?: MealType; adminUserId?: number; entitlementId?: number }) {
  const originalScannedValue = rawPersonId.trim();
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error('Settings not found');

  const mode = settings.mealTrackingMode ?? MealTrackingMode.camp_meeting;
  const personIdValue = mode === MealTrackingMode.camp_meeting
    ? normalizeCampMeetingPersonId(rawPersonId)
    : normalizePersonId(rawPersonId);

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
    if (mode === MealTrackingMode.camp_meeting) {
      const now = new Date();
      const timezone = settings.timezone || 'Etc/UTC';
      const todayMealDay = localMealDay(now, timezone);
      const matchingUnused = await tx.mealEntitlement.findMany({
        where: {
          personId: personIdValue,
          mealType: detectedMeal,
          mealDay: todayMealDay,
          redeemed: false
        },
        orderBy: [
          { personName: 'asc' },
          { id: 'asc' }
        ],
        select: {
          id: true,
          personName: true,
          personId: true,
          mealDate: true,
          mealDay: true
        }
      });

      if (matchingUnused.length === 0) {
        const person = await tx.person.findUnique({ where: { personId: personIdValue } });
        const [allForId, dayMealAnyState, dayAnyMeal, mealAnyDay] = await Promise.all([
          tx.mealEntitlement.count({ where: { personId: personIdValue } }),
          tx.mealEntitlement.count({ where: { personId: personIdValue, mealDay: todayMealDay, mealType: detectedMeal } }),
          tx.mealEntitlement.count({ where: { personId: personIdValue, mealDay: todayMealDay } }),
          tx.mealEntitlement.count({ where: { personId: personIdValue, mealType: detectedMeal } })
        ]);
        let helpfulError = 'No entitlements for this ID.';
        let reason = 'NO_ENTITLEMENTS_FOR_ID';
        if (allForId > 0 && dayMealAnyState > 0) {
          helpfulError = 'All matching entitlements are already redeemed.';
          reason = 'ALL_MATCHING_REDEEMED';
        } else if (allForId > 0 && dayAnyMeal > 0) {
          helpfulError = 'Entitlements exist, but for a different meal type.';
          reason = 'ENTITLEMENT_MEAL_MISMATCH';
        } else if (allForId > 0 && mealAnyDay > 0) {
          helpfulError = 'Entitlements exist, but for a different day.';
          reason = 'ENTITLEMENT_DAY_MISMATCH';
        }
        await tx.scanTransaction.create({
          data: {
            scannedValue: personIdValue,
            mealType: detectedMeal,
            result: ScanResult.FAILURE,
            failureReason: reason,
            personId: person?.id,
            stationName: settings.stationName,
            adminUserId: options?.adminUserId
          }
        });

        console.log(`[SCAN_MATCH] ticket_id=${personIdValue} selectedPerson= selectedEntitlementId= sourceRowKey= meal=${detectedMeal} mealDate= matchedPeopleCount=0 matchedEntitlementsCount=0 eligibleEntitlementsCount=0 result=${reason}`);
        return {
          ok: false,
          error: helpfulError,
          reason,
          person,
          mealType: detectedMeal
        };
      }

      if (options?.entitlementId !== undefined) {
        const selected = matchingUnused.find((m) => m.id === options.entitlementId) || null;
        console.log(`[SCAN_MATCH] ticket_id=${personIdValue} selectedPerson=${selected?.personName || ''} selectedEntitlementId=${options.entitlementId} sourceRowKey= meal=${detectedMeal} mealDate=${selected?.mealDate || ''} matchedPeopleCount=${new Set(matchingUnused.map((m) => m.personName || '')).size} matchedEntitlementsCount=${matchingUnused.length} eligibleEntitlementsCount=${matchingUnused.length} result=SELECTED`);
        return redeemCampMeetingEntitlement({
          tx,
          settings,
          adminUserId: options.adminUserId,
          personIdValue,
          detectedMeal,
          todayMealDay,
          entitlementId: options.entitlementId
        });
      }

      if (matchingUnused.length > 1) {
        console.log(`[SCAN_MATCH] ticket_id=${personIdValue} selectedPerson= selectedEntitlementId= sourceRowKey= meal=${detectedMeal} mealDate= matchedPeopleCount=${new Set(matchingUnused.map((m) => m.personName || '')).size} matchedEntitlementsCount=${matchingUnused.length} eligibleEntitlementsCount=${matchingUnused.length} result=MULTIPLE_MATCHES`);
        return {
          ok: false,
          pendingSelection: true,
          reason: 'MULTIPLE_ENTITLEMENTS_FOUND',
          scannedValue: personIdValue,
          originalScannedValue,
          mealType: detectedMeal,
          mealDay: todayMealDay,
          options: matchingUnused.map((option) => ({
            entitlementId: option.id,
            personName: option.personName || 'Camp Meeting Guest'
          }))
        };
      }

      console.log(`[SCAN_MATCH] ticket_id=${personIdValue} selectedPerson=${matchingUnused[0].personName || ''} selectedEntitlementId=${matchingUnused[0].id} sourceRowKey= meal=${detectedMeal} mealDate=${matchingUnused[0].mealDate || ''} matchedPeopleCount=1 matchedEntitlementsCount=${matchingUnused.length} eligibleEntitlementsCount=${matchingUnused.length} result=AUTO_SELECTED`);
      return redeemCampMeetingEntitlement({
        tx,
        settings,
        adminUserId: options?.adminUserId,
        personIdValue,
        detectedMeal,
        todayMealDay,
        entitlementId: matchingUnused[0].id
      });
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

    if (mode === MealTrackingMode.countdown) {
      const remainingField = remainingFieldByMeal[detectedMeal];
      if (!remainingField || person[remainingField] <= 0) {
        await tx.scanTransaction.create({
          data: {
            scannedValue: personIdValue,
            mealType: detectedMeal,
            result: ScanResult.FAILURE,
            failureReason: 'NO_MEAL_BALANCE',
            personId: person.id,
            stationName: settings.stationName,
            adminUserId: options?.adminUserId
          }
        });
        return {
          ok: false,
          error: noRemainingErrorByMeal[detectedMeal],
          reason: 'NO_MEAL_BALANCE',
          person
        };
      }

      const updated = await tx.person.update({
        where: { id: person.id },
        data: { [remainingField]: { decrement: 1 } }
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
    }

    const tallyField = tallyFieldByMeal[detectedMeal];
    const updated = await tx.person.update({
      where: { id: person.id },
      data: tallyField
        ? {
            [tallyField]: { increment: 1 },
            totalMealsCount: { increment: 1 }
          }
        : { totalMealsCount: { increment: 1 } }
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

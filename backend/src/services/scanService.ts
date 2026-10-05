import { MealDay, MealTrackingMode, MealType, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { detectMealType } from '../utils/meal.js';
import { countUnexcusedCompleteDays } from './homeLeaveService.js';
import { normalizeCampMeetingPersonId, normalizePersonId } from '../utils/personId.js';
import { isMealWarningEligible, isStudentType } from '../utils/personType.js';
import { localMealDay, resolveTimezone } from '../utils/timezone.js';


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

type CampMeetingEntitlementForScan = {
  id: number;
  personName: string | null;
  personId: string;
  mealDate: string;
  mealDay: MealDay;
  sourceTicketId: string | null;
  sourceSheetRow: number | null;
  redeemed: boolean;
};

function getSourceRowSortValue(entitlement: Pick<CampMeetingEntitlementForScan, 'sourceSheetRow'>): number {
  return entitlement.sourceSheetRow ?? Number.MAX_SAFE_INTEGER;
}

function compareCampMeetingEntitlements(a: CampMeetingEntitlementForScan, b: CampMeetingEntitlementForScan): number {
  const sourceRowDelta = getSourceRowSortValue(a) - getSourceRowSortValue(b);
  if (sourceRowDelta !== 0) return sourceRowDelta;

  if (a.sourceSheetRow == null && b.sourceSheetRow == null) {
    const nameDelta = (a.personName || '').localeCompare(b.personName || '', undefined, { sensitivity: 'base' });
    if (nameDelta !== 0) return nameDelta;
  }

  return a.id - b.id;
}

function sourceRowKey(entitlement: Pick<CampMeetingEntitlementForScan, 'sourceTicketId' | 'sourceSheetRow'>): string {
  return entitlement.sourceTicketId || (entitlement.sourceSheetRow ? `row:${entitlement.sourceSheetRow}` : '');
}

function logScanMatch(params: {
  ticketId: string;
  meal: MealType;
  mealDate?: string | null;
  matchedCount: number;
  eligibleCount: number;
  selectedPerson?: string | null;
  selectedEntitlementId?: number | null;
  selectedSourceRow?: string | number | null;
  remainingAvailableCount?: number;
  result?: string;
}) {
  console.log(
    `[SCAN_MATCH] ticket_id=${params.ticketId}`
    + ` meal=${params.meal}`
    + ` mealDate=${params.mealDate || ''}`
    + ` matchedCount=${params.matchedCount}`
    + ` eligibleCount=${params.eligibleCount}`
    + ` selectedPerson=${params.selectedPerson || ''}`
    + ` selectedEntitlementId=${params.selectedEntitlementId ?? ''}`
    + ` selectedSourceRow=${params.selectedSourceRow ?? ''}`
    + ` remainingAvailableCount=${params.remainingAvailableCount ?? 0}`
    + (params.result ? ` result=${params.result}` : '')
  );
}

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
    },
    select: {
      id: true,
      personName: true,
      personId: true,
      mealDate: true,
      mealDay: true,
      sourceTicketId: true,
      sourceSheetRow: true
    }
  });

  // Conditional update: only one scan can flip an entitlement to redeemed.
  const redeemed = entitlement
    ? await tx.mealEntitlement.updateMany({
      where: { id: entitlement.id, redeemed: false },
      data: {
        redeemed: true,
        redeemedAt: new Date(),
        redeemedBy: entitlement.personName || null,
        sheetSyncedAt: null
      }
    })
    : { count: 0 };

  if (!entitlement || redeemed.count !== 1) {
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

  const remainingAvailableCount = await tx.mealEntitlement.count({
    where: {
      personId: personIdValue,
      mealType: detectedMeal,
      mealDay: todayMealDay,
      redeemed: false
    }
  });

  const displayName = deriveDisplayName(entitlement.personName);
  const selectedSourceRow = sourceRowKey(entitlement);
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
    remainingAvailableTodayForMeal: remainingAvailableCount,
    remainingAvailableCount,
    selectedPerson: entitlement.personName || 'Camp Meeting Guest',
    selectedEntitlementId: entitlement.id,
    sourceRowKey: selectedSourceRow,
    sourceRow: entitlement.sourceSheetRow,
    redeemedEntitlement: {
      id: entitlement.id,
      personName: entitlement.personName,
      personId: entitlement.personId,
      mealDate: entitlement.mealDate,
      mealDay: entitlement.mealDay,
      sourceRowKey: selectedSourceRow,
      sourceSheetRow: entitlement.sourceSheetRow
    }
  };
}

type ProcessScanOptions = { manualMealOverride?: MealType; adminUserId?: number; entitlementId?: number };

// Scans of the same ID are processed one at a time so the cooldown check and the
// redemption/decrement cannot interleave (e.g. a double read from a USB scanner or
// two stations). The key is case-insensitive so it covers every mode's normalisation.
const scanQueues = new Map<string, Promise<unknown>>();

async function withScanLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = scanQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  scanQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (scanQueues.get(key) === tail) scanQueues.delete(key);
  }
}

export async function processScan(rawPersonId: string, options?: ProcessScanOptions) {
  return withScanLock(normalizeCampMeetingPersonId(rawPersonId), () => processScanUnlocked(rawPersonId, options));
}

async function processScanUnlocked(rawPersonId: string, options?: ProcessScanOptions) {
  const scanTime = new Date();
  const originalScannedValue = rawPersonId.trim();
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error('Settings not found');

  const scannerUser = options?.adminUserId === undefined ? null : await prisma.adminUser.findUnique({
    where: { id: options.adminUserId }, select: { scannerCooldownSeconds: true }
  });
  const cooldownSeconds = scannerUser?.scannerCooldownSeconds ?? settings.scannerCooldownSeconds;

  const mode = settings.mealTrackingMode ?? MealTrackingMode.camp_meeting;
  const personIdValue = mode === MealTrackingMode.camp_meeting
    ? normalizeCampMeetingPersonId(rawPersonId)
    : normalizePersonId(rawPersonId);

  const detectedMeal = options?.manualMealOverride && settings.allowManualMealOverride
    ? options.manualMealOverride
    : detectMealType(scanTime, settings);

  const latest = await prisma.scanTransaction.findFirst({
    where: { scannedValue: personIdValue },
    orderBy: { timestamp: 'desc' }
  });

  if (latest) {
    const elapsedSeconds = (Date.now() - latest.timestamp.getTime()) / 1000;
    if (elapsedSeconds < cooldownSeconds) {
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
      const timezone = resolveTimezone(settings.timezone);
      const todayMealDay = localMealDay(now, timezone);
      const matchingEntitlements: CampMeetingEntitlementForScan[] = (await tx.mealEntitlement.findMany({
        where: {
          personId: personIdValue,
          mealType: detectedMeal,
          mealDay: todayMealDay
        },
        select: {
          id: true,
          personName: true,
          personId: true,
          mealDate: true,
          mealDay: true,
          sourceTicketId: true,
          sourceSheetRow: true,
          redeemed: true
        }
      })).sort(compareCampMeetingEntitlements);
      const matchingUnused = matchingEntitlements.filter((entitlement) => !entitlement.redeemed);
      const matchedCount = matchingEntitlements.length;
      const eligibleCount = matchingUnused.length;

      if (eligibleCount === 0) {
        const person = await tx.person.findUnique({ where: { personId: personIdValue } });
        const [allForId, dayAnyMeal, mealAnyDay] = await Promise.all([
          tx.mealEntitlement.count({ where: { personId: personIdValue } }),
          tx.mealEntitlement.count({ where: { personId: personIdValue, mealDay: todayMealDay } }),
          tx.mealEntitlement.count({ where: { personId: personIdValue, mealType: detectedMeal } })
        ]);
        let helpfulError = 'No entitlements for this ID.';
        let reason = 'NO_ENTITLEMENTS_FOR_ID';
        if (matchedCount > 0) {
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

        logScanMatch({
          ticketId: personIdValue,
          meal: detectedMeal,
          mealDate: matchingEntitlements[0]?.mealDate,
          matchedCount,
          eligibleCount,
          remainingAvailableCount: 0,
          result: reason
        });
        return {
          ok: false,
          error: helpfulError,
          reason,
          person,
          mealType: detectedMeal,
          remainingAvailableCount: 0
        };
      }

      if (options?.entitlementId !== undefined) {
        const selected = matchingUnused.find((m) => m.id === options.entitlementId) || null;
        logScanMatch({
          ticketId: personIdValue,
          meal: detectedMeal,
          mealDate: selected?.mealDate,
          matchedCount,
          eligibleCount,
          selectedPerson: selected?.personName,
          selectedEntitlementId: options.entitlementId,
          selectedSourceRow: selected ? sourceRowKey(selected) : null,
          remainingAvailableCount: Math.max(eligibleCount - (selected ? 1 : 0), 0),
          result: 'SELECTED'
        });
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

      const autoSelectFirstAvailable = settings.campMeetingAutoSelectFirstAvailable ?? true;
      if (!autoSelectFirstAvailable && matchingUnused.length > 1) {
        logScanMatch({
          ticketId: personIdValue,
          meal: detectedMeal,
          matchedCount,
          eligibleCount,
          remainingAvailableCount: eligibleCount,
          result: 'MULTIPLE_MATCHES'
        });
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
            personName: option.personName || 'Camp Meeting Guest',
            sourceRowKey: sourceRowKey(option),
            sourceRow: option.sourceSheetRow
          }))
        };
      }

      const selected = matchingUnused[0];
      logScanMatch({
        ticketId: personIdValue,
        meal: detectedMeal,
        mealDate: selected.mealDate,
        matchedCount,
        eligibleCount,
        selectedPerson: selected.personName,
        selectedEntitlementId: selected.id,
        selectedSourceRow: sourceRowKey(selected),
        remainingAvailableCount: eligibleCount - 1,
        result: 'AUTO_SELECTED'
      });
      return redeemCampMeetingEntitlement({
        tx,
        settings,
        adminUserId: options?.adminUserId,
        personIdValue,
        detectedMeal,
        todayMealDay,
        entitlementId: selected.id
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
      // Conditional decrement so a balance can never go below zero.
      const decremented = remainingField && person[remainingField] > 0
        ? await tx.person.updateMany({
          where: { id: person.id, [remainingField]: { gt: 0 } },
          data: { [remainingField]: { decrement: 1 } }
        })
        : { count: 0 };
      if (!remainingField || decremented.count !== 1) {
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

      const updated = await tx.person.findUniqueOrThrow({ where: { id: person.id } });

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

    if (isStudentType(person.personType)) {
      // Keep the check and counter update in the same SQLite write transaction.
      const previousMeal = await tx.scanTransaction.findFirst({
        where: { personId: person.id, mealType: detectedMeal, result: ScanResult.SUCCESS },
        orderBy: { timestamp: 'desc' }
      });
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: resolveTimezone(settings.timezone), year: 'numeric', month: '2-digit', day: '2-digit'
      });
      if (previousMeal && localDate.format(previousMeal.timestamp) === localDate.format(scanTime)) {
        await tx.scanTransaction.create({ data: {
          scannedValue: personIdValue, mealType: detectedMeal, result: ScanResult.FAILURE,
          failureReason: 'STUDENT_MEAL_ALREADY_SCANNED', personId: person.id,
          stationName: settings.stationName, adminUserId: options?.adminUserId
        } });
        return { ok: false, error: 'Student has already scanned for this meal today.',
          reason: 'STUDENT_MEAL_ALREADY_SCANNED', person, mealType: detectedMeal };
      }
    }

    let mealWarningSince = person.mealWarningSince;
    if (isMealWarningEligible(person.personType, settings.villageStudentMealWarningsEnabled) && !mealWarningSince) {
      const lastMeal = await tx.scanTransaction.findFirst({
        where: { personId: person.id, result: ScanResult.SUCCESS },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true }
      });
      const baselineCandidates = [person.createdAt, person.mealWarningClearedAt, lastMeal?.timestamp].filter((value): value is Date => Boolean(value));
      const baseline = baselineCandidates.reduce((latest, value) => value > latest ? value : latest);
      const homeLeaves = await tx.homeLeave.findMany({ select: { startDate: true, endDate: true } });
      const missedDays = countUnexcusedCompleteDays(
        baseline, scanTime, resolveTimezone(settings.timezone), homeLeaves
      );
      if (missedDays >= settings.studentMealWarningDays) {
        mealWarningSince = scanTime;
      }
    }

    const tallyField = tallyFieldByMeal[detectedMeal];
    const updated = await tx.person.update({
      where: { id: person.id },
      data: {
        ...(tallyField ? {
            [tallyField]: { increment: 1 },
            totalMealsCount: { increment: 1 }
          }
        : { totalMealsCount: { increment: 1 } }),
        mealWarningSince
      }
    });

    await tx.scanTransaction.create({
      data: {
        timestamp: scanTime,
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

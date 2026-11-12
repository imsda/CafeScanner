import { MealTrackingMode, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { countUnexcusedCompleteDays } from './homeLeaveService.js';
import { mealWarningPersonTypes, STUDENT_PERSON_TYPES } from '../utils/personType.js';
import { resolveTimezone } from '../utils/timezone.js';

export async function getStudentsNotEating(now = new Date()) {
  const settings = await prisma.setting.findUniqueOrThrow({
    where: { id: 1 },
    select: { mealTrackingMode: true, studentMealWarningDays: true, timezone: true, villageStudentMealWarningsEnabled: true }
  });

  if (settings.mealTrackingMode !== MealTrackingMode.tally) {
    return { mealTrackingMode: settings.mealTrackingMode, warningDays: settings.studentMealWarningDays, villageStudentMealWarningsEnabled: settings.villageStudentMealWarningsEnabled, students: [] };
  }

  const students = await prisma.person.findMany({
    where: { active: true, personType: { in: mealWarningPersonTypes(settings.villageStudentMealWarningsEnabled) } },
    select: {
      id: true,
      personId: true,
      firstName: true,
      lastName: true,
      personType: true,
      createdAt: true,
      mealWarningSince: true,
      mealWarningClearedAt: true
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
  });
  // Bounded to the warning-eligible students; served by the (personId, mealType, result, timestamp) index.
  const latestMeals = students.length === 0 ? [] : await prisma.scanTransaction.groupBy({
    by: ['personId'],
    where: { personId: { in: students.map((student) => student.id) }, result: ScanResult.SUCCESS },
    _max: { timestamp: true }
  });
  const latestMealByPerson = new Map(latestMeals.map((row) => [row.personId, row._max.timestamp]));
  const homeLeaves = await prisma.homeLeave.findMany({ select: { startDate: true, endDate: true } });

  const warningStudents = students.flatMap((student) => {
    const candidates = [student.createdAt, student.mealWarningClearedAt, latestMealByPerson.get(student.id)]
      .filter((value): value is Date => Boolean(value));
    const baseline = candidates.reduce((latest, value) => value > latest ? value : latest);
    const calculatedMissedDays = countUnexcusedCompleteDays(
      baseline, now, resolveTimezone(settings.timezone), homeLeaves
    );
    const warningActive = Boolean(student.mealWarningSince) || calculatedMissedDays >= settings.studentMealWarningDays;
    if (!warningActive) return [];
    return [{
      id: student.id,
      personId: student.personId,
      firstName: student.firstName,
      lastName: student.lastName,
      personType: student.personType,
      missedDays: calculatedMissedDays,
      lastMealAt: latestMealByPerson.get(student.id)?.toISOString() ?? null,
      warningSince: student.mealWarningSince?.toISOString() ?? null
    }];
  });

  return { mealTrackingMode: settings.mealTrackingMode, warningDays: settings.studentMealWarningDays, villageStudentMealWarningsEnabled: settings.villageStudentMealWarningsEnabled, students: warningStudents };
}

// Every scan station polls the warning status once a minute. The answer is a single boolean,
// so it is cached briefly instead of recomputing the whole report for each station.
export const STUDENT_WARNING_CACHE_TTL_MS = 60_000;
let warningStatusCache: { hasWarnings: boolean; expiresAt: number } | null = null;
let warningStatusPending: Promise<boolean> | null = null;
let warningStatusGeneration = 0;

/** Cached "is any student warning active?" flag for the scan stations. The Reports page uses getStudentsNotEating() directly. */
export async function getStudentWarningStatus(): Promise<boolean> {
  if (warningStatusCache && warningStatusCache.expiresAt > Date.now()) return warningStatusCache.hasWarnings;
  if (warningStatusPending) return warningStatusPending;

  const generation = warningStatusGeneration;
  const pending: Promise<boolean> = getStudentsNotEating()
    .then((report) => {
      const hasWarnings = report.students.length > 0;
      // Do not store a result that was computed before an invalidation.
      if (generation === warningStatusGeneration) {
        warningStatusCache = { hasWarnings, expiresAt: Date.now() + STUDENT_WARNING_CACHE_TTL_MS };
      }
      return hasWarnings;
    })
    .finally(() => {
      if (warningStatusPending === pending) warningStatusPending = null;
    });
  warningStatusPending = pending;
  return pending;
}

/** Call whenever something changes which students have an active warning. */
export function invalidateStudentWarningCache(): void {
  warningStatusGeneration += 1;
  warningStatusCache = null;
  warningStatusPending = null;
}

export async function clearStudentMealWarning(personId: number) {
  const person = await prisma.person.update({
    where: { id: personId, personType: { in: STUDENT_PERSON_TYPES } },
    data: { mealWarningSince: null, mealWarningClearedAt: new Date() },
    select: { id: true, mealWarningSince: true, mealWarningClearedAt: true }
  });
  invalidateStudentWarningCache();
  return person;
}

import { MealTrackingMode, ScanResult } from '@prisma/client';
import { prisma } from '../db.js';
import { countUnexcusedCompleteDays } from './homeLeaveService.js';

export async function getStudentsNotEating(now = new Date()) {
  const settings = await prisma.setting.findUniqueOrThrow({
    where: { id: 1 },
    select: { mealTrackingMode: true, studentMealWarningDays: true, timezone: true }
  });

  if (settings.mealTrackingMode !== MealTrackingMode.tally) {
    return { mealTrackingMode: settings.mealTrackingMode, warningDays: settings.studentMealWarningDays, students: [] };
  }

  const students = await prisma.person.findMany({
    where: { active: true, personType: 'STUDENT' },
    select: {
      id: true,
      personId: true,
      firstName: true,
      lastName: true,
      createdAt: true,
      mealWarningSince: true,
      mealWarningClearedAt: true
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
  });
  const latestMeals = await prisma.scanTransaction.groupBy({
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
      baseline, now, settings.timezone || 'Etc/UTC', homeLeaves
    );
    const warningActive = Boolean(student.mealWarningSince) || calculatedMissedDays >= settings.studentMealWarningDays;
    if (!warningActive) return [];
    return [{
      id: student.id,
      personId: student.personId,
      firstName: student.firstName,
      lastName: student.lastName,
      missedDays: calculatedMissedDays,
      lastMealAt: latestMealByPerson.get(student.id)?.toISOString() ?? null,
      warningSince: student.mealWarningSince?.toISOString() ?? null
    }];
  });

  return { mealTrackingMode: settings.mealTrackingMode, warningDays: settings.studentMealWarningDays, students: warningStudents };
}

export async function clearStudentMealWarning(personId: number) {
  return prisma.person.update({
    where: { id: personId, personType: 'STUDENT' },
    data: { mealWarningSince: null, mealWarningClearedAt: new Date() },
    select: { id: true, mealWarningSince: true, mealWarningClearedAt: true }
  });
}

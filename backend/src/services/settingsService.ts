import { MealTrackingMode } from '@prisma/client';
import { prisma } from '../db.js';

let settingsInitPromise: Promise<void> | null = null;

function isKnownPrismaError(error: unknown, code: string): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

async function createSettingsIfMissing() {
  const existing = await prisma.setting.findUnique({ where: { id: 1 } });
  if (existing) return;

  console.log('[SETTINGS] No settings row found. Creating default Setting(id=1).');

  try {
    await prisma.setting.create({ data: { id: 1 } });
    console.log('[SETTINGS] Created default Setting(id=1).');
  } catch (error) {
    if (isKnownPrismaError(error, 'P2002')) {
      console.log('[SETTINGS] Default Setting(id=1) already created by another request.');
      return;
    }
    throw error;
  }
}

export async function ensureSettingsInitialized() {
  if (!settingsInitPromise) {
    settingsInitPromise = createSettingsIfMissing().catch((error) => {
      settingsInitPromise = null;
      throw error;
    });
  }

  await settingsInitPromise;
}

export async function getSettings() {
  await ensureSettingsInitialized();
  return prisma.setting.findUniqueOrThrow({ where: { id: 1 } });
}

export async function getMealTrackingMode() {
  await ensureSettingsInitialized();
  const settings = await prisma.setting.findUnique({
    where: { id: 1 },
    select: { mealTrackingMode: true }
  });

  return settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;
}

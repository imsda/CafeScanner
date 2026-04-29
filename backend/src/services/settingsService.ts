import { MealTrackingMode } from '@prisma/client';
import { prisma } from '../db.js';

let settingsInitPromise: Promise<void> | null = null;
const TIME_FIELDS = ['breakfastStart', 'breakfastEnd', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd'] as const;
const DEFAULT_TIMEZONE = 'America/Chicago';

function normalizeTimeValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) return trimmed;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  const hour24 = (hour12 % 12) + (suffix === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isKnownPrismaError(error: unknown, code: string): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

async function createSettingsIfMissing() {
  const existing = await prisma.setting.findUnique({ where: { id: 1 } });
  if (existing) return;

  console.log('[SETTINGS] No settings row found. Creating default Setting(id=1).');

  try {
    await prisma.setting.create({
      data: {
        id: 1,
        timezone: DEFAULT_TIMEZONE,
        breakfastStart: '05:00',
        breakfastEnd: '10:00',
        lunchStart: '11:00',
        lunchEnd: '14:00',
        dinnerStart: '15:00',
        dinnerEnd: '19:00'
      }
    });
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
  const settings = await prisma.setting.findUniqueOrThrow({
    where: { id: 1 },
    select: {
      id: true,
      schoolName: true,
      timezone: true,
      breakfastStart: true,
      breakfastEnd: true,
      lunchStart: true,
      lunchEnd: true,
      dinnerStart: true,
      dinnerEnd: true,
      scannerCooldownSeconds: true,
      scannerDiagnosticsEnabled: true,
      stationName: true,
      enableSounds: true,
      allowManualMealOverride: true,
      hideInactiveByDefault: true,
      mealTrackingMode: true,
      googleSheetsEnabled: true,
      googleSheetId: true,
      googleSheetTabName: true,
      googleSyncIntervalMinutes: true,
      updatedAt: true
    }
  });
  const patch: Partial<typeof settings> = {};
  if (!settings.timezone) patch.timezone = DEFAULT_TIMEZONE;
  for (const field of TIME_FIELDS) {
    const normalized = normalizeTimeValue(settings[field]);
    if (normalized !== settings[field]) patch[field] = normalized;
  }
  if (Object.keys(patch).length > 0) {
    return prisma.setting.update({ where: { id: 1 }, data: patch });
  }
  return settings;
}

export async function getMealTrackingMode() {
  await ensureSettingsInitialized();
  const settings = await prisma.setting.findUnique({
    where: { id: 1 },
    select: { mealTrackingMode: true }
  });

  return settings?.mealTrackingMode ?? MealTrackingMode.camp_meeting;
}

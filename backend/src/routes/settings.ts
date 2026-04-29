import { MealTrackingMode } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma, withSqliteTimeoutRetry } from '../db.js';
import { getSettings } from '../services/settingsService.js';
import { getGoogleSheetsSchedulerStatus, runGoogleSheetsSyncSchedulerCheckNow } from '../services/campMeetingSheetSyncService.js';

const router = Router();
const MODE_SWITCH_CONFIRMATION = 'SWITCH MODE';
const DEFAULT_TIMEZONE = 'America/Chicago';
const TIME_FIELDS = ['breakfastStart', 'breakfastEnd', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd'] as const;

function normalizeTimeValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) return trimmed;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  if (Number.isNaN(hour12) || Number.isNaN(minute) || hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return trimmed;
  const hour24 = (hour12 % 12) + (suffix === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const settingsSchema = z.object({
  schoolName: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  breakfastStart: z.string().min(1).optional(),
  breakfastEnd: z.string().min(1).optional(),
  lunchStart: z.string().min(1).optional(),
  lunchEnd: z.string().min(1).optional(),
  dinnerStart: z.string().min(1).optional(),
  dinnerEnd: z.string().min(1).optional(),
  scannerCooldownSeconds: z.number().min(0.5).max(10).optional(),
  scannerDiagnosticsEnabled: z.boolean().optional(),
  stationName: z.string().min(1).optional(),
  enableSounds: z.boolean().optional(),
  allowManualMealOverride: z.boolean().optional(),
  hideInactiveByDefault: z.boolean().optional(),
  googleSheetsEnabled: z.boolean().optional(),
  googleSheetId: z.string().optional(),
  googleSheetTabName: z.string().min(1).optional(),
  googleSyncIntervalMinutes: z.number().int().min(1).max(1440).optional()
});

const armFullWipeSchema = z.object({ confirmationPhrase: z.string() });

const switchModeSchema = z.object({
  mealTrackingMode: z.nativeEnum(MealTrackingMode),
  confirmationPhrase: z.string()
});

router.get('/', async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.get('/google-sheets/scheduler-status', async (_req, res) => {
  res.json(getGoogleSheetsSchedulerStatus());
});

router.post('/google-sheets/run-scheduled-check-now', async (req, res) => {
  if (req.session.role !== 'OWNER' && req.session.role !== 'ADMIN') return res.status(403).json({ error: 'OWNER or ADMIN required.' });
  const result = await runGoogleSheetsSyncSchedulerCheckNow();
  res.json({ ok: true, ...result });
});

router.put('/', async (req, res) => {
  const payload = settingsSchema.parse(req.body);
  if (typeof payload.googleSheetId === 'string') {
    payload.googleSheetId = payload.googleSheetId.trim();
  }
  if (typeof payload.timezone === 'string') {
    payload.timezone = payload.timezone.trim() || DEFAULT_TIMEZONE;
    if (!isValidTimezone(payload.timezone)) {
      return res.status(400).json({ error: `Invalid timezone: ${payload.timezone}` });
    }
  }
  for (const field of TIME_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string') {
      const normalizedValue = normalizeTimeValue(value);
      if (!isHHmm(normalizedValue)) {
        return res.status(400).json({ error: `${field} must be a valid HH:mm time.` });
      }
      payload[field] = normalizedValue;
    }
  }
  await getSettings();
  const updated = await withSqliteTimeoutRetry('settings.update', () => prisma.setting.update({ where: { id: 1 }, data: payload }));
  console.log('[SETTINGS] Updated settings payload keys:', Object.keys(payload));
  res.json(updated);
});


router.post('/full-wipe/arm', async (req, res) => {
  if (req.session.role !== 'OWNER') return res.status(403).json({ error: 'OWNER access required' });
  const payload = armFullWipeSchema.parse(req.body);
  if (payload.confirmationPhrase !== 'ARM FULL WIPE') return res.status(400).json({ error: 'Confirmation phrase must exactly match ARM FULL WIPE.' });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = await bcrypt.hash(token, 12);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await prisma.setting.update({ where: { id: 1 }, data: { fullWipeTokenHash: tokenHash, fullWipeTokenExpiresAt: expiresAt, fullWipeTokenUsedAt: null, fullWipeArmedByUserId: req.session.adminUserId ?? null } });
  return res.json({ ok: true, token, expiresAt });
});

router.put('/meal-tracking-mode', async (req, res) => {
  const payload = switchModeSchema.parse(req.body);

  if (payload.confirmationPhrase !== MODE_SWITCH_CONFIRMATION) {
    return res.status(400).json({ error: `Confirmation phrase must exactly match ${MODE_SWITCH_CONFIRMATION}.` });
  }

  const currentSettings = await getSettings();

  if (currentSettings.mealTrackingMode === payload.mealTrackingMode) {
    return res.json({
      ok: true,
      mealTrackingMode: currentSettings.mealTrackingMode,
      dataCleared: false,
      message: 'Meal tracking mode is already set to that value. No data was cleared.'
    });
  }

  const actedBy = req.session.adminUserId;

  const updatedSettings = await withSqliteTimeoutRetry('settings.switchMode', () => prisma.$transaction(async (tx) => {
    const settings = await tx.setting.update({
      where: { id: 1 },
      data: { mealTrackingMode: payload.mealTrackingMode }
    });

    await tx.scanTransaction.deleteMany({});
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});

    return settings;
  }));

  console.log(`[ADMIN_ACTION] switched mealTrackingMode to ${payload.mealTrackingMode} and cleared operational data by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  return res.json({
    ok: true,
    mealTrackingMode: updatedSettings.mealTrackingMode,
    dataCleared: true,
    message: 'Meal tracking mode switched. Meal tracking data was reset (people, transactions, import history, entitlements). User accounts and permissions were preserved.'
  });
});

export default router;

import { MealTrackingMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma, withSqliteTimeoutRetry } from '../db.js';
import { getSettings } from '../services/settingsService.js';

const router = Router();
const MODE_SWITCH_CONFIRMATION = 'SWITCH MODE';

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
  hideInactiveByDefault: z.boolean().optional()
});

const switchModeSchema = z.object({
  mealTrackingMode: z.nativeEnum(MealTrackingMode),
  confirmationPhrase: z.string()
});

router.get('/', async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.put('/', async (req, res) => {
  const payload = settingsSchema.parse(req.body);
  await getSettings();
  const updated = await withSqliteTimeoutRetry('settings.update', () => prisma.setting.update({ where: { id: 1 }, data: payload }));
  console.log('[SETTINGS] Updated settings payload keys:', Object.keys(payload));
  res.json(updated);
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
    message: 'Meal tracking mode switched. People, transactions, import history, and meal entitlements were cleared.'
  });
});

export default router;

import { MealTrackingMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';

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
  scannerCooldownSeconds: z.number().int().nonnegative().optional(),
  stationName: z.string().min(1).optional(),
  enableSounds: z.boolean().optional(),
  allowManualMealOverride: z.boolean().optional(),
  hideInactiveByDefault: z.boolean().optional()
});

const switchModeSchema = z.object({
  mealTrackingMode: z.nativeEnum(MealTrackingMode),
  confirmationPhrase: z.string()
});

async function ensureSettingsExists() {
  return prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {}
  });
}

router.get('/', async (_req, res) => {
  const settings = await ensureSettingsExists();
  res.json(settings);
});

router.put('/', async (req, res) => {
  const payload = settingsSchema.parse(req.body);
  const updated = await prisma.setting.update({ where: { id: 1 }, data: payload });
  res.json(updated);
});

router.put('/meal-tracking-mode', async (req, res) => {
  const payload = switchModeSchema.parse(req.body);

  if (payload.confirmationPhrase !== MODE_SWITCH_CONFIRMATION) {
    return res.status(400).json({ error: `Confirmation phrase must exactly match ${MODE_SWITCH_CONFIRMATION}.` });
  }

  const currentSettings = await ensureSettingsExists();

  if (currentSettings.mealTrackingMode === payload.mealTrackingMode) {
    return res.json({
      ok: true,
      mealTrackingMode: currentSettings.mealTrackingMode,
      dataCleared: false,
      message: 'Meal tracking mode is already set to that value. No data was cleared.'
    });
  }

  const actedBy = req.session.adminUserId;

  const updatedSettings = await prisma.$transaction(async (tx) => {
    const settings = await tx.setting.update({
      where: { id: 1 },
      data: { mealTrackingMode: payload.mealTrackingMode }
    });

    await tx.scanTransaction.deleteMany({});
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});

    return settings;
  });

  console.log(`[ADMIN_ACTION] switched mealTrackingMode to ${payload.mealTrackingMode} and cleared operational data by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  return res.json({
    ok: true,
    mealTrackingMode: updatedSettings.mealTrackingMode,
    dataCleared: true,
    message: 'Meal tracking mode switched. People, transactions, import history, and meal entitlements were cleared.'
  });
});

export default router;

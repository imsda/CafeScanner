import { MealTrackingMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';

const router = Router();

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
  hideInactiveByDefault: z.boolean().optional(),
  mealTrackingMode: z.nativeEnum(MealTrackingMode).optional()
});

router.get('/', async (_req, res) => {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  res.json(settings);
});

router.put('/', async (req, res) => {
  const payload = settingsSchema.parse(req.body);
  const updated = await prisma.setting.update({ where: { id: 1 }, data: payload });
  res.json(updated);
});

export default router;

import { MealType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { processScan } from '../services/scanService.js';

const router = Router();

const scanRequestSchema = z.object({
  personId: z.string().optional(),
  scannedValue: z.string().optional(),
  manualMealOverride: z.nativeEnum(MealType).optional()
}).refine((payload) => Boolean(payload.personId ?? payload.scannedValue), {
  message: 'personId is required',
  path: ['personId']
});

router.post('/', async (req, res) => {
  const payload = scanRequestSchema.parse(req.body);
  const personId = (payload.personId ?? payload.scannedValue ?? '').trim();
  const result = await processScan(personId, {
    manualMealOverride: payload.manualMealOverride,
    adminUserId: req.session.adminUserId
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

export default router;

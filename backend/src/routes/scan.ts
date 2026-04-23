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
  try {
    const payload = scanRequestSchema.parse(req.body);
    const personId = (payload.personId ?? payload.scannedValue ?? '').trim();
    const result = await processScan(personId, {
      manualMealOverride: payload.manualMealOverride,
      adminUserId: req.session.adminUserId
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: error.issues[0]?.message || 'Invalid scan payload.'
      });
    }

    const message = error instanceof Error && error.message
      ? error.message
      : 'Unable to process scan right now.';
    console.error('[SCAN] Failed to process scan request.', error);
    return res.status(500).json({ ok: false, error: message });
  }
});

export default router;

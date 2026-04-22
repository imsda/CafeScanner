import { MealType } from '@prisma/client';
import { Router } from 'express';
import { processScan } from '../services/scanService.js';

const router = Router();

router.post('/', async (req, res) => {
  const { scannedValue, manualMealOverride } = req.body;
  const result = await processScan(scannedValue, {
    manualMealOverride: manualMealOverride as MealType | undefined,
    adminUserId: req.session.adminUserId
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

export default router;

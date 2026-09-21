import { MealType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { processScan } from '../services/scanService.js';
import { getStudentsNotEating } from '../services/studentMealWarningService.js';

import { searchPeople } from '../services/searchPeople.js';

const router = Router();

// These routes inherit SCAN access, not administrative SETTINGS access.
router.get('/settings', async (req, res) => {
  try {
    const [settings, user] = await Promise.all([
      prisma.setting.findUniqueOrThrow({ where: { id: 1 } }),
      prisma.adminUser.findUniqueOrThrow({ where: { id: req.session.adminUserId! }, select: { scannerCooldownSeconds: true } })
    ]);
    return res.json({
      scannerCooldownSeconds: user.scannerCooldownSeconds ?? settings.scannerCooldownSeconds,
      personalScanDelay: user.scannerCooldownSeconds,
      defaultScanDelay: settings.scannerCooldownSeconds,
      mealTrackingMode: settings.mealTrackingMode,
      scannerDiagnosticsEnabled: settings.scannerDiagnosticsEnabled
    });
  } catch { return res.status(500).json({ error: 'Unable to load scanner preferences.' }); }
});

const preferenceSchema = z.object({ scannerCooldownSeconds: z.number().min(0.5).max(10).nullable() }).strict();
router.put('/settings', async (req, res) => {
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a delay from 0.5 to 10 seconds, or use the default.' });
  try {
    const user = await prisma.adminUser.update({
      where: { id: req.session.adminUserId! }, data: parsed.data,
      select: { scannerCooldownSeconds: true }
    });
    return res.json({ personalScanDelay: user.scannerCooldownSeconds });
  } catch { return res.status(500).json({ error: 'Unable to save scanner preferences.' }); }
});

router.get('/people', async (req, res) => {
  try {
    return res.json(await searchPeople(typeof req.query.q === 'string' ? req.query.q : ''));
  } catch (error) {
    console.error('[SCAN_SEARCH]', error);
    return res.status(500).json({ error: 'Unable to search people. Please try again.' });
  }
});

router.get('/warnings/status', async (_req, res) => {
  const report = await getStudentsNotEating();
  return res.json({ hasWarnings: report.students.length > 0 });
});

const scanRequestSchema = z.object({
  personId: z.string().optional(),
  scannedValue: z.string().optional(),
  manualMealOverride: z.nativeEnum(MealType).optional(),
  entitlementId: z.number().int().positive().optional()
}).refine((payload) => Boolean(payload.personId ?? payload.scannedValue), {
  message: 'personId is required',
  path: ['personId']
});

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  try {
    const payload = scanRequestSchema.parse(req.body);
    const personId = (payload.personId ?? payload.scannedValue ?? '').trim();
    const result = await processScan(personId, {
      manualMealOverride: payload.manualMealOverride,
      entitlementId: payload.entitlementId,
      adminUserId: req.session.adminUserId
    });
    if (!result.ok && !('pendingSelection' in result && result.pendingSelection)) return res.status(400).json(result);
    console.log(`[SCAN] processed in ${Date.now() - startedAt} ms`);
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
    console.log(`[SCAN] processed in ${Date.now() - startedAt} ms`);
    return res.status(500).json({ ok: false, error: message });
  }
});

export default router;

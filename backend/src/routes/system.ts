import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

router.post('/clear-database', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await prisma.$transaction(async (tx) => {
    await tx.scanTransaction.deleteMany({});
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});
  });

  console.log(`[ADMIN_ACTION] clear-database executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Database cleared. People, transactions, import history, and meal entitlements were deleted.' });
});

export default router;

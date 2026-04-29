import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

// Safeguard: reset operations in this module must never touch admin/auth tables
// (adminUser, userPageAccess) so user accounts, roles, password hashes, and page access survive data clears.
async function clearOperationalMealData() {
  await prisma.$transaction(async (tx) => {
    await tx.scanTransaction.deleteMany({});
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});
  });
}

router.post('/clear-database', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await clearOperationalMealData();

  console.log(`[ADMIN_ACTION] clear-database (legacy route) executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal tracking operational data cleared. Users, credentials, roles, account status, and page permissions were preserved.' });
});

router.post('/clear-meal-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await prisma.$transaction(async (tx) => {
    await tx.scanTransaction.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
  });

  console.log(`[ADMIN_ACTION] clear-meal-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal data cleared (transactions + meal entitlements). Users and permissions were preserved.' });
});

router.post('/clear-people-import-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await prisma.$transaction(async (tx) => {
    await tx.importHistory.deleteMany({});
    await tx.mealEntitlement.deleteMany({});
    await tx.person.deleteMany({});
    await tx.scanTransaction.deleteMany({});
  });

  console.log(`[ADMIN_ACTION] clear-people-import-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'People/import data cleared (people + imports + dependent meal data). Users and permissions were preserved.' });
});

router.post('/reset-meal-tracking-data', async (req, res) => {
  const actedBy = req.session.adminUserId;

  await clearOperationalMealData();

  console.log(`[ADMIN_ACTION] reset-meal-tracking-data executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);

  res.json({ ok: true, message: 'Meal tracking data reset. Users, credentials, roles, account status, and page permissions were preserved.' });
});

export default router;

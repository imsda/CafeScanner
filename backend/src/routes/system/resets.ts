import type { Router } from 'express';
import { prisma } from '../../db.js';
import { requireAdmin } from '../../middleware/auth.js';
import { acquireOperationLock, pauseScheduler, releaseOperationLock, resumeScheduler, waitForOperationsToFinish } from '../../services/operationLockService.js';

// Safeguard: reset operations in this module must never touch admin/auth tables
// (adminUser, userPageAccess) so user accounts, roles, password hashes, and page access survive data clears.
async function clearOperationalMealData(clearPeople: boolean) {
  const transactions = await prisma.scanTransaction.deleteMany({});
  const importRows = await prisma.importHistory.deleteMany({});
  const mealEntitlements = await prisma.mealEntitlement.deleteMany({});
  const people = clearPeople ? await prisma.person.deleteMany({}) : { count: 0 };

  return {
    transactions: transactions.count,
    importRows: importRows.count,
    mealEntitlements: mealEntitlements.count,
    people: people.count
  };
}

type ResetAction = 'clear-database' | 'clear-meal-data' | 'clear-people-import-data' | 'reset-meal-tracking-data';

const RESET_ACTIONS: Record<ResetAction, { clearPeople: boolean; message: string; failure: string }> = {
  'clear-database': {
    clearPeople: true,
    message: 'Meal tracking operational data cleared. Users, credentials, roles, account status, and page permissions were preserved.',
    failure: 'Failed to clear database data.'
  },
  'clear-meal-data': {
    clearPeople: false,
    message: 'Meal data cleared (transactions + meal entitlements). Users and permissions were preserved.',
    failure: 'Failed to clear meal data.'
  },
  'clear-people-import-data': {
    clearPeople: true,
    message: 'People/import data cleared (people + imports + dependent meal data). Users and permissions were preserved.',
    failure: 'Failed to clear people/import data.'
  },
  'reset-meal-tracking-data': {
    clearPeople: true,
    message: 'Meal tracking data reset. Users, credentials, roles, account status, and page permissions were preserved.',
    failure: 'Failed to reset meal tracking data.'
  }
};

async function clearMealDataOnly() {
  const transactions = await prisma.scanTransaction.deleteMany({});
  const mealEntitlements = await prisma.mealEntitlement.deleteMany({});
  return { transactions: transactions.count, mealEntitlements: mealEntitlements.count, people: 0, importRows: 0 };
}

export function registerResetRoutes(router: Router) {
  for (const [action, config] of Object.entries(RESET_ACTIONS) as [ResetAction, (typeof RESET_ACTIONS)[ResetAction]][]) {
    router.post(`/${action}`, requireAdmin, async (req, res) => {
      const actedBy = req.session.adminUserId;

      if (!acquireOperationLock('reset')) {
        return res.status(409).json({ ok: false, error: 'Reset already in progress.' });
      }

      try {
        pauseScheduler();
        console.log('[RESET] waiting for import to finish');
        await waitForOperationsToFinish(['import', 'writeback'], '[RESET] wait');
        const deleted = config.clearPeople ? await clearOperationalMealData(true) : await clearMealDataOnly();
        console.log(`[ADMIN_ACTION] ${action} executed by userId=${actedBy ?? 'unknown'} at ${new Date().toISOString()}`);
        return res.json({ ok: true, action, deleted, message: config.message });
      } catch (error) {
        console.error(`[SYSTEM] ${action} failed`, error);
        return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : config.failure });
      } finally {
        releaseOperationLock('reset');
        resumeScheduler();
      }
    });
  }
}

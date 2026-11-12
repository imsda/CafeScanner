import { asyncRouter } from '../utils/asyncRouter.js';
import { prisma } from '../db.js';
import { requirePageAccess } from '../middleware/auth.js';
import { getSettings } from '../services/settingsService.js';
import { getPersistedSheetSyncStatus } from '../services/campMeetingSheetSyncService.js';

// Read-only data several pages need, available without the SETTINGS or PEOPLE
// page permissions (which would otherwise make those pages fail for CUSTOM users).
const router = asyncRouter();

router.get('/', async (_req, res) => {
  const settings = await getSettings();
  // Compact sync health so any signed-in page (e.g. the Dashboard) can warn about a failing sync.
  const sync = settings.googleSheetsEnabled ? await getPersistedSheetSyncStatus() : null;
  res.json({
    schoolName: settings.schoolName,
    timezone: settings.timezone,
    mealTrackingMode: settings.mealTrackingMode,
    sheetSync: sync ? {
      enabled: true,
      lastSuccessAt: sync.lastSuccessAt?.toISOString() ?? null,
      lastError: sync.lastError,
      lastErrorAt: sync.lastErrorAt?.toISOString() ?? null
    } : null
  });
});

router.get('/badges', requirePageAccess('BADGES'), async (_req, res) => {
  const people = await prisma.person.findMany({
    select: { id: true, firstName: true, lastName: true, personId: true, codeValue: true, active: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
  });
  res.json(people);
});

export default router;

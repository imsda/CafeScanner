import { asyncRouter } from '../../utils/asyncRouter.js';
import { requireAdmin } from '../../middleware/auth.js';
import backupRouter from './backups.js';
import { registerResetRoutes } from './resets.js';
import { registerUpdateRoutes } from './updates.js';

const router = asyncRouter();

registerResetRoutes(router);

router.use('/backups', requireAdmin, backupRouter);

registerUpdateRoutes(router);

export default router;

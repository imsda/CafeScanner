import dotenv from 'dotenv';

dotenv.config();

const { createApp } = await import('./app.js');
const { configureSqlitePragmas } = await import('./db.js');
const { ensureSettingsInitialized } = await import('./services/settingsService.js');
const { startCampMeetingSheetSyncScheduler } = await import('./services/campMeetingSheetSyncService.js');

const port = Number(process.env.PORT || 4000);
const host = process.env.BACKEND_HOST || process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled promise rejection.', reason);
});

const app = createApp();

app.listen(port, host, () => {
  console.log(`Backend listening on http://${host}:${port}`);
  if (!isProduction) {
    console.log('Development frontend is available via Vite on port 5173.');
  } else {
    console.log('Production frontend is served by backend on port 4000.');
  }

  void (async () => {
    try {
      await configureSqlitePragmas();
      await ensureSettingsInitialized();
      startCampMeetingSheetSyncScheduler();
      console.log('[SETTINGS] Initialization check completed at startup.');
    } catch (error) {
      console.error('[STARTUP] Scheduler/settings initialization failed; backend will continue running.', error);
    }
  })();
});

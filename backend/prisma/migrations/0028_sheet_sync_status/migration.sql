-- Persisted Google Sheets sync health (shown on the Dashboard and Settings pages).
ALTER TABLE "Setting" ADD COLUMN "googleLastSyncSuccessAt" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "googleLastSyncError" TEXT;
ALTER TABLE "Setting" ADD COLUMN "googleLastSyncErrorAt" DATETIME;

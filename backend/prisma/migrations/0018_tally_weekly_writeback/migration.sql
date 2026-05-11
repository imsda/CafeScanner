ALTER TABLE "Setting" ADD COLUMN "tallyWriteBackMode" TEXT NOT NULL DEFAULT 'lifetime';
ALTER TABLE "Setting" ADD COLUMN "tallyWeeklySheetTabName" TEXT NOT NULL DEFAULT 'Weekly Tally';
ALTER TABLE "Setting" ADD COLUMN "tallyWeekStartsOn" TEXT NOT NULL DEFAULT 'MONDAY';

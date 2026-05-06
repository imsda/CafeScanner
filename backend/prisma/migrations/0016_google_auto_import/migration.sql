ALTER TABLE "Setting" ADD COLUMN "googleAutoImportEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Setting" ADD COLUMN "googleLastAutoImportAt" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "googleLastAutoImportSummary" TEXT;

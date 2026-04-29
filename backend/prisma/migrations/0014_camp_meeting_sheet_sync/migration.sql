ALTER TABLE "MealEntitlement" ADD COLUMN "sourceTicketId" TEXT;
ALTER TABLE "MealEntitlement" ADD COLUMN "sourceSheetRow" INTEGER;
ALTER TABLE "MealEntitlement" ADD COLUMN "redeemedBy" TEXT;
ALTER TABLE "MealEntitlement" ADD COLUMN "notes" TEXT;
ALTER TABLE "MealEntitlement" ADD COLUMN "sheetSyncedAt" DATETIME;
CREATE UNIQUE INDEX "MealEntitlement_sourceTicketId_key" ON "MealEntitlement"("sourceTicketId");

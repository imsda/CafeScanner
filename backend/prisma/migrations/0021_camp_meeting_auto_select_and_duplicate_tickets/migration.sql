ALTER TABLE "Setting" ADD COLUMN "campMeetingAutoSelectFirstAvailable" BOOLEAN NOT NULL DEFAULT true;

DROP INDEX IF EXISTS "MealEntitlement_sourceTicketId_key";
CREATE INDEX IF NOT EXISTS "MealEntitlement_sourceTicketId_idx" ON "MealEntitlement"("sourceTicketId");

ALTER TABLE "Person" ADD COLUMN "personType" TEXT NOT NULL DEFAULT 'GUEST';
CREATE INDEX "ScanTransaction_personId_mealType_result_timestamp_idx" ON "ScanTransaction"("personId", "mealType", "result", "timestamp");

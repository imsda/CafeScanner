ALTER TABLE "ScanTransaction" ADD COLUMN "entitlementId" INTEGER;
ALTER TABLE "ScanTransaction" ADD COLUMN "entitlementPersonName" TEXT;

CREATE INDEX "ScanTransaction_entitlementId_idx" ON "ScanTransaction"("entitlementId");

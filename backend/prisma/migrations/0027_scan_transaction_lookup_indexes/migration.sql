-- Cooldown check on every scan: latest transaction for a scanned value.
CREATE INDEX "ScanTransaction_scannedValue_timestamp_idx" ON "ScanTransaction"("scannedValue", "timestamp");

-- Dashboard, reports and transaction lists filter by time range.
CREATE INDEX "ScanTransaction_timestamp_idx" ON "ScanTransaction"("timestamp");

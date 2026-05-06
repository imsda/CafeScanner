-- Forward-only reconciliation migration for Google auto-import setting fields.
-- Keeps existing data and enforces sane defaults.
UPDATE "Setting"
SET "googleAutoImportEnabled" = true
WHERE "googleAutoImportEnabled" IS NULL;

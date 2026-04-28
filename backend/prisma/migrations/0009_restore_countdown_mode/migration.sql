-- Restore explicit countdown meal tracking mode support alongside camp_meeting and tally.
-- SQLite stores this as TEXT; this migration exists to record the schema evolution.

UPDATE "Setting"
SET "mealTrackingMode" = 'countdown'
WHERE "mealTrackingMode" NOT IN ('camp_meeting', 'countdown', 'tally');

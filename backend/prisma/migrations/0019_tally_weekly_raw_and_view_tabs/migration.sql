ALTER TABLE "Setting" ADD COLUMN "tallyWeeklyRawTabName" TEXT NOT NULL DEFAULT 'Weekly Tally Raw';
ALTER TABLE "Setting" ADD COLUMN "tallyWeeklyViewTabName" TEXT;
UPDATE "Setting"
SET "tallyWeeklyRawTabName" = CASE
  WHEN COALESCE(TRIM("tallyWeeklySheetTabName"), '') <> '' THEN "tallyWeeklySheetTabName"
  ELSE 'Weekly Tally Raw'
END;

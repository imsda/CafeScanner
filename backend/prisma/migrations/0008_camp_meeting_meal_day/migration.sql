-- Add mealDay for camp meeting redemption matching by day-of-week instead of exact date
ALTER TABLE "MealEntitlement" ADD COLUMN "mealDay" TEXT NOT NULL DEFAULT 'SUN';

-- Backfill mealDay from existing mealDate values where possible (YYYY-MM-DD)
UPDATE "MealEntitlement"
SET "mealDay" = CASE strftime('%w', "mealDate")
  WHEN '0' THEN 'SUN'
  WHEN '1' THEN 'MON'
  WHEN '2' THEN 'TUE'
  WHEN '3' THEN 'WED'
  WHEN '4' THEN 'THU'
  WHEN '5' THEN 'FRI'
  WHEN '6' THEN 'SAT'
  ELSE 'SUN'
END;

DROP INDEX IF EXISTS "MealEntitlement_personId_mealType_mealDate_redeemed_idx";
CREATE INDEX "MealEntitlement_personId_mealType_mealDay_redeemed_idx" ON "MealEntitlement"("personId", "mealType", "mealDay", "redeemed");
CREATE INDEX "MealEntitlement_mealDay_idx" ON "MealEntitlement"("mealDay");

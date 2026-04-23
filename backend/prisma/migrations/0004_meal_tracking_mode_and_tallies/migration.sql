-- Add tally counters to person records
ALTER TABLE "Person" ADD COLUMN "breakfastCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Person" ADD COLUMN "lunchCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Person" ADD COLUMN "dinnerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Person" ADD COLUMN "totalMealsCount" INTEGER NOT NULL DEFAULT 0;

-- Add system meal tracking mode (countdown | tally)
ALTER TABLE "Setting" ADD COLUMN "mealTrackingMode" TEXT NOT NULL DEFAULT 'countdown';

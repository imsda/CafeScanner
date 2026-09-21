ALTER TABLE "Person" ADD COLUMN "mealWarningSince" DATETIME;
ALTER TABLE "Person" ADD COLUMN "mealWarningClearedAt" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "studentMealWarningDays" INTEGER NOT NULL DEFAULT 1;

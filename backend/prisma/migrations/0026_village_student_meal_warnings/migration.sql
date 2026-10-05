-- Whether village students are included in missed-meal warnings (dorm students always are).
ALTER TABLE "Setting" ADD COLUMN "villageStudentMealWarningsEnabled" BOOLEAN NOT NULL DEFAULT true;

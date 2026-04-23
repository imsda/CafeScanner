-- Redefine meal tracking mode values and add camp meeting entitlements
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "schoolName" TEXT NOT NULL DEFAULT 'My School Cafeteria',
    "timezone" TEXT NOT NULL DEFAULT 'Etc/UTC',
    "breakfastStart" TEXT NOT NULL DEFAULT '05:00',
    "breakfastEnd" TEXT NOT NULL DEFAULT '10:00',
    "lunchStart" TEXT NOT NULL DEFAULT '11:00',
    "lunchEnd" TEXT NOT NULL DEFAULT '14:00',
    "dinnerStart" TEXT NOT NULL DEFAULT '17:00',
    "dinnerEnd" TEXT NOT NULL DEFAULT '19:00',
    "scannerCooldownSeconds" INTEGER NOT NULL DEFAULT 1,
    "stationName" TEXT NOT NULL DEFAULT 'Main Station',
    "enableSounds" BOOLEAN NOT NULL DEFAULT true,
    "allowManualMealOverride" BOOLEAN NOT NULL DEFAULT false,
    "hideInactiveByDefault" BOOLEAN NOT NULL DEFAULT true,
    "mealTrackingMode" TEXT NOT NULL DEFAULT 'camp_meeting',
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Setting" (
    "id", "schoolName", "timezone", "breakfastStart", "breakfastEnd", "lunchStart", "lunchEnd", "dinnerStart", "dinnerEnd", "scannerCooldownSeconds", "stationName", "enableSounds", "allowManualMealOverride", "hideInactiveByDefault", "mealTrackingMode", "updatedAt"
)
SELECT
    "id", "schoolName", "timezone", "breakfastStart", "breakfastEnd", "lunchStart", "lunchEnd", "dinnerStart", "dinnerEnd", "scannerCooldownSeconds", "stationName", "enableSounds", "allowManualMealOverride", "hideInactiveByDefault",
    CASE WHEN "mealTrackingMode" = 'countdown' THEN 'camp_meeting' ELSE "mealTrackingMode" END,
    "updatedAt"
FROM "Setting";

DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";

CREATE TABLE "MealEntitlement" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "personId" TEXT NOT NULL,
    "personName" TEXT,
    "mealType" TEXT NOT NULL,
    "mealDate" TEXT NOT NULL,
    "redeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "MealEntitlement_personId_mealType_mealDate_redeemed_idx" ON "MealEntitlement"("personId", "mealType", "mealDate", "redeemed");
CREATE INDEX "MealEntitlement_personId_idx" ON "MealEntitlement"("personId");
CREATE INDEX "MealEntitlement_mealDate_idx" ON "MealEntitlement"("mealDate");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;

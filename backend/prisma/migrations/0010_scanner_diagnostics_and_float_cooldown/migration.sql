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
    "scannerCooldownSeconds" REAL NOT NULL DEFAULT 1,
    "scannerDiagnosticsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stationName" TEXT NOT NULL DEFAULT 'Main Station',
    "enableSounds" BOOLEAN NOT NULL DEFAULT true,
    "allowManualMealOverride" BOOLEAN NOT NULL DEFAULT false,
    "hideInactiveByDefault" BOOLEAN NOT NULL DEFAULT true,
    "mealTrackingMode" TEXT NOT NULL DEFAULT 'camp_meeting',
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Setting" (
  "id",
  "schoolName",
  "timezone",
  "breakfastStart",
  "breakfastEnd",
  "lunchStart",
  "lunchEnd",
  "dinnerStart",
  "dinnerEnd",
  "scannerCooldownSeconds",
  "stationName",
  "enableSounds",
  "allowManualMealOverride",
  "hideInactiveByDefault",
  "mealTrackingMode",
  "updatedAt"
)
SELECT
  "id",
  "schoolName",
  "timezone",
  "breakfastStart",
  "breakfastEnd",
  "lunchStart",
  "lunchEnd",
  "dinnerStart",
  "dinnerEnd",
  "scannerCooldownSeconds",
  "stationName",
  "enableSounds",
  "allowManualMealOverride",
  "hideInactiveByDefault",
  "mealTrackingMode",
  "updatedAt"
FROM "Setting";

DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;

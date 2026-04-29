-- Redefine tables for SQLite enum and new columns
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AdminUser" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "ownerRecoveryCodeHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AdminUser" ("id","username","passwordHash","role","createdAt","updatedAt") SELECT "id","username","passwordHash","role","createdAt","updatedAt" FROM "AdminUser";
DROP TABLE "AdminUser";
ALTER TABLE "new_AdminUser" RENAME TO "AdminUser";
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

CREATE TABLE "new_Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
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
    "fullWipeTokenHash" TEXT,
    "fullWipeTokenExpiresAt" DATETIME,
    "fullWipeTokenUsedAt" DATETIME,
    "fullWipeArmedByUserId" INTEGER,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Setting" ("id","schoolName","timezone","breakfastStart","breakfastEnd","lunchStart","lunchEnd","dinnerStart","dinnerEnd","scannerCooldownSeconds","scannerDiagnosticsEnabled","stationName","enableSounds","allowManualMealOverride","hideInactiveByDefault","mealTrackingMode","updatedAt") SELECT "id","schoolName","timezone","breakfastStart","breakfastEnd","lunchStart","lunchEnd","dinnerStart","dinnerEnd","scannerCooldownSeconds","scannerDiagnosticsEnabled","stationName","enableSounds","allowManualMealOverride","hideInactiveByDefault","mealTrackingMode","updatedAt" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

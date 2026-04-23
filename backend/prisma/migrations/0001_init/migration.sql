-- CreateTable
CREATE TABLE "AdminUser" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

CREATE TABLE "Person" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "codeValue" TEXT NOT NULL,
  "breakfastRemaining" INTEGER NOT NULL DEFAULT 0,
  "lunchRemaining" INTEGER NOT NULL DEFAULT 0,
  "dinnerRemaining" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "grade" TEXT,
  "group" TEXT,
  "campus" TEXT,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Person_personId_key" ON "Person"("personId");
CREATE UNIQUE INDEX "Person_codeValue_key" ON "Person"("codeValue");

CREATE TABLE "Setting" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
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
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ScanTransaction" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scannedValue" TEXT NOT NULL,
  "mealType" TEXT NOT NULL DEFAULT 'NONE',
  "result" TEXT NOT NULL,
  "failureReason" TEXT,
  "stationName" TEXT,
  "personId" INTEGER,
  "adminUserId" INTEGER,
  CONSTRAINT "ScanTransaction_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ScanTransaction_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ImportHistory" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "filename" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "successRows" INTEGER NOT NULL,
  "failedRows" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "errorSummary" TEXT
);

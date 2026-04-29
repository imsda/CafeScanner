-- CreateTable
CREATE TABLE "UserPageAccess" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "adminUserId" INTEGER NOT NULL,
    "page" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserPageAccess_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPageAccess_adminUserId_page_key" ON "UserPageAccess"("adminUserId", "page");

-- CreateIndex
CREATE INDEX "UserPageAccess_adminUserId_idx" ON "UserPageAccess"("adminUserId");

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const adminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMeNow123!';
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.adminUser.upsert({
    where: { username: adminUsername },
    create: { username: adminUsername, passwordHash: adminPasswordHash, role: 'ADMIN' },
    update: {}
  });

  const scannerUsername = process.env.DEFAULT_SCANNER_USERNAME || 'scanner';
  const scannerPassword = process.env.DEFAULT_SCANNER_PASSWORD || 'ScanMeals123!';
  const scannerPasswordHash = await bcrypt.hash(scannerPassword, 10);

  await prisma.adminUser.upsert({
    where: { username: scannerUsername },
    create: { username: scannerUsername, passwordHash: scannerPasswordHash, role: 'SCANNER' },
    update: {}
  });

  await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {}
  });

  console.log(`Ensured default admin user exists: ${adminUsername}`);
  console.log(`Ensured default scanner user exists: ${scannerUsername}`);
}

main().finally(async () => prisma.$disconnect());

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const adminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMeNow123!';

  // Safe seeding: create a default admin only if no admin exists. Never overwrite existing users/passwords.
  const adminCount = await prisma.adminUser.count({ where: { role: 'ADMIN' } });
  if (adminCount === 0) {
    const adminPasswordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.adminUser.create({
      data: { username: adminUsername, passwordHash: adminPasswordHash, role: 'ADMIN' }
    });
    console.log(`Created default admin user: ${adminUsername}`);
  } else {
    console.log('Skipped default admin creation because at least one ADMIN already exists.');
  }

  const scannerUsername = process.env.DEFAULT_SCANNER_USERNAME || 'scanner';
  const scannerPassword = process.env.DEFAULT_SCANNER_PASSWORD || 'ScanMeals123!';
  const existingScanner = await prisma.adminUser.findUnique({ where: { username: scannerUsername } });
  if (!existingScanner) {
    const scannerPasswordHash = await bcrypt.hash(scannerPassword, 10);
    await prisma.adminUser.create({
      data: { username: scannerUsername, passwordHash: scannerPasswordHash, role: 'SCANNER' }
    });
    console.log(`Created default scanner user: ${scannerUsername}`);
  } else {
    console.log(`Skipped default scanner creation because username already exists: ${scannerUsername}`);
  }

  await prisma.setting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      scannerDiagnosticsEnabled: false,
      scannerCooldownSeconds: 1
    },
    update: {}
  });
}

main().finally(async () => prisma.$disconnect());

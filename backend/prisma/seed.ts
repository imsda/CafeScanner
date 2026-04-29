import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const adminCount = await prisma.adminUser.count({ where: { role: 'ADMIN' } });
  if (adminCount === 0) {
    console.log('No admin account exists. Run: npm run create-admin -w backend');
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

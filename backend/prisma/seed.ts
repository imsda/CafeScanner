import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const privilegedCount = await prisma.adminUser.count({ where: { role: { in: ['ADMIN', 'OWNER'] } } });
  if (privilegedCount === 0) {
    console.log('No ADMIN/OWNER account exists. Run: npm run create-admin -w backend');
    console.log('Then run: npm run promote-owner -w backend');
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

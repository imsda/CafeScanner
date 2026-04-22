import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const rawPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMeNow123!';
  const passwordHash = await bcrypt.hash(rawPassword, 10);

  await prisma.adminUser.upsert({
    where: { username },
    create: { username, passwordHash },
    update: { passwordHash }
  });

  await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {}
  });

  console.log(`Seeded admin user: ${username}`);
}

main().finally(async () => prisma.$disconnect());

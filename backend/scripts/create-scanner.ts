import { AppPage, PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { promptHidden, promptText } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  try {
    const username = await promptText('Username: ');
    const password = await promptHidden('Password: ');
    const confirmPassword = await promptHidden('Confirm Password: ');

    if (!username) throw new Error('Username is required');
    if (password.length < 4) throw new Error('Scanner / Kiosk User password must be at least 4 characters');
    if (password !== confirmPassword) throw new Error('Passwords do not match');

    const existingUser = await prisma.adminUser.findUnique({ where: { username } });
    if (existingUser) throw new Error('User already exists');

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.create({
      data: {
        username,
        passwordHash,
        role: UserRole.SCANNER,
        pageAccess: { create: [{ page: AppPage.SCAN }] },
      },
    });

    console.log('Scanner / Kiosk User created (Limited access account)');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to create scanner user');
  process.exit(1);
});

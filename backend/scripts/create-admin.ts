import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { promptHidden, promptText } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const force = process.argv.includes('--force');
  const existingAdmin = await prisma.adminUser.findFirst({ where: { role: UserRole.ADMIN } });

  if (existingAdmin && !force) {
    console.error('Admin already exists. Use --force to create another admin user.');
    process.exit(1);
  }

  try {
    const username = await promptText('Username: ');
    const password = await promptHidden('Password: ');
    const confirmPassword = await promptHidden('Confirm Password: ');

    if (!username) throw new Error('Username is required');
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    if (password !== confirmPassword) throw new Error('Passwords do not match');

    const duplicate = await prisma.adminUser.findUnique({ where: { username } });
    if (duplicate) throw new Error('User already exists');

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.create({
      data: { username, passwordHash, role: UserRole.ADMIN },
    });

    console.log('Admin user created successfully');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to create admin user');
  process.exit(1);
});

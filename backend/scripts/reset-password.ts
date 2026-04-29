import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { promptHidden, promptText } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  try {
    const username = await promptText('Username: ');
    const password = await promptHidden('New Password: ');
    const confirmPassword = await promptHidden('Confirm Password: ');
    const recoveryCode = await promptHidden('OWNER recovery code (required only for OWNER): ');
    const confirm = await promptText('Are you sure? (y/n): ');

    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    if (!username) throw new Error('Username is required');
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    if (password !== confirmPassword) throw new Error('Passwords do not match');

    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) throw new Error('User not found');

    if (user.role === 'OWNER') {
      if (!user.ownerRecoveryCodeHash) throw new Error('OWNER recovery code is not set. Use server owner recovery process.');
      const validRecovery = await bcrypt.compare(recoveryCode, user.ownerRecoveryCodeHash);
      if (!validRecovery) throw new Error('Invalid OWNER recovery code');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.update({ where: { username }, data: { passwordHash } });

    console.log('Password updated successfully');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to reset password');
  process.exit(1);
});

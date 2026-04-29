import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { createPrompt } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const prompt = createPrompt();

  try {
    const username = await prompt.ask('OWNER username: ');
    if (!username) {
      throw new Error('OWNER username is required');
    }

    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) {
      throw new Error('User not found');
    }
    if (user.role !== 'OWNER') {
      throw new Error('User is not an OWNER');
    }

    const recoveryCode = await prompt.askHidden('Recovery code: ');
    const confirmRecoveryCode = await prompt.askHidden('Confirm recovery code: ');

    if (recoveryCode.length < 16) {
      throw new Error('Recovery code must be at least 16 characters');
    }
    if (recoveryCode !== confirmRecoveryCode) {
      throw new Error('Recovery codes do not match');
    }

    const hash = await bcrypt.hash(recoveryCode, 12);
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { ownerRecoveryCodeHash: hash },
    });

    console.log('OWNER recovery code updated.');
  } finally {
    prompt.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed');
  process.exit(1);
});

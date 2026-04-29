import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { createPrompt } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function authorizeExistingOwner(prompt: ReturnType<typeof createPrompt>) {
  const existingOwnerUsername = await prompt.ask('Existing OWNER username: ');
  const existingOwnerPassword = await prompt.askHidden('Existing OWNER password: ');

  if (!existingOwnerUsername) {
    throw new Error('Existing OWNER username is required');
  }

  const existingOwner = await prisma.adminUser.findUnique({ where: { username: existingOwnerUsername } });
  if (!existingOwner) {
    throw new Error('Existing OWNER user not found');
  }
  if (existingOwner.role !== 'OWNER') {
    throw new Error('Authorization user must be an OWNER');
  }

  const validPassword = await bcrypt.compare(existingOwnerPassword, existingOwner.passwordHash);
  if (!validPassword) {
    throw new Error('Invalid existing OWNER password');
  }
}

async function main() {
  const prompt = createPrompt();

  try {
    const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } });

    if (ownerCount === 0) {
      const bootstrapConfirm = await prompt.ask('Type PROMOTE TO OWNER to continue: ');
      if (bootstrapConfirm !== 'PROMOTE TO OWNER') {
        throw new Error('Confirmation mismatch');
      }
    } else {
      await authorizeExistingOwner(prompt);
    }

    const usernameToPromote = await prompt.ask('Username to promote: ');
    if (!usernameToPromote) {
      throw new Error('Username to promote is required');
    }

    const confirm = await prompt.ask('Type PROMOTE TO OWNER to continue: ');
    if (confirm !== 'PROMOTE TO OWNER') {
      throw new Error('Confirmation mismatch');
    }

    const targetUser = await prisma.adminUser.findUnique({ where: { username: usernameToPromote } });
    if (!targetUser) {
      throw new Error('User to promote not found');
    }
    if (targetUser.role === 'OWNER') {
      throw new Error('User is already an OWNER');
    }

    await prisma.adminUser.update({
      where: { id: targetUser.id },
      data: { role: 'OWNER' },
    });

    console.log('User promoted to OWNER.');
  } finally {
    prompt.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed');
  process.exit(1);
});

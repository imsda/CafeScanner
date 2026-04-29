import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { confirmExact, promptHidden, promptText } from './lib/prompt';

dotenv.config();

const prisma = new PrismaClient();

async function authorizeExistingOwner() {
  const existingOwnerUsername = await promptText('Existing OWNER username: ');
  const existingOwnerPassword = await promptHidden('Existing OWNER password: ');

  if (!existingOwnerUsername) throw new Error('Existing OWNER username is required');

  const existingOwner = await prisma.adminUser.findUnique({ where: { username: existingOwnerUsername } });
  if (!existingOwner) throw new Error('Existing OWNER user not found');
  if (existingOwner.role !== 'OWNER') throw new Error('Authorization user must be an OWNER');

  const validPassword = await bcrypt.compare(existingOwnerPassword, existingOwner.passwordHash);
  if (!validPassword) throw new Error('Invalid existing OWNER password');
}

async function main() {
  try {
    const ownerCount = await prisma.adminUser.count({ where: { role: 'OWNER' } });

    if (ownerCount === 0) {
      await confirmExact('Type PROMOTE TO OWNER to continue: ', 'PROMOTE TO OWNER');
    } else {
      await authorizeExistingOwner();
    }

    const usernameToPromote = await promptText('Username to promote: ');
    if (!usernameToPromote) throw new Error('Username to promote is required');

    await confirmExact('Type PROMOTE TO OWNER to continue: ', 'PROMOTE TO OWNER');

    const targetUser = await prisma.adminUser.findUnique({ where: { username: usernameToPromote } });
    if (!targetUser) throw new Error('User to promote not found');
    if (targetUser.role === 'OWNER') throw new Error('User is already an OWNER');

    await prisma.adminUser.update({ where: { id: targetUser.id }, data: { role: 'OWNER' } });

    console.log('User promoted to OWNER.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed');
  process.exit(1);
});

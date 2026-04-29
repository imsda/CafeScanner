import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const prisma = new PrismaClient();

function createPrompt() {
  const mutableStdout = new (class {
    public muted = false;
    write(chunk: string | Uint8Array) {
      if (!this.muted) {
        process.stdout.write(chunk);
      }
    }
  })();

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout as unknown as NodeJS.WritableStream,
    terminal: true,
  });

  const ask = (query: string, hidden = false) =>
    new Promise<string>((resolve) => {
      mutableStdout.muted = false;
      rl.question(query, (answer) => {
        mutableStdout.muted = false;
        resolve(answer.trim());
      });
      if (hidden) {
        mutableStdout.muted = true;
      }
    });

  return { rl, ask };
}

async function main() {
  const { rl, ask } = createPrompt();
  try {
    const username = await ask('Username: ');
    const password = await ask('New Password: ', true);
    process.stdout.write('\n');
    const confirmPassword = await ask('Confirm Password: ', true);
    process.stdout.write('\n');
    const recoveryCode = await ask('OWNER recovery code (required only for OWNER): ', true);
    process.stdout.write('\n');
    const confirm = await ask('Are you sure? (y/n): ');

    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled');
      return;
    }

    if (!username) {
      throw new Error('Username is required');
    }
    if (password.length < 12) {
      throw new Error('Password must be at least 12 characters');
    }
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }

    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) {
      throw new Error('User not found');
    }

    if (user.role === 'OWNER') {
      if (!user.ownerRecoveryCodeHash) {
        throw new Error('OWNER recovery code is not set. Use server owner recovery process.');
      }
      const validRecovery = await bcrypt.compare(recoveryCode, user.ownerRecoveryCodeHash);
      if (!validRecovery) throw new Error('Invalid OWNER recovery code');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.update({
      where: { username },
      data: { passwordHash },
    });

    console.log('Password updated successfully');
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to reset password');
  process.exit(1);
});

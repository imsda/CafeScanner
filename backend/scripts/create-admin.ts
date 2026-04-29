import { PrismaClient, UserRole } from '@prisma/client';
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
  const force = process.argv.includes('--force');
  const existingAdmin = await prisma.adminUser.findFirst({ where: { role: UserRole.ADMIN } });

  if (existingAdmin && !force) {
    console.error('Admin already exists. Use --force to create another admin user.');
    process.exit(1);
  }

  const { rl, ask } = createPrompt();
  try {
    const username = await ask('Username: ');
    const password = await ask('Password: ', true);
    process.stdout.write('\n');
    const confirmPassword = await ask('Confirm Password: ', true);
    process.stdout.write('\n');

    if (!username) {
      throw new Error('Username is required');
    }
    if (password.length < 12) {
      throw new Error('Password must be at least 12 characters');
    }
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }

    const duplicate = await prisma.adminUser.findUnique({ where: { username } });
    if (duplicate) {
      throw new Error('User already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.create({
      data: {
        username,
        passwordHash,
        role: UserRole.ADMIN,
      },
    });

    console.log('Admin user created successfully');
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to create admin user');
  process.exit(1);
});

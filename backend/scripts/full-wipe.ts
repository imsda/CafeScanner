import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { confirmExact } from './lib/prompt';

dotenv.config();
const prisma = new PrismaClient();

const tokenArgIdx = process.argv.indexOf('--token');
const token = tokenArgIdx >= 0 ? process.argv[tokenArgIdx + 1] : undefined;
if (!token) {
  console.error('Missing required --token argument');
  process.exit(1);
}

(async () => {
  try {
    const setting = await prisma.setting.findUnique({ where: { id: 1 } });
    if (!setting?.fullWipeTokenHash) throw new Error('No armed full wipe token found');
    if (setting.fullWipeTokenUsedAt) throw new Error('Token already used');
    if (!setting.fullWipeTokenExpiresAt || setting.fullWipeTokenExpiresAt.getTime() < Date.now()) throw new Error('Token expired');

    const ok = await bcrypt.compare(token, setting.fullWipeTokenHash);
    if (!ok) throw new Error('Invalid token');

    await confirmExact('Type DELETE EVERYTHING to continue: ', 'DELETE EVERYTHING');

    await prisma.setting.update({ where: { id: 1 }, data: { fullWipeTokenUsedAt: new Date() } });
    await prisma.$disconnect();

    const dbUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db';
    const dbPath = path.resolve(process.cwd(), dbUrl.replace('file:', ''));
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const fp = dbPath + suffix;
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    console.log('Full wipe complete. Run ./scripts/setup.sh, then npm run create-admin -w backend, then npm run promote-owner -w backend.');
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'Failed full wipe');
    process.exit(1);
  } finally {
    try {
      await prisma.$disconnect();
    } catch {}
  }
})();

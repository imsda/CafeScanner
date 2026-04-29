import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import readline from 'readline';
dotenv.config(); const prisma = new PrismaClient(); const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q:string)=>new Promise<string>(r=>rl.question(q,a=>r(a.trim())));
(async()=>{ try { const username=await ask('OWNER username to promote: '); const confirm=await ask('Type PROMOTE TO OWNER to continue: '); if (confirm!=='PROMOTE TO OWNER') throw new Error('Confirmation mismatch'); const user=await prisma.adminUser.findUnique({where:{username}}); if(!user) throw new Error('User not found'); await prisma.adminUser.update({where:{id:user.id},data:{role:'OWNER'}}); console.log('User promoted to OWNER.'); } finally { rl.close(); await prisma.$disconnect(); } })().catch(e=>{console.error(e instanceof Error?e.message:'Failed');process.exit(1)});

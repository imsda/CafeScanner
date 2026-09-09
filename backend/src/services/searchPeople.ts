import { prisma } from '../db.js';

export async function searchPeople(query: string) {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const settings = await prisma.setting.findUnique({ where: { id: 1 }, select: { mealTrackingMode: true } });
  if (settings?.mealTrackingMode === 'camp_meeting') {
    const rows = await prisma.mealEntitlement.groupBy({
      by: ['personId', 'personName'],
      where: { OR: [{ personId: { contains: q } }, { AND: q.split(/\s+/).map((word) => ({ personName: { contains: word } })) }] },
      orderBy: [{ personName: 'asc' }, { personId: 'asc' }], take: 20
    });
    return rows.map((row) => ({ personId: row.personId, name: row.personName || row.personId }));
  }
  const people = await prisma.person.findMany({
    where: { active: true, OR: [
      { personId: { contains: q } },
      { AND: q.split(/\s+/).map((word) => ({ OR: [{ firstName: { contains: word } }, { lastName: { contains: word } }] })) }
    ] },
    select: { personId: true, firstName: true, lastName: true, personType: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { personId: 'asc' }], take: 20
  });
  return people.map((person) => ({ personId: person.personId, name: `${person.firstName} ${person.lastName}`.trim(), personType: person.personType }));
}

import type { PersonType } from '@prisma/client';

// Dorm (STUDENT) and village students follow the same student rules:
// one scan per meal per day and missed-meal warnings.
export const STUDENT_PERSON_TYPES: PersonType[] = ['STUDENT', 'VILLAGE_STUDENT'];

export function isStudentType(personType: PersonType | string | null | undefined): boolean {
  return personType === 'STUDENT' || personType === 'VILLAGE_STUDENT';
}

export const PERSON_TYPE_VALUES = ['STUDENT', 'STAFF', 'GUEST', 'VILLAGE_STUDENT'] as const;

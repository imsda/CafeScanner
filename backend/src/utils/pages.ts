import { AppPage, UserRole } from '@prisma/client';

export const ALL_PAGES: AppPage[] = [
  AppPage.DASHBOARD, AppPage.SCAN, AppPage.PEOPLE, AppPage.IMPORT, AppPage.BADGES,
  AppPage.TRANSACTIONS, AppPage.REPORTS, AppPage.HOME_LEAVES, AppPage.SETTINGS, AppPage.USER_MANAGEMENT
];

// User management is admin-only (the /api/users routes require ADMIN/OWNER), so it
// cannot be granted to CUSTOM users.
export const CUSTOM_ASSIGNABLE_PAGES: AppPage[] = ALL_PAGES.filter((page) => page !== AppPage.USER_MANAGEMENT);

const SCANNER_PAGES: AppPage[] = [AppPage.SCAN];

export function allowedPagesFor(role: UserRole, customPages: AppPage[]): AppPage[] {
  if (role === 'OWNER' || role === 'ADMIN') return [...ALL_PAGES];
  if (role === 'SCANNER') return [...SCANNER_PAGES];
  const assignable = new Set(CUSTOM_ASSIGNABLE_PAGES);
  return customPages.filter((page) => assignable.has(page));
}

export function normalizeCustomPages(input: unknown): AppPage[] {
  if (!Array.isArray(input)) return [];
  const assignable = new Set<string>(CUSTOM_ASSIGNABLE_PAGES);
  return [...new Set(input.filter((page): page is AppPage => typeof page === 'string' && assignable.has(page)))];
}

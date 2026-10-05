import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { allowedPagesFor } from '../utils/pages.js';

export function isAdminRole(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUserId || !req.session.role) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUserId || !isAdminRole(req.session.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUserId || req.session.role !== 'OWNER') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

export function requirePageAccess(page: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.adminUserId || !req.session.role) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (isAdminRole(req.session.role)) return next();
    if (req.session.allowedPages?.includes(page)) return next();
    return res.status(403).json({ error: 'Not authorized for this page' });
  };
}

// Re-reads the signed-in user's role and page access on every API request, so a
// deleted, demoted or re-permissioned account takes effect immediately instead of
// when its 8-hour session expires.
export async function refreshSessionUser(req: Request, res: Response, next: NextFunction) {
  const userId = req.session?.adminUserId;
  if (!userId) return next();
  try {
    const user = await prisma.adminUser.findUnique({
      where: { id: userId },
      select: { role: true, pageAccess: { select: { page: true } } }
    });
    if (!user) {
      req.session.adminUserId = undefined;
      req.session.role = undefined;
      req.session.allowedPages = undefined;
      return next();
    }
    req.session.role = user.role;
    req.session.allowedPages = allowedPagesFor(user.role, user.pageAccess.map((entry) => entry.page));
    next();
  } catch (error) {
    next(error);
  }
}

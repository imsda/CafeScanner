import { Request, Response, NextFunction } from 'express';

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

import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUserId || !req.session.role) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUserId || (req.session.role !== 'ADMIN' && req.session.role !== 'OWNER')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requirePageAccess(page: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.adminUserId || !req.session.role) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.session.role === 'ADMIN' || req.session.role === 'OWNER') return next();
    if (req.session.allowedPages?.includes(page)) return next();
    return res.status(403).json({ error: 'Not authorized for this page' });
  };
}

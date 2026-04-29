import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminUserId?: number;
    role?: 'OWNER' | 'ADMIN' | 'SCANNER' | 'CUSTOM';
    allowedPages?: string[];
  }
}

import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminUserId?: number;
    role?: 'ADMIN' | 'SCANNER';
    allowedPages?: string[];
  }
}

import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminUserId?: number;
    role?: 'OWNER' | 'ADMIN' | 'SCANNER' | 'CUSTOM';
    allowedPages?: string[];
    // Fingerprint of the password hash at login; a password change ends other sessions.
    passwordStamp?: string;
  }
}

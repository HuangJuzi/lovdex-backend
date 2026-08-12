/**
 * Auth gate configuration. All knobs are code constants with env overrides —
 * nothing lives in the database, so the login path stays DB-independent.
 * AUTH_ENABLED=false is the escape hatch that reverts to the open no-login
 * mode (see middleware/auth.js).
 */

import { IS_PLATFORM } from '@/constants/config.js';

export const authConfig = {
  /** Allowed login email. */
  email: process.env.AUTH_EMAIL || 'zhiju.huang@sophgo.com',
  /** Fixed verification code. */
  code: process.env.AUTH_CODE || '888888',
  /** HS256 signing key. */
  jwtSecret: process.env.JWT_SECRET || 'lovdex@2026',
  /** Token lifetime: 7 days. */
  expiresInSeconds: 7 * 24 * 60 * 60,
  /** When a token has this much (or less) life left, re-issue on the next request. */
  refreshWindowSeconds: 24 * 60 * 60,
};

/**
 * Whether HTTP/WS auth enforcement is active. Reads env at call time so the
 * AUTH_ENABLED switch takes effect per-request (testable). Platform mode keeps
 * its own auth flow and is exempt.
 */
export const isAuthEnabled = (): boolean =>
  !IS_PLATFORM && process.env.AUTH_ENABLED !== 'false';

import express from 'express';

import { authConfig } from './auth.config.js';
import { extractTokenFromRequest, signToken, verifyToken } from './jwt.js';

const router = express.Router();

const USER = Object.freeze({ id: 1, username: authConfig.email });

// Public login: fixed email + fixed verification code → JWT. No DB writes.
router.post('/login', (req, res) => {
  const { email, code } = (req.body ?? {}) as { email?: unknown; code?: unknown };
  if (
    typeof email !== 'string' ||
    typeof code !== 'string' ||
    email !== authConfig.email ||
    code !== authConfig.code
  ) {
    return res.status(401).json({ error: '邮箱或验证码不正确' });
  }
  const token = signToken({ sub: USER.id, username: USER.username });
  res.json({ token, user: USER });
});

// Public token validation — the frontend boot-checks a stored token here.
router.get('/me', (req, res) => {
  const token = extractTokenFromRequest(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  res.json({ user: { id: payload.sub, username: payload.username } });
});

export default router;

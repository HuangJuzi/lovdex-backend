// Internal-only build: authentication is disabled. All routes and the
// WebSocket gateway are open. A single synthetic local user is attached to
// `req.user` so route handlers that read `req.user.id` keep working without
// a real users table row.

import { appConfigDb } from '../modules/database/index.js';

const LOCAL_USER = Object.freeze({ id: 1, username: 'local' });

// Kept for backwards compatibility with auth routes that may still import it.
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware (still honored when API_KEY env is set).
const validateApiKey = (req, res, next) => {
  if (!process.env.API_KEY) {
    return next();
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Auth disabled: every request is authenticated as the synthetic local user.
const authenticateToken = async (req, res, next) => {
  req.user = LOCAL_USER;
  next();
};

const generateToken = () => '';

// WebSocket auth disabled: accept every connection.
const authenticateWebSocket = () => ({ id: 1, userId: 1, username: 'local' });

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};

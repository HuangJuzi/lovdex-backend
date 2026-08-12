import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';

import authRouter from '../auth.routes.js';
import { authConfig } from '../auth.config.js';
import { signToken } from '../jwt.js';

/** Boots the router on an ephemeral port and runs `run(baseUrl)`. */
async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('login succeeds with the fixed email + code', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authConfig.email, code: authConfig.code }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; user: { username: string } };
    assert.equal(body.user.username, authConfig.email);
    assert.equal(body.token.split('.').length, 3);
  });
});

test('login rejects a wrong code', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authConfig.email, code: '000000' }),
    });
    assert.equal(res.status, 401);
  });
});

test('login rejects a wrong email', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', code: authConfig.code }),
    });
    assert.equal(res.status, 401);
  });
});

test('me returns the user for a valid token', async () => {
  await withServer(async (base) => {
    const token = signToken({ sub: 1, username: authConfig.email });
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { username: string } };
    assert.equal(body.user.username, authConfig.email);
  });
});

test('me returns 401 for a missing token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
  });
});

test('me returns 401 for a garbage token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    assert.equal(res.status, 401);
  });
});

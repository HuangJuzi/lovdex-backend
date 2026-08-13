import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { authConfig, isAuthEnabled } from '../auth.config.js';

// Credentials are read from the JSON config file — this test asserts the
// module picks up exactly what the file contains (so editing the file is what
// changes who can log in, not an env var).
const CONFIG_PATH = fileURLToPath(new URL('../auth.config.json', import.meta.url));
const fileCredentials = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  email: string;
  code: string;
  jwtSecret: string;
};

test('authConfig credentials come from auth.config.json', () => {
  assert.equal(authConfig.email, fileCredentials.email);
  assert.equal(authConfig.code, fileCredentials.code);
  assert.equal(authConfig.jwtSecret, fileCredentials.jwtSecret);
  assert.equal(authConfig.expiresInSeconds, 7 * 24 * 60 * 60);
  assert.equal(authConfig.refreshWindowSeconds, 24 * 60 * 60);
});

test('isAuthEnabled is true by default and false when AUTH_ENABLED=false', () => {
  const original = process.env.AUTH_ENABLED;
  try {
    delete process.env.AUTH_ENABLED;
    assert.equal(isAuthEnabled(), true);
    process.env.AUTH_ENABLED = 'false';
    assert.equal(isAuthEnabled(), false);
    process.env.AUTH_ENABLED = 'true';
    assert.equal(isAuthEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  }
});

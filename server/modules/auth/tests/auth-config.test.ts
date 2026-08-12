import assert from 'node:assert/strict';
import test from 'node:test';

import { authConfig, isAuthEnabled } from '../auth.config.js';

test('authConfig defaults match the fixed login credentials', () => {
  assert.equal(authConfig.email, 'zhiju.huang@sophgo.com');
  assert.equal(authConfig.code, '888888');
  assert.equal(authConfig.jwtSecret, 'lovdex@2026');
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

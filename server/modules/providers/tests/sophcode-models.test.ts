import assert from 'node:assert/strict';
import test from 'node:test';

import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';

test('sophcode models provider builds catalog from `sophcode models`', async () => {
  const provider = new SophcodeProviderModels();
  const def = await provider.getSupportedModels();
  assert.ok(def.OPTIONS.length > 0);
  assert.ok(def.OPTIONS.every((o) => o.value.includes('/')));
  assert.ok(def.DEFAULT.includes('/'));
});

test('sophcode models provider falls back to static catalog on spawn failure', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const provider = new SophcodeProviderModels();
    const def = await provider.getSupportedModels();
    assert.ok(def.OPTIONS.length > 0);
  } finally {
    process.env.PATH = originalPath;
  }
});

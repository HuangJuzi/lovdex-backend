import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('opencode auth reports installed+authenticated when auth.json has providers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const authDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'auth.json'), JSON.stringify({ sophnet: { type: 'api', key: 'sk-x' } }), 'utf8');
  const restore = patchHomeDir(tempRoot);
  try {
    const status = await new OpenCodeProviderAuth().getStatus();
    assert.equal(status.provider, 'opencode');
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
  } finally {
    restore();
  }
});

test('opencode auth reports not authenticated when auth.json is missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const restore = patchHomeDir(tempRoot);
  try {
    const status = await new OpenCodeProviderAuth().getStatus();
    assert.equal(status.authenticated, false);
  } finally {
    restore();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SophcodeSessionSynchronizer } from '@/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('sophcode synchronizer upserts sessions from opencode.db', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-sync-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, path TEXT, time_archived INTEGER, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session (id, title, path, time_archived, time_created, time_updated) VALUES
      ('ses_active', 'My Sophcode Chat', '/tmp', NULL, 1720000000000, 1720000000000),
      ('ses_archived', 'Archived', '/tmp', 1720000000000, 1720000000000, 1720000000000);
  `);
  db.close();

  const restore = patchHomeDir(tempRoot);
  try {
    const synchronizer = new SophcodeSessionSynchronizer();
    const count = await synchronizer.synchronize();
    // Only the non-archived row is scanned.
    assert.equal(count, 1);
  } finally {
    restore();
  }
});

test('sophcode synchronizer returns 0 when opencode.db is absent', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-sync-'));
  const restore = patchHomeDir(tempRoot);
  try {
    const count = await new SophcodeSessionSynchronizer().synchronize();
    assert.equal(count, 0);
  } finally {
    restore();
  }
});
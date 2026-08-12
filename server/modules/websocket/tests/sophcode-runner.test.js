import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { parseSophcodeJsonLine, resolveSophcodeCwd, resolveSophcodePermissionOptions } from '@/sophcode-runner.js';

test('sophcode runner maps permission modes to CLI flags', () => {
  assert.deepEqual(resolveSophcodePermissionOptions('plan'), { args: ['--agent', 'plan'], env: {} });
  assert.deepEqual(resolveSophcodePermissionOptions('bypassPermissions'), { args: ['--auto'], env: {} });
  assert.deepEqual(resolveSophcodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) },
  });
  assert.deepEqual(resolveSophcodePermissionOptions('default'), { args: [], env: {} });
});

test('sophcode runner parses a text event into a stream delta', () => {
  const state = { textByMessage: new Map(), sessionId: null };
  const line = JSON.stringify({
    type: 'text',
    sessionID: 'ses1',
    part: { type: 'text', text: 'hello', messageID: 'msg1' },
  });
  const events = parseSophcodeJsonLine(line, state);
  assert.ok(events.length >= 1);
  assert.equal(events[0].kind, 'stream_delta');
  assert.equal(events[0].content, 'hello');
  assert.equal(events[0].provider, 'sophcode');
});

test('sophcode runner emits token budget and stream_end on step_finish', () => {
  const state = { textByMessage: new Map([['msg1', 'hello']]), sessionId: 'ses1' };
  const line = JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses1',
    part: {
      type: 'step-finish',
      messageID: 'msg1',
      reason: 'stop',
      tokens: { total: 100, input: 80, output: 20 },
    },
  });
  const events = parseSophcodeJsonLine(line, state);
  assert.equal(events[0].kind, 'stream_end');
  const budget = events[1];
  assert.equal(budget.kind, 'status');
  assert.equal(budget.text, 'token_budget');
  assert.equal(budget.tokenBudget.used, 100);
  assert.equal(budget.tokenBudget.inputTokens, 80);
  assert.equal(budget.tokenBudget.outputTokens, 20);
});

test('sophcode runner ignores malformed json lines', () => {
  const state = { textByMessage: new Map(), sessionId: null };
  const events = parseSophcodeJsonLine('not-json', state);
  assert.deepEqual(events, []);
});

test('sophcode runner resolves cwd from the session directory when cwd is empty', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sophcode-runner-'));
  const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);
    INSERT INTO session (id, directory, path) VALUES
      ('ses_1', '/mnt/b/workdir/gitlab/moltbot', ''),
      ('ses_2', '/mnt/b/workdir/gitlab/backend', 'apps/api');
  `);
  db.close();

  const originalHome = os.homedir;
  os.homedir = () => tempRoot;
  try {
    // Empty cwd falls back to the session's stored directory (repo-root case).
    assert.equal(resolveSophcodeCwd('ses_1', ''), '/mnt/b/workdir/gitlab/moltbot');
    // Empty path column still falls back to directory.
    assert.equal(resolveSophcodeCwd('ses_2', undefined), '/mnt/b/workdir/gitlab/backend');
    // An explicit non-empty cwd always wins.
    assert.equal(resolveSophcodeCwd('ses_1', '/explicit'), '/explicit');
    // No session id: fall back to process.cwd().
    assert.equal(resolveSophcodeCwd(null, ''), process.cwd());
  } finally {
    os.homedir = originalHome;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQoderArgs, readQoderSessionId, resolveQoderPermissionOptions } from '../../../qoder-runner.js';

test('buildQoderArgs assembles qodercli resume + model + permission vector', () => {
  const args = buildQoderArgs({
    workingDir: '/tmp/work',
    providerSessionId: 'sess-1',
    model: 'auto',
    effort: 'high',
    permissionMode: 'acceptEdits',
    attachments: ['/tmp/a.png'],
    prompt: 'hello',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--cwd') && args.includes('/tmp/work'));
  assert.ok(args.includes('--resume') && args.includes('sess-1'));
  assert.ok(args.includes('--model') && args.includes('auto'));
  assert.ok(args.includes('--permission-mode') && args.includes('accept_edits'));
  assert.ok(args.includes('--reasoning-effort') && args.includes('high'));
  assert.ok(args.includes('--attachment') && args.includes('/tmp/a.png'));
  assert.equal(args[args.length - 1], 'hello');
});

test('resolveQoderPermissionOptions maps modes to qoder flags', () => {
  assert.deepEqual(resolveQoderPermissionOptions('bypassPermissions'), { args: ['--permission-mode', 'bypass_permissions'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('plan'), { args: ['--permission-mode', 'plan'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('acceptEdits'), { args: ['--permission-mode', 'accept_edits'], env: {} });
  assert.deepEqual(resolveQoderPermissionOptions('default'), { args: [], env: {} });
});

test('readQoderSessionId reads snake then camelCase session id', () => {
  assert.equal(readQoderSessionId({ session_id: 's1' }), 's1');
  assert.equal(readQoderSessionId({ sessionId: 's2' }), 's2');
  assert.equal(readQoderSessionId({}), null);
});
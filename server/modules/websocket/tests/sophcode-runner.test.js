import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSophcodeJsonLine, resolveSophcodePermissionOptions } from '@/sophcode-runner.js';

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

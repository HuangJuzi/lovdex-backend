import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_VERDICTS, PERSISTED_SUB_STATUSES, STATUS_ORDER, SUB_STATUSES,
  isAiVerdict, isPersistedSubStatus, isSubStatus, isTaskStatus,
} from '@/shared/task-status.js';

test('status list is the unified 4', () => {
  assert.deepEqual([...STATUS_ORDER], ['todo', 'in_progress', 'in_review', 'done']);
  assert.equal(isTaskStatus('todo'), true);
  assert.equal(isTaskStatus('backlog'), false);
  assert.equal(isTaskStatus('blocked'), false);
});

test('sub_status is the full 10', () => {
  assert.deepEqual([...SUB_STATUSES], [
    'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
    'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
  ]);
  assert.equal(isSubStatus('running'), true);
  assert.equal(isSubStatus('done'), true);
  assert.equal(isSubStatus('todo'), false);
});

test('persisted subset + ai verdicts', () => {
  assert.deepEqual([...PERSISTED_SUB_STATUSES], ['failed', 'done', 'only_plan', 'needs_review', 'blocked']);
  assert.equal(isPersistedSubStatus('failed'), true);
  assert.equal(isPersistedSubStatus('running'), false);
  assert.deepEqual([...AI_VERDICTS], ['done', 'only_plan', 'needs_review', 'blocked']);
  assert.equal(isAiVerdict('blocked'), true);
  assert.equal(isAiVerdict('failed'), false);
});

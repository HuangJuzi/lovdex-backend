import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskVerdict, TASK_VERDICTS } from '@/shared/types.js';

test('isTaskVerdict accepts the four verdicts', () => {
  for (const v of ['done', 'only_plan', 'needs_review', 'blocked']) {
    assert.equal(isTaskVerdict(v), true);
  }
  assert.equal(isTaskVerdict('in_progress'), false);
  assert.equal(isTaskVerdict(undefined), false);
});

test('TASK_VERDICTS has exactly four values', () => {
  assert.deepEqual([...TASK_VERDICTS], ['done', 'only_plan', 'needs_review', 'blocked']);
});

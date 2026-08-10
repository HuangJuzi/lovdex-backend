import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

test('create_task handler defaults status to todo + uses contextProjectPath', async () => {
  let received: { projectPath?: string; title?: string; status?: string } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't1', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, contextProjectPath: '/ctx-proj' });

  await tools.create_task.handler({ title: 'x' });
  assert.equal(received.status, 'todo');
  assert.equal(received.projectPath, '/ctx-proj');

  // explicit projectPath overrides the context fallback
  await tools.create_task.handler({ title: 'y', projectPath: '/explicit' });
  assert.equal(received.projectPath, '/explicit');
});

test('write_task_summary handler delegates to service', async () => {
  let called = false;
  const fakeTasks = { writeSummary: () => { called = true; return { verdict: 'done' }; } };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'done' });
  assert.equal(called, true);
});

test('write_task_summary handler rejects invalid verdict', async () => {
  const fakeTasks = { writeSummary: () => ({ verdict: 'done' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await assert.rejects(() =>
    tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'bogus' }),
  );
});

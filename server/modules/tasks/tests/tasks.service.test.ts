import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';

function makeDbStub(): TaskDbLike {
  return {
    createTask: (input: {
      projectPath: string;
      title: string;
      description?: string | null;
      executorProvider: string;
      executorModel?: string | null;
    }) => ({ task_id: 't1', ...(input as object), status: 'backlog' }),
    getTask: (id: string) =>
      id === 't1'
        ? { task_id: 't1', status: 'todo', session_id: null, executor_provider: 'claude', project_path: '/p' }
        : null,
    getTaskBySessionId: () => null,
    listTasks: () => [],
    updateTask: (id: string, u: object) => ({ task_id: id, ...u }),
    updateTaskStatus: () => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  } as unknown as TaskDbLike;
}

test('createTask rejects invalid status / engine', () => {
  const svc = createTasksService(makeDbStub(), { broadcast: () => {} });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', status: 'bogus' as never }), /status/);
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'nope' as never }), /executor/);
});

test('createTask defaults status to backlog and broadcasts task_upserted', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub(), { broadcast: (e) => events.push(e) });
  svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
});

test('applyStatusChange broadcasts with actor', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub(), { broadcast: (e) => events.push(e) });
  svc.applyStatusChange('t1', 'in_progress', 'user');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
});

test('startExecution links a session and returns its id', () => {
  const svc = createTasksService(makeDbStub(), { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
});

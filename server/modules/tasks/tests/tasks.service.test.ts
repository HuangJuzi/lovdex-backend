import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';

type StoredTask = {
  task_id: string;
  project_path: string;
  title: string;
  description: string | null;
  status: string;
  executor_provider: string;
  executor_model: string | null;
  position: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
};

function makeDbStub() {
  const tasks = new Map<string, StoredTask>();
  tasks.set('t1', {
    task_id: 't1',
    project_path: '/p',
    title: 'x',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 1,
    session_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  const calls: { linkSession: { taskId: string; sessionId: string }[] } = { linkSession: [] };

  const db = {
    createTask: (input: {
      projectPath: string;
      title: string;
      description?: string | null;
      executorProvider: string;
      executorModel?: string | null;
    }) => {
      const row = { task_id: 't1', ...input, status: 'backlog' };
      tasks.set('t1', row as unknown as StoredTask);
      return row;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: () => null,
    listTasks: () => [...tasks.values()],
    updateTask: (id: string, updates: object) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, ...updates };
      tasks.set(id, next);
      return next;
    },
    updateTaskStatus: (id: string, status: string) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, status });
    },
    linkSession: (taskId: string, sessionId: string) => {
      calls.linkSession.push({ taskId, sessionId });
      const current = tasks.get(taskId);
      if (current) tasks.set(taskId, { ...current, session_id: sessionId });
    },
    deleteTask: (id: string) => {
      tasks.delete(id);
    },
    moveTask: () => {},
  };

  return { db: db as unknown as TaskDbLike, calls };
}

function makeProjectStub(projectPath: string | null) {
  return {
    getProjectPath: (path: string) =>
      path === projectPath
        ? { project_id: 'p1', project_path: path, custom_project_name: null, isStarred: 0, isArchived: 0 }
        : null,
  } as unknown as typeof projectsDb;
}

test('createTask rejects invalid status / engine', () => {
  const svc = createTasksService(makeDbStub().db, { broadcast: () => {} });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', status: 'bogus' as never }), /status/);
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'nope' as never }), /executor/);
});

test('createTask rejects an unknown project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: { projectsDb: makeProjectStub(null) },
  });
  assert.throws(() => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' }), /project not found/);
});

test('createTask defaults status to backlog and broadcasts task_upserted', () => {
  const events: unknown[] = [];
  const svc = createTasksService(makeDbStub().db, {
    broadcast: (e) => events.push(e),
    deps: { projectsDb: makeProjectStub('/p') },
  });
  const task = svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude' });
  assert.equal((task as { status: string }).status, 'backlog');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
});

test('applyStatusChange mutates the stored task and broadcasts the updated row', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  const updated = svc.applyStatusChange('t1', 'in_progress', 'user');
  assert.equal((updated as { status: string }).status, 'in_progress');
  assert.equal((db.getTask('t1') as { status: string }).status, 'in_progress');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { actor: string }).actor, 'user');
  assert.equal((events[0] as { task: { status: string } }).task.status, 'in_progress');
});

test('deleteTask broadcasts task_deleted', () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  const svc = createTasksService(db, { broadcast: (e) => events.push(e) });
  svc.deleteTask('t1');
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, 'task_deleted');
  assert.equal((events[0] as { taskId: string }).taskId, 't1');
  assert.equal((events[0] as { actor: string }).actor, 'user');
  assert.equal(db.getTask('t1'), null);
});

test('startExecution links a session and returns its id', () => {
  const { db, calls } = makeDbStub();
  const svc = createTasksService(db, { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
  assert.deepEqual(calls.linkSession, [{ taskId: 't1', sessionId: 'session-claude-/p' }]);
});

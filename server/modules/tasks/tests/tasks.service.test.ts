import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb } from '@/modules/database/index.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import { AppError } from '@/shared/utils.js';

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
  started_at: string | null;
  completed_at: string | null;
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
    started_at: null,
    completed_at: null,
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
      status?: string;
      sessionId?: string | null;
    }) => {
      const row = {
        task_id: 't1',
        ...input,
        status: input.status ?? 'backlog',
        session_id: input.sessionId ?? null,
      };
      tasks.set('t1', row as unknown as StoredTask);
      return row;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: (sid: string) => {
      for (const task of tasks.values()) {
        if (task.session_id === sid) return task;
      }
      return null;
    },
    listTasks: () => [...tasks.values()],
    updateTask: (id: string, updates: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next: StoredTask = { ...current };
      if (updates.title !== undefined) next.title = String(updates.title);
      if (updates.description !== undefined) next.description = updates.description as string | null;
      if (updates.executorProvider !== undefined) next.executor_provider = String(updates.executorProvider);
      if (updates.executorModel !== undefined) next.executor_model = updates.executorModel as string | null;
      if (updates.sessionId !== undefined) next.session_id = updates.sessionId as string | null;
      if (updates.projectPath !== undefined) next.project_path = String(updates.projectPath);
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

function makeProjectStub(...knownPaths: string[]) {
  return {
    getProjectPath: (path: string) =>
      knownPaths.includes(path)
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

test('getTaskBySessionId returns the decorated task for a linked session', () => {
  const row: StoredTask = {
    task_id: 't1', project_path: '/p', title: 't', description: null,
    status: 'in_progress', executor_provider: 'claude', executor_model: null,
    position: 0, session_id: 's1', started_at: null, completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const db = {
    createTask: () => row,
    getTask: (id: string) => (id === 't1' ? row : null),
    getTaskBySessionId: (sid: string) => (sid === 's1' ? row : null),
    listTasks: () => [row],
    updateTask: () => row,
    updateTaskStatus: () => {},
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  } as unknown as TaskDbLike;
  const svc = createTasksService(db, {
    broadcast: () => {},
    getPendingApprovalSessions: () => new Map([['s1', 'AskUserQuestion']]),
  });
  const got = svc.getTaskBySessionId('s1');
  assert.equal(got?.task_id, 't1');
  assert.equal(got?.approval_pending, true);
  assert.equal(svc.getTaskBySessionId('nope'), null);
});

test('updateTask: backlog/todo task project change deletes the linked session and unlinks', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.equal(row?.session_id, null);
  assert.deepEqual(deleted, ['s1']);
  const stored = db.getTask('t1') as StoredTask;
  assert.equal(stored.project_path, '/q');
  assert.equal(stored.session_id, null);
});

test('updateTask: project change without a session does not delete anything', async () => {
  const { db } = makeDbStub();
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
  assert.deepEqual(deleted, []);
});

test('updateTask: rejects project change for non-backlog/todo tasks', async () => {
  for (const status of ['in_progress', 'in_review', 'done']) {
    const { db } = makeDbStub();
    db.updateTaskStatus('t1', status);
    const svc = createTasksService(db, {
      broadcast: () => {},
      deps: { projectsDb: makeProjectStub('/p') },
    });
    await assert.rejects(
      () => svc.updateTask('t1', { projectPath: '/q' }),
      /not backlog or todo/,
    );
  }
});

test('updateTask: rejects an unknown target project without deleting the session', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  await assert.rejects(() => svc.updateTask('t1', { projectPath: '/nope' }), /project not found/);
  assert.deepEqual(deleted, []);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: selecting the current project is a no-op', async () => {
  const events: unknown[] = [];
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: (e) => events.push(e),
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/p' });
  assert.equal(row?.project_path, '/p');
  assert.deepEqual(deleted, []);
  assert.equal(events.length, 0);
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
});

test('updateTask: tolerates a missing session row when deleting', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p', '/q'),
      deleteSessionHard: async () => {
        const e = new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        throw e;
      },
    },
  });
  const row = await svc.updateTask('t1', { projectPath: '/q' });
  assert.equal(row?.project_path, '/q');
});

test('updateTask: ordinary field updates leave the session untouched', async () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const deleted: string[] = [];
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      deleteSessionHard: async (sid: string) => {
        deleted.push(sid);
      },
    },
  });
  const row = await svc.updateTask('t1', { title: 'new title' });
  assert.equal(row?.title, 'new title');
  assert.equal((db.getTask('t1') as StoredTask).session_id, 's1');
  assert.deepEqual(deleted, []);
});

type SessionLike = { session_id: string; project_path: string | null };

function makeSessionStub(rows: Record<string, SessionLike>) {
  return {
    getSessionById: (sid: string) => rows[sid] ?? null,
  } as unknown as typeof import('@/modules/database/index.js').sessionsDb;
}

test('createTask with a sessionId links the task and honors status', () => {
  const { db } = makeDbStub();
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  const task = svc.createTask({
    title: 'x',
    projectPath: '/p',
    executorProvider: 'claude',
    status: 'todo',
    sessionId: 's1',
  }) as StoredTask;
  assert.equal(task.session_id, 's1');
  assert.equal(task.status, 'todo');
});

test('createTask with a sessionId rejects an unknown session', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({}),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 'nope' }),
    /session not found/,
  );
});

test('createTask with a sessionId rejects a session from another project', () => {
  const svc = createTasksService(makeDbStub().db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/other' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /does not belong/,
  );
});

test('createTask with a sessionId rejects a session already linked to a task', () => {
  const { db } = makeDbStub();
  db.linkSession('t1', 's1');
  const svc = createTasksService(db, {
    broadcast: () => {},
    deps: {
      projectsDb: makeProjectStub('/p'),
      sessionsDb: makeSessionStub({ s1: { session_id: 's1', project_path: '/p' } }),
    },
  });
  assert.throws(
    () => svc.createTask({ title: 'x', projectPath: '/p', executorProvider: 'claude', sessionId: 's1' }),
    /already linked/,
  );
});

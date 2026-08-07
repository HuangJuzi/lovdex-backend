import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'tasks-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('tasksDb CRUD + status validation + session link', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({
      projectPath: '/tmp/example-repo',
      title: '修登录页',
      description: '401 跳转',
      executorProvider: 'claude',
      executorModel: 'Sonnet 4.6',
    });
    assert.equal(created.status, 'backlog');
    assert.equal(created.executor_provider, 'claude');
    // SQLite timestamps are normalized to ISO (with a T) so clients never
    // parse them as local time.
    assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(created.updated_at, /^\d{4}-\d{2}-\d{2}T/);

    const list = tasksDb.listTasks({});
    assert.equal(list.length, 1);

    tasksDb.updateTaskStatus(created.task_id, 'in_progress');
    assert.equal(tasksDb.getTask(created.task_id)?.status, 'in_progress');

    tasksDb.linkSession(created.task_id, 'session-abc');
    assert.equal(tasksDb.getTaskBySessionId('session-abc')?.task_id, created.task_id);

    tasksDb.deleteTask(created.task_id);
    assert.equal(tasksDb.getTask(created.task_id), null);
  });
});

test('tasksDb.listTasks filters by project and status', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/a');
    projectsDb.createProjectPath('/tmp/b');
    const t1 = tasksDb.createTask({ projectPath: '/tmp/a', title: 't1', executorProvider: 'claude' });
    tasksDb.createTask({ projectPath: '/tmp/b', title: 't2', executorProvider: 'codex' });
    tasksDb.updateTaskStatus(t1.task_id, 'todo');

    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/a' }).length, 1);
    assert.equal(tasksDb.listTasks({ status: 'todo' }).length, 1);
    assert.equal(tasksDb.listTasks({ projectPath: '/tmp/b' }).length, 1);
  });
});

test('tasksDb.moveTask reorders within a column without collisions', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/m');
    const a = tasksDb.createTask({ projectPath: '/tmp/m', title: 'A', executorProvider: 'claude' });
    const b = tasksDb.createTask({ projectPath: '/tmp/m', title: 'B', executorProvider: 'claude' });
    const c = tasksDb.createTask({ projectPath: '/tmp/m', title: 'C', executorProvider: 'claude' });
    // positions now 1,2,3 in backlog (distinct)

    // Move C to top (single anchor: before A)
    tasksDb.moveTask(c.task_id, 'backlog', a.task_id, null);
    // Move B between C and A (both anchors → interpolation)
    tasksDb.moveTask(b.task_id, 'backlog', c.task_id, a.task_id);

    // No two tasks share a position
    const positions = tasksDb.listTasks({}).map(t => t.position);
    assert.equal(new Set(positions).size, positions.length, `positions collided: ${positions.join(',')}`);

    // Canonical order: C, B, A
    const order = tasksDb.listTasks({}).map(t => t.title);
    assert.deepEqual(order, ['C', 'B', 'A']);
  });
});

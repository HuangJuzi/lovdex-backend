import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { createTasksService, type TaskBroadcast } from '../services/tasks.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-status-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function makeService(events: unknown[] = []) {
  const broadcast: TaskBroadcast = (e) => { events.push(e); };
  return createTasksService(tasksDb, { broadcast });
}

function seedTask() {
  projectsDb.createProjectPath('/tmp/example-repo');
  const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
  tasksDb.linkSession(created.task_id, 's1');
  return created.task_id;
}

test('createTask defaults to todo', async () => {
  await withIsolatedDatabase(() => {
    projectsDb.createProjectPath('/tmp/example-repo');
    const created = tasksDb.createTask({ projectPath: '/tmp/example-repo', title: 't', executorProvider: 'claude' });
    assert.equal(created.status, 'todo');
  });
});

test('failed session persists sub_status=failed, status stays in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    const row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'failed');
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
  });
});

test('running clears a persisted failed sub_status', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'failed');
    svc.onSessionStatus('s1', 'running');
    assert.equal(svc.getTask(id)?.sub_status, 'running');
    assert.equal(tasksDb.getTask(id)?.sub_status, null);
  });
});

test('writeSummary folds verdict into sub_status and moves non-done back to in_progress', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'blocked', verdict: 'blocked', reason: 'broke' });
    let row = svc.getTask(id);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.sub_status, 'blocked');
    assert.equal(row?.verdict_reason, 'broke');
    assert.equal(row?.ai_summary, 'blocked');

    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.writeSummary(id, { summary: 'done', verdict: 'done', reason: 'ok' });
    row = svc.getTask(id);
    assert.equal(row?.status, 'in_review');
    assert.equal(row?.sub_status, 'done');
  });
});

test('writeSummary does not move a task the user already dragged out of in_review', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    svc.onSessionStatus('s1', 'completed');
    svc.applyStatusChange(id, 'todo', 'user');
    svc.writeSummary(id, { summary: 'late', verdict: 'blocked' });
    assert.equal(svc.getTask(id)?.status, 'todo');
    assert.equal(svc.getTask(id)?.sub_status, 'blocked');
  });
});

test('reconcileFailedTasks marks orphaned in_progress tasks failed', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const svc = makeService();
    svc.onSessionStatus('s1', 'running');
    const changed = svc.reconcileFailedTasks(() => new Set());
    assert.equal(changed, 1);
    assert.equal(tasksDb.getTask(id)?.sub_status, 'failed');
  });
});

test('reconcileFailedTasks broadcasts the refreshed sub_status, not the stale row', async () => {
  await withIsolatedDatabase(() => {
    const id = seedTask();
    const events: unknown[] = [];
    const svc = makeService(events);
    svc.onSessionStatus('s1', 'running');
    svc.reconcileFailedTasks(() => new Set());
    const matching = events.filter(
      (e) => (e as { kind: string; task?: { task_id?: string } }).kind === 'task_upserted'
        && (e as { task?: { task_id?: string } }).task?.task_id === id,
    );
    // The reconcile emit is the last one (after the earlier running-transition emit).
    const event = matching[matching.length - 1] as { task: { sub_status?: string } };
    assert.ok(event, 'expected a task_upserted broadcast for the reconciled task');
    assert.equal(event.task.sub_status, 'failed');
  });
});

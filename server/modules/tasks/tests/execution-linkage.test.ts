import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskRow } from '@/shared/types.js';

type Row = TaskRow & { status: TaskRow['status'] };
function makeDb(initial: Row[]) {
  const rows = [...initial];
  return {
    createTask: (_i: unknown) => rows[0] ?? ({} as TaskRow),
    getTask: (id: string) => rows.find(t => t.task_id === id) ?? null,
    getTaskBySessionId: (sid: string) => rows.find(t => t.session_id === sid) ?? null,
    listTasks: (filter: { status?: TaskRow['status'] } = {}) => filter.status ? rows.filter(t => t.status === filter.status) : rows,
    updateTask: (id: string, u: Partial<TaskRow>) => ({ task_id: id, ...u } as TaskRow),
    updateTaskStatus: (id: string, status: TaskRow['status']) => { const t = rows.find(x => x.task_id === id); if (t) t.status = status; },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
  };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    task_id: 't1',
    project_path: '/p',
    title: 't',
    description: null,
    status: 'todo',
    executor_provider: 'claude',
    executor_model: null,
    position: 0,
    session_id: 's1',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

test('session running advances todo → in_progress', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('session completed advances in_progress → in_review', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'completed');
  assert.equal(rows[0].status, 'in_review');
});

test('session failed rolls back in_progress → todo', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'failed');
  assert.equal(rows[0].status, 'todo');
});

test('session aborted leaves status unchanged', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'aborted');
  assert.equal(rows[0].status, 'in_progress');
});

test('session event for unknown session is a no-op', () => {
  const svc = createTasksService(makeDb([]), { broadcast: () => {} });
  svc.onSessionStatus('nope', 'running');
});

test('running does not touch a done task', () => {
  const rows = [makeRow({ status: 'done', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'done');
});

test('running broadcast carries actor engine', () => {
  const rows = [makeRow({ status: 'todo', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionStatus('s1', 'running');
  assert.equal((events[0] as { kind: string }).kind, 'task_upserted');
  assert.equal((events[0] as { actor: string }).actor, 'engine');
});

test('failed then running re-enters in_progress (retry loop)', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.onSessionStatus('s1', 'failed');
  assert.equal(rows[0].status, 'todo');
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('startExecution advances a backlog task to todo and links a session', () => {
  const rows = [makeRow({ status: 'backlog', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  const result = svc.startExecution('t1', (provider, projectPath) => `session-${provider}-${projectPath}`);
  assert.deepEqual(result, { sessionId: 'session-claude-/p' });
  assert.equal(rows[0].status, 'todo');
});

test('startExecution backlog→todo then running advances to in_progress (full flow)', () => {
  const rows = [makeRow({ status: 'backlog', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.startExecution('t1', () => 'session-claude-/p');
  assert.equal(rows[0].status, 'todo');
  svc.onSessionStatus('s1', 'running');
  assert.equal(rows[0].status, 'in_progress');
});

test('startExecution leaves non-backlog statuses untouched', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} });
  svc.startExecution('t1', () => 'session-claude-/p');
  assert.equal(rows[0].status, 'in_progress');
});

test('onSessionApproval broadcasts approval marker without changing status', () => {
  const rows = [makeRow({ status: 'in_progress', session_id: 's1' })];
  const events: unknown[] = [];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  svc.onSessionApproval('s1', true);
  assert.equal(rows[0].status, 'in_progress');
  assert.equal((events[0] as { approval?: { pending: boolean } }).approval?.pending, true);
  assert.equal((events[0] as { actor: string }).actor, 'engine');
  svc.onSessionApproval('s1', false);
  assert.equal((events[1] as { approval?: { pending: boolean } }).approval?.pending, false);
});

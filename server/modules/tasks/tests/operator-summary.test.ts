import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_OPERATOR_CONFIG } from '@/modules/operators/operator.config.js';
import { createTasksService } from '@/modules/tasks/services/tasks.service.js';
import type { TaskDbLike } from '@/modules/tasks/services/tasks.service.js';
import type { AiVerdict } from '@/shared/task-status.js';
import type { TaskRow, TaskStatus } from '@/shared/types.js';

/**
 * Builds a fully-populated TaskRow (verdict fields default to null) with the
 * given overrides. Mirrors the shape added in T2 so the service's decorate
 * spread sees all required columns.
 */
function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
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
    ai_summary: null,
    verdict: null,
    verdict_reason: null,
    verdict_at: null,
    ...overrides,
  };
}

/**
 * In-memory fake db backed by a live array of rows. Mutations (updateTaskStatus,
 * writeSummary) happen in place so the caller's `rows[i]` reference reflects
 * the change — applyVerdict's auto-move tests assert on `rows[0].status`
 * directly. Implements every method on TaskDbLike plus writeSummary.
 */
function makeDb(rows: TaskRow[]) {
  const tasks = new Map<string, TaskRow>(rows.map((r) => [r.task_id, r]));

  const db = {
    createTask: () => {
      throw new Error('createTask not used in operator-summary tests');
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTaskBySessionId: () => null,
    listTasks: () => [...tasks.values()],
    updateTask: () => {
      throw new Error('updateTask not used in operator-summary tests');
    },
    updateTaskStatus: (id: string, status: string) => {
      const current = tasks.get(id);
      if (current) current.status = status as TaskStatus;
    },
    linkSession: () => {},
    deleteTask: () => {},
    moveTask: () => {},
    writeSummary: (
      taskId: string,
      input: { summary: string; verdict: AiVerdict; reason?: string | null },
    ): TaskRow | null => {
      const current = tasks.get(taskId);
      if (!current) return null;
      current.ai_summary = input.summary;
      current.verdict = input.verdict;
      current.verdict_reason = input.reason ?? null;
      current.verdict_at = new Date().toISOString();
      return current;
    },
  };
  return db as unknown as TaskDbLike;
}

test('writeSummary persists verdict, broadcasts, and auto-moves per default config', () => {
  const events: unknown[] = [];
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), { broadcast: (e) => events.push(e) });
  // Default config: auto_move_enabled=true, auto_move_only_plan_to_todo=true.
  // only_plan + in_review → todo, so writeSummary emits the verdict upsert AND
  // a second task_upserted for the todo move.
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'only_plan', reason: 'r' });
  assert.equal(out?.verdict, 'only_plan');
  assert.equal(rows[0].status, 'todo');
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal((e as { kind: string }).kind, 'task_upserted');
  }
});

test('writeSummary without auto_move leaves the column and emits one event', () => {
  const events: unknown[] = [];
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: (e) => events.push(e),
    getOperatorConfig: () => ({ ...DEFAULT_OPERATOR_CONFIG, auto_move_enabled: false }),
  });
  const out = svc.writeSummary('t1', { summary: 's', verdict: 'only_plan', reason: 'r' });
  assert.equal(out?.verdict, 'only_plan');
  assert.equal(rows[0].status, 'in_review');
  assert.equal(events.length, 1);
});

test('applyVerdict auto-moves only_plan -> todo when auto_move enabled', () => {
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getOperatorConfig: () => ({
      ...DEFAULT_OPERATOR_CONFIG,
      auto_move_enabled: true,
      auto_move_only_plan_to_todo: true,
    }),
  });
  svc.applyVerdict('t1', 'only_plan');
  assert.equal(rows[0].status, 'todo');
});

test('applyVerdict leaves done in in_review by default', () => {
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), { broadcast: () => {} }); // default config
  svc.applyVerdict('t1', 'done');
  assert.equal(rows[0].status, 'in_review');
});

test('applyVerdict moves done -> done when auto_move_done enabled', () => {
  const rows: TaskRow[] = [makeRow({ task_id: 't1', status: 'in_review' })];
  const svc = createTasksService(makeDb(rows), {
    broadcast: () => {},
    getOperatorConfig: () => ({ ...DEFAULT_OPERATOR_CONFIG, auto_move_done: true }),
  });
  svc.applyVerdict('t1', 'done');
  assert.equal(rows[0].status, 'done');
});

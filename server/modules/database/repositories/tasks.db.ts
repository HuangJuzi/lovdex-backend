import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { TaskEngine, TaskRow, TaskStatus } from '@/shared/types.js';

export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
export const TASK_ENGINES: readonly TaskEngine[] = ['claude', 'codex'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskEngine(value: unknown): value is TaskEngine {
  return typeof value === 'string' && (TASK_ENGINES as readonly string[]).includes(value);
}

export const tasksDb = {
  createTask(input: {
    projectPath: string;
    title: string;
    description?: string | null;
    executorProvider: TaskEngine;
    executorModel?: string | null;
  }): TaskRow {
    const db = getConnection();
    const taskId = randomUUID();
    const row = db.prepare(`
      INSERT INTO tasks (task_id, project_path, title, description, status, executor_provider, executor_model)
      VALUES (?, ?, ?, ?, 'backlog', ?, ?)
      RETURNING *
    `).get(taskId, input.projectPath, input.title, input.description ?? null, input.executorProvider, input.executorModel ?? null) as TaskRow;
    return row;
  },

  getTask(taskId: string): TaskRow | null {
    const db = getConnection();
    return (db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined) ?? null;
  },

  getTaskBySessionId(sessionId: string): TaskRow | null {
    const db = getConnection();
    return (db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(sessionId) as TaskRow | undefined) ?? null;
  },

  listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectPath) {
      clauses.push('project_path = ?');
      params.push(filter.projectPath);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM tasks ${where} ORDER BY position ASC, created_at ASC`).all(...params) as TaskRow[];
  },

  updateTask(taskId: string, updates: {
    title?: string;
    description?: string | null;
    executorProvider?: TaskEngine;
    executorModel?: string | null;
    sessionId?: string | null;
  }): TaskRow | null {
    const db = getConnection();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.executorProvider !== undefined) { sets.push('executor_provider = ?'); params.push(updates.executorProvider); }
    if (updates.executorModel !== undefined) { sets.push('executor_model = ?'); params.push(updates.executorModel); }
    if (updates.sessionId !== undefined) { sets.push('session_id = ?'); params.push(updates.sessionId); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);
    if (sets.length === 1) return tasksDb.getTask(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
    return tasksDb.getTask(taskId);
  },

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    const db = getConnection();
    db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(status, taskId);
  },

  linkSession(taskId: string, sessionId: string | null): void {
    const db = getConnection();
    db.prepare('UPDATE tasks SET session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(sessionId, taskId);
  },

  deleteTask(taskId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  },

  moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): void {
    const db = getConnection();
    let position: number;
    if (beforeId) {
      const before = tasksDb.getTask(beforeId);
      position = (before?.position ?? 0) - 1;
    } else if (afterId) {
      const after = tasksDb.getTask(afterId);
      position = (after?.position ?? 0) + 1;
    } else {
      const max = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE status = ?').get(status) as { p: number };
      position = max.p;
    }
    db.prepare('UPDATE tasks SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(status, position, taskId);
  },
};

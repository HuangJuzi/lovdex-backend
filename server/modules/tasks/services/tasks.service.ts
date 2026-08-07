import { projectsDb } from '@/modules/database/index.js';
import { isTaskEngine, isTaskStatus, TASK_STATUSES, tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { AppError } from '@/shared/utils.js';
import type { TaskEngine, TaskRow, TaskStatus } from '@/shared/types.js';

export const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

export type TaskEvent =
  | {
      kind: 'task_upserted';
      task: TaskRow;
      actor: 'user' | 'engine';
      approval?: { pending: boolean };
      timestamp: string;
    }
  | { kind: 'task_deleted'; taskId: string; actor: 'user' | 'engine'; timestamp: string };

export type TaskBroadcast = (event: TaskEvent) => void;

export type TaskDbLike = Pick<
  typeof tasksDb,
  | 'createTask'
  | 'getTask'
  | 'getTaskBySessionId'
  | 'listTasks'
  | 'updateTask'
  | 'updateTaskStatus'
  | 'linkSession'
  | 'deleteTask'
  | 'moveTask'
>;

type CreateTaskInput = {
  projectPath: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  executorProvider?: TaskEngine;
  executorModel?: string | null;
};

/**
 * Broadcast payload before the server-generated `timestamp` is attached.
 * Kept as an explicit union so `emit` can stay type-safe across both kinds.
 */
type TaskEventInput =
  | {
      kind: 'task_upserted';
      task: TaskRow;
      actor: 'user' | 'engine';
      approval?: { pending: boolean };
    }
  | { kind: 'task_deleted'; taskId: string; actor: 'user' | 'engine' };

export function createTasksService(
  db: TaskDbLike,
  opts: {
    broadcast: TaskBroadcast;
    deps?: { projectsDb?: typeof projectsDb };
  },
) {
  const resolveDb = db;
  const resolveProject = opts.deps?.projectsDb ?? projectsDb;

  function emit(event: TaskEventInput): void {
    opts.broadcast({ ...event, timestamp: new Date().toISOString() });
  }

  function applyStatusChange(taskId: string, status: TaskStatus, actor: 'user' | 'engine'): TaskRow | null {
    if (!isTaskStatus(status)) {
      throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
    }
    const row = resolveDb.getTask(taskId);
    if (!row) return null;
    resolveDb.updateTaskStatus(taskId, status);
    const updated = resolveDb.getTask(taskId) ?? row;
    emit({ kind: 'task_upserted', task: updated, actor });
    return updated;
  }

  return {
    STATUS_ORDER,

    createTask(input: CreateTaskInput): TaskRow {
      const status = input.status ?? 'backlog';
      const provider = input.executorProvider ?? 'claude';
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      if (!isTaskEngine(provider)) {
        throw new AppError(`invalid executor_provider: ${String(provider)}`, { code: 'INVALID_EXECUTOR', statusCode: 400 });
      }
      const project = resolveProject.getProjectPath(input.projectPath);
      if (!project) {
        throw new AppError(`project not found: ${input.projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      const row = resolveDb.createTask({
        projectPath: input.projectPath,
        title: input.title,
        description: input.description ?? null,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
      });
      emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    getTask(taskId: string): TaskRow | null {
      return resolveDb.getTask(taskId);
    },

    listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
      if (filter.status !== undefined && !isTaskStatus(filter.status)) {
        throw new AppError(`invalid status: ${String(filter.status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      return resolveDb.listTasks(filter);
    },

    applyStatusChange,

    updateTask(taskId: string, updates: Parameters<TaskDbLike['updateTask']>[1]): TaskRow | null {
      if (updates.executorProvider !== undefined && !isTaskEngine(updates.executorProvider)) {
        throw new AppError(`invalid executor_provider: ${String(updates.executorProvider)}`, {
          code: 'INVALID_EXECUTOR',
          statusCode: 400,
        });
      }
      const row = resolveDb.updateTask(taskId, updates);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    deleteTask(taskId: string): void {
      resolveDb.deleteTask(taskId);
      emit({ kind: 'task_deleted', taskId, actor: 'user' });
    },

    moveTask(taskId: string, status: TaskStatus, beforeId: string | null, afterId: string | null): TaskRow | null {
      if (!isTaskStatus(status)) {
        throw new AppError(`invalid status: ${String(status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      resolveDb.moveTask(taskId, status, beforeId, afterId);
      const row = resolveDb.getTask(taskId);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row;
    },

    startExecution(
      taskId: string,
      createSession: (provider: TaskEngine, projectPath: string) => string,
    ): { sessionId: string } | null {
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      const sessionId = createSession(row.executor_provider, row.project_path);
      resolveDb.linkSession(taskId, sessionId);
      const updated = resolveDb.getTask(taskId) ?? row;
      emit({ kind: 'task_upserted', task: updated, actor: 'user' });
      return { sessionId };
    },

    onSessionStatus(sessionId: string, state: 'running' | 'completed' | 'failed' | 'aborted'): void {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return;
      switch (state) {
        case 'running':
          if (row.status === 'todo') applyStatusChange(row.task_id, 'in_progress', 'engine');
          break;
        case 'completed':
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'in_review', 'engine');
          break;
        case 'failed':
          // Guarded rollback: only a task currently in_progress is rolled back to todo.
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'todo', 'engine');
          break;
        case 'aborted':
          // Deliberate no-op: the task stays in_progress because the user may resume
          // the aborted session (e.g. continue the conversation).
          break;
        default:
          break;
      }
    },

    /**
     * Surface a pending session permission request as a live "等你批准" overlay on
     * the linked task. Unlike `onSessionStatus`, this deliberately does NOT touch
     * the task's status — the marker is a realtime-only flag that the frontend
     * renders on top of the in_progress column and clears once the human decides.
     */
    onSessionApproval(sessionId: string, pending: boolean): void {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return;
      emit({ kind: 'task_upserted', task: row, actor: 'engine', approval: { pending } });
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;

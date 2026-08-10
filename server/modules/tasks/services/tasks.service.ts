import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isTaskEngine, isTaskStatus, TASK_STATUSES, tasksDb } from '@/modules/database/repositories/tasks.db.js';
import { DEFAULT_OPERATOR_CONFIG, type OperatorConfig } from '@/modules/operators/operator.config.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import type { TaskEngine, TaskRow, TaskStatus, TaskVerdict } from '@/shared/types.js';

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
  | 'writeSummary'
>;

type CreateTaskInput = {
  projectPath: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  executorProvider?: TaskEngine;
  executorModel?: string | null;
  sessionId?: string | null;
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
    deps?: {
      projectsDb?: typeof projectsDb;
      sessionsDb?: typeof sessionsDb;
      deleteSessionHard?: (sessionId: string) => Promise<void>;
    };
    /**
     * Returns the app session ids that currently have a pending tool-approval
     * request. Used to decorate task rows with `approval_pending` so the board
     * can reconstruct its "等你批准" overlay on load/reconnect instead of
     * relying solely on one-shot `task_upserted` events that fire while the tab
     * may be closed. Defaults to "no pending sessions" so unit tests that don't
     * care about approvals are unaffected.
     */
    getPendingApprovalSessions?: () => Set<string>;
    /**
     * Returns the app session ids that currently have an actively-running run.
     * Used to derive the realtime `failed` flag on in_progress tasks: a run that
     * died without a terminal success (failed run, backend restart, crash,
     * SIGKILL, hung-then-reaped subprocess) never delivers a `session_status`,
     * so without this the task would read as "进行中" forever. When provided, a
     * task whose session has no live run is decorated with `failed: true`.
     * Defaults to undefined (flag is false) so unit tests and installs without
     * the chat registry are unaffected.
     */
    getRunningSessions?: () => Set<string>;
    /**
     * Returns the current operator agent configuration. Used by applyVerdict to
     * decide whether an auto-verdict should also auto-move the task column
     * (only_plan → todo, done → done). Defaults to DEFAULT_OPERATOR_CONFIG so
     * unit tests and installs without the config repo are unaffected.
     */
    getOperatorConfig?: () => OperatorConfig;
    /**
     * Fired after a linked session transitions to `completed` (after the
     * in_progress → in_review move). The auto-verdict trigger (T9) hooks here
     * to schedule a headless operator run that judges the session and writes a
     * summary + verdict. Optional so unit tests and installs without the
     * trigger are unaffected. `sessionId` may be null when the row has no
     * linked session, in which case the caller typically no-ops.
     */
    onTaskCompleted?: (taskId: string, title: string, sessionId: string | null) => void;
  },
) {
  const resolveDb = db;
  const resolveProject = opts.deps?.projectsDb ?? projectsDb;
  const resolveSession =
    opts.deps?.sessionsDb?.getSessionById
    ?? ((_sessionId: string) => null);

  /**
   * Hard-deletes a session row plus its transcript file. Production default is a
   * lazy import of sessionsService so unit tests (which inject a stub) never pull
   * in the websocket/chat-run-registry dependency chain.
   */
  const deleteSessionHard: (sessionId: string) => Promise<void> =
    opts.deps?.deleteSessionHard
    ?? ((sessionId) =>
        import('@/modules/providers/services/sessions.service.js').then(({ sessionsService }) =>
          sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true }),
        ));
  const pendingApprovalSessions = opts.getPendingApprovalSessions ?? (() => new Set<string>());
  const runningSessions = opts.getRunningSessions;

  /**
   * Stamps the realtime flags onto a task row. Neither flag is persisted — both
   * are recomputed from the chat run registry's in-memory sets on every read, so
   * the board sees the truth whether it loaded the list fresh, reconnected after
   * a WS drop, or received a live upsert:
   * - `approval_pending`: the linked session has a pending tool-approval.
   * - `failed`: the linked session has NO live run while the task reads as
   *   in_progress. That is the "run died without a terminal success" case —
   *   failed run, backend restart, crash, SIGKILL, hung-then-reaped subprocess.
   *   The task keeps its status (and its in_progress column slot); the board
   *   renders a "失败" badge instead of the running spinner. Opt-in: without a
   *   `getRunningSessions` source the flag is simply false.
   */
  function decorate(row: TaskRow): TaskRow {
    const pending = Boolean(row.session_id) && pendingApprovalSessions().has(row.session_id as string);
    const failed = Boolean(
      runningSessions
      && row.session_id
      && row.status === 'in_progress'
      && !runningSessions().has(row.session_id),
    );
    return { ...row, approval_pending: pending, failed };
  }

  function emit(event: TaskEventInput): void {
    if (event.kind === 'task_upserted') {
      opts.broadcast({ ...event, task: decorate(event.task), timestamp: new Date().toISOString() });
    } else {
      opts.broadcast({ ...event, timestamp: new Date().toISOString() });
    }
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
    return decorate(updated);
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
      if (input.sessionId != null) {
        const session = resolveSession(input.sessionId);
        if (!session) {
          throw new AppError(`session not found: ${input.sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        if (normalizeProjectPath(session.project_path ?? '') !== normalizeProjectPath(input.projectPath)) {
          throw new AppError('session does not belong to this project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        }
        if (resolveDb.getTaskBySessionId(input.sessionId)) {
          throw new AppError('session is already linked to a task', { code: 'SESSION_ALREADY_LINKED', statusCode: 409 });
        }
      }
      const row = resolveDb.createTask({
        projectPath: input.projectPath,
        title: input.title,
        description: input.description ?? null,
        status,
        executorProvider: provider,
        executorModel: input.executorModel ?? null,
        sessionId: input.sessionId ?? null,
      });
      emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return decorate(row);
    },

    getTask(taskId: string): TaskRow | null {
      const row = resolveDb.getTask(taskId);
      return row ? decorate(row) : null;
    },

    getTaskBySessionId(sessionId: string): TaskRow | null {
      const row = resolveDb.getTaskBySessionId(sessionId);
      return row ? decorate(row) : null;
    },

    listTasks(filter: { projectPath?: string; status?: TaskStatus } = {}): TaskRow[] {
      if (filter.status !== undefined && !isTaskStatus(filter.status)) {
        throw new AppError(`invalid status: ${String(filter.status)}`, { code: 'INVALID_STATUS', statusCode: 400 });
      }
      return resolveDb.listTasks(filter).map(decorate);
    },

    applyStatusChange,

    async updateTask(taskId: string, updates: Parameters<TaskDbLike['updateTask']>[1]): Promise<TaskRow | null> {
      if (updates.executorProvider !== undefined && !isTaskEngine(updates.executorProvider)) {
        throw new AppError(`invalid executor_provider: ${String(updates.executorProvider)}`, {
          code: 'INVALID_EXECUTOR',
          statusCode: 400,
        });
      }
      const current = resolveDb.getTask(taskId);
      if (!current) return null;

      const { projectPath, ...rest } = updates;
      const wantsProjectChange = projectPath !== undefined && projectPath !== current.project_path;

      // Picking the task's current project (with no other changes) is a no-op:
      // no write, no event, no session deletion.
      if (projectPath !== undefined && !wantsProjectChange && Object.keys(rest).length === 0) {
        return decorate(current);
      }

      let effective: Parameters<TaskDbLike['updateTask']>[1] = rest;
      if (wantsProjectChange) {
        if (current.status !== 'backlog' && current.status !== 'todo') {
          throw new AppError('cannot change project for a task that is not backlog or todo', {
            code: 'PROJECT_CHANGE_NOT_ALLOWED',
            statusCode: 400,
          });
        }
        if (!resolveProject.getProjectPath(projectPath)) {
          throw new AppError(`project not found: ${projectPath}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
        }
        if (current.session_id) {
          try {
            await deleteSessionHard(current.session_id);
          } catch (err) {
            // A session row that is already gone shouldn't block the project
            // change — the outcome (unlink from a dead session) is the same.
            if ((err as AppError)?.code !== 'SESSION_NOT_FOUND') throw err;
          }
        }
        effective = { ...rest, projectPath, sessionId: null };
      }

      const row = resolveDb.updateTask(taskId, effective);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'user' });
      return row ? decorate(row) : null;
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
      return row ? decorate(row) : null;
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
      // A task started directly from the backlog would otherwise never leave
      // the column: the running session event only advances todo → in_progress.
      // Advance backlog → todo so the existing state machine can pick it up.
      // All other statuses are left untouched.
      if (row.status === 'backlog') {
        applyStatusChange(taskId, 'todo', 'user');
      }
      return { sessionId };
    },

    onSessionStatus(sessionId: string, state: 'running' | 'completed' | 'failed' | 'aborted'): void {
      const row = resolveDb.getTaskBySessionId(sessionId);
      if (!row) return;
      switch (state) {
        case 'running':
          // A live run means the agent is actively working, so the task must
          // read as in_progress — not just for the initial todo→in_progress
          // start, but whenever work resumes on a task that had settled into
          // in_review (or a done task the user reopened to ask for more). The
          // board should never show "评审中/已完成" while the agent is typing.
          // An already-running task just re-emits its row so live boards
          // recompute the realtime flags — e.g. a retry on a failed (still
          // in_progress) task clears its "失败" badge the moment the fresh run
          // starts.
          if (row.status !== 'in_progress') {
            applyStatusChange(row.task_id, 'in_progress', 'engine');
          } else {
            emit({ kind: 'task_upserted', task: row, actor: 'engine' });
          }
          break;
        case 'completed':
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'in_review', 'engine');
          // Fire the auto-verdict hook AFTER the in_review transition. The T9
          // trigger attaches here to schedule a headless operator run. Optional
          // so installs without the trigger (and existing unit tests) are
          // unaffected.
          opts.onTaskCompleted?.(row.task_id, row.title, row.session_id);
          break;
        case 'failed':
          // A failed run does NOT move the task: it keeps its in_progress slot
          // and the board surfaces the failure via the realtime `failed` flag
          // (recomputed on every read from the run registry). Emit the row so
          // live boards swap the running spinner for the "失败" badge.
          if (row.status === 'in_progress') emit({ kind: 'task_upserted', task: row, actor: 'engine' });
          break;
        case 'aborted':
          // The human stopped the run: roll back to todo so the board stops
          // reading as "进行中". The linked session is preserved, so the user
          // can still resume it (打开会话) or start a fresh run.
          if (row.status === 'in_progress') applyStatusChange(row.task_id, 'todo', 'engine');
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

    /**
     * Persist the operator agent's post-run verdict (AI summary + verdict bucket +
     * optional reason) on a task. Broadcasts a task_upserted so live boards swap
     * the in_review card for the verdict badge the moment the run settles. The
     * verdict column itself is written by the db layer; this method is the
     * service-side wrapper that also fires the realtime event.
     */
    writeSummary(
      taskId: string,
      input: { summary: string; verdict: TaskVerdict; reason?: string | null },
    ): TaskRow | null {
      const row = resolveDb.writeSummary(taskId, input);
      if (row) emit({ kind: 'task_upserted', task: row, actor: 'engine' });
      return row ? decorate(row) : null;
    },

    /**
     * Apply the auto-move policy for an operator verdict. Called after a verdict
     * is recorded (writeSummary or an external caller) to advance the task's
     * column per the operator config:
     * - only_plan + auto_move_only_plan_to_todo + in_review → todo
     * - done + auto_move_done + in_review → done
     * - needs_review / blocked: stay in in_review (human decides)
     * When auto_move_enabled is off (or no config source), the column is left
     * untouched. Returns the (possibly moved) decorated row.
     */
    applyVerdict(taskId: string, verdict: TaskVerdict): TaskRow | null {
      const cfg = opts.getOperatorConfig?.() ?? DEFAULT_OPERATOR_CONFIG;
      const row = resolveDb.getTask(taskId);
      if (!row) return null;
      if (cfg.auto_move_enabled) {
        if (verdict === 'only_plan' && cfg.auto_move_only_plan_to_todo && row.status === 'in_review') {
          applyStatusChange(taskId, 'todo', 'engine');
        } else if (verdict === 'done' && cfg.auto_move_done && row.status === 'in_review') {
          applyStatusChange(taskId, 'done', 'engine');
        }
        // needs_review / blocked: stay in in_review
      }
      return decorate(resolveDb.getTask(taskId) ?? row);
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;

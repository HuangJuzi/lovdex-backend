import { isAiVerdict, type AiVerdict } from '@/shared/task-status.js';
import type { TaskEngine } from '@/shared/types.js';

/**
 * Dependencies injected into the operator tool set so handlers are testable
 * without touching the real services/databases. T8 (SDK wiring) will inject
 * the real `tasksService`, `projectsDb`, `sessionsService`, and the
 * `createSession` SessionCreator used by the tasks router.
 *
 * `projects`, `sessions`, and `createSession` are optional so pure-logic
 * handlers (`create_task`, `write_task_summary`) can be unit-tested with only
 * a fake `tasks` service. Handlers that reference an optional dep use a
 * non-null assertion — they are wired in production by T8 and a missing dep
 * at call time is a wiring bug, not a recoverable runtime state.
 *
 * REAL method names (grepped from the codebase):
 *  - projectsDb.getProjectPaths()           → list active projects
 *  - projectsDb.getProjectPathById(id)      → resolve project dir from projectId
 *  - sessionsService.fetchHistory(id, opts) → returns { messages, total, hasMore, ... }
 *  - SessionCreator = (provider: TaskEngine, projectPath: string) => string
 *    (defined in server/modules/tasks/tasks.routes.ts, passed to
 *    tasksService.startExecution)
 */
export type OperatorToolDeps = {
  tasks: {
    createTask: (i: {
      projectPath: string;
      title: string;
      description?: string | null;
      status?: string;
    }) => unknown;
    listTasks: (f: { projectPath?: string; status?: string }) => unknown[];
    getTask: (id: string) => unknown;
    writeSummary: (
      id: string,
      i: { summary: string; verdict: AiVerdict; reason?: string | null },
    ) => unknown;
    startExecution: (
      id: string,
      createSession: (provider: TaskEngine, projectPath: string) => string,
    ) => unknown;
    updateTask: (id: string, u: Record<string, unknown>) => Promise<unknown>;
    moveTask: (
      id: string,
      status: string,
      before: string | null,
      after: string | null,
    ) => unknown;
  };
  projects?: {
    /** List active (non-archived) projects. Real name: projectsDb.getProjectPaths */
    getProjectPaths: () => unknown[];
    /** Resolve project directory from a projectId. Real name: projectsDb.getProjectPathById */
    getProjectPathById: (projectId: string) => string | null;
  };
  sessions?: {
    /**
     * Fetch a session's persisted message history. Real name:
     * sessionsService.fetchHistory — returns { messages, total, hasMore, offset, limit }.
     * Supports pagination via limit/offset so the operator can read large
     * transcripts in chunks instead of blowing the token budget.
     */
    fetchHistory: (
      sessionId: string,
      options?: { limit?: number | null; offset?: number },
    ) => Promise<unknown>;
  };
  /**
   * Allocates a new app-facing session id for a provider+project. Real type:
   * SessionCreator from tasks.routes.ts. Injected here so start_task_execution
   * can dispatch a task without hardcoding the session-creation strategy.
   */
  createSession?: (provider: TaskEngine, projectPath: string) => string;
  contextProjectPath?: string | null;
};

export function buildOperatorTools(deps: OperatorToolDeps) {
  return {
    list_projects: {
      description: 'List all projects',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => deps.projects!.getProjectPaths(),
    },
    list_tasks: {
      description: 'List tasks, optional projectPath/status filter',
      inputSchema: {
        type: 'object',
        properties: { projectPath: { type: 'string' }, status: { type: 'string' } },
      },
      handler: async (i: { projectPath?: string; status?: string }) =>
        deps.tasks.listTasks({ projectPath: i.projectPath, status: i.status }),
    },
    get_task: {
      description: 'Get a single task by id',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (i: { taskId: string }) => deps.tasks.getTask(i.taskId),
    },
    get_session_transcript: {
      description:
        'Read a session transcript as compact text (user prompts, assistant text, tool_use names + truncated results) to judge task completion. Paginates — pass limit/offset for large sessions. Returns { total, offset, limit, hasMore, transcript } where transcript is plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', description: 'max messages per page (default 40)' },
          offset: { type: 'number', description: 'message offset for pagination (default 0)' },
        },
        required: ['sessionId'],
      },
      handler: async (i: { sessionId: string; limit?: number; offset?: number }) => {
        const limit = typeof i.limit === 'number' && i.limit > 0 ? i.limit : 40;
        const offset = typeof i.offset === 'number' && i.offset >= 0 ? i.offset : 0;
        const result = (await deps.sessions!.fetchHistory(i.sessionId, { limit, offset })) as {
          messages?: unknown[];
          total?: number;
          hasMore?: boolean;
        };
        const messages = Array.isArray(result?.messages) ? result.messages : [];
        // Compact each message to plain text so we don't blow the token budget
        // with raw provider payloads. The operator only needs the gist of what
        // the agent did, not every byte.
        const lines: string[] = [];
        for (const msg of messages) {
          const m = msg as {
            role?: string;
            kind?: string;
            content?: string;
            commandName?: string;
            toolName?: string;
            toolResult?: string;
            isLocalCommand?: boolean;
          };
          const role = m.role ?? m.kind ?? 'message';
          if (m.isLocalCommand && m.commandName) {
            lines.push(`[${role}] /${m.commandName}`);
            continue;
          }
          if (role === 'tool' || m.kind === 'tool') {
            const res = typeof m.toolResult === 'string' ? m.toolResult : '';
            lines.push(`[tool ${m.toolName ?? ''}] ${res.slice(0, 300)}`);
            continue;
          }
          const text = (m.content ?? '').trim();
          if (text) {
            lines.push(`[${role}] ${text.slice(0, 1200)}`);
          }
        }
        return {
          total: result?.total ?? messages.length,
          offset,
          limit,
          hasMore: Boolean(result?.hasMore),
          transcript: lines.join('\n\n') || '(empty transcript)',
        };
      },
    },
    create_task: {
      description:
        'Create a task (defaults to todo/代办). Uses contextProjectPath if projectPath omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['title'],
      },
      handler: async (i: {
        projectPath?: string;
        title: string;
        description?: string;
        status?: string;
      }) =>
        deps.tasks.createTask({
          projectPath: i.projectPath ?? deps.contextProjectPath ?? '',
          title: i.title,
          description: i.description ?? null,
          status: i.status ?? 'todo',
        }),
    },
    start_task_execution: {
      description: 'Dispatch a task: create its session and start the run',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (i: { taskId: string }) =>
        deps.tasks.startExecution(i.taskId, deps.createSession!),
    },
    update_task: {
      description:
        'Update task fields. Use move_task for status changes; update_task is for title/description/executor.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          executorProvider: { type: 'string' },
          executorModel: { type: 'string' },
        },
        required: ['taskId'],
      },
      handler: async (i: {
        taskId: string;
        title?: string;
        description?: string;
        executorProvider?: string;
        executorModel?: string;
      }) => {
        const { taskId, ...rest } = i;
        return deps.tasks.updateTask(taskId, rest);
      },
    },
    move_task: {
      description: 'Move a task to a status',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' }, status: { type: 'string' } },
        required: ['taskId', 'status'],
      },
      handler: async (i: { taskId: string; status: string }) =>
        deps.tasks.moveTask(i.taskId, i.status, null, null),
    },
    write_task_summary: {
      description:
        'Write AI summary + verdict onto a task. verdict ∈ done | only_plan | needs_review | blocked',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string' },
          verdict: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['taskId', 'summary', 'verdict'],
      },
      handler: async (i: {
        taskId: string;
        summary: string;
        verdict: string;
        reason?: string;
      }) => {
        if (!isAiVerdict(i.verdict)) throw new Error(`invalid verdict: ${i.verdict}`);
        return deps.tasks.writeSummary(i.taskId, {
          summary: i.summary,
          verdict: i.verdict as AiVerdict,
          reason: i.reason,
        });
      },
    },
  };
}

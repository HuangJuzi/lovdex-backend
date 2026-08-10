import { isTaskVerdict, type TaskEngine, type TaskVerdict } from '@/shared/types.js';

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
      i: { summary: string; verdict: TaskVerdict; reason?: string | null },
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
     * sessionsService.fetchHistory — returns { messages, total, hasMore, ... }.
     * This is the closest equivalent to "get session transcript": it returns
     * the normalized assistant/user turns + tool calls the provider adapter
     * exposes. Raw tool-result payloads may be summarized by the adapter.
     */
    fetchHistory: (sessionId: string) => unknown;
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
        'Read a session transcript (assistant turns + tool calls + results) to judge task completion',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      handler: async (i: { sessionId: string }) => deps.sessions!.fetchHistory(i.sessionId),
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
      description: 'Update task fields',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (i: { taskId: string }) => deps.tasks.updateTask(i.taskId, i),
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
        if (!isTaskVerdict(i.verdict)) throw new Error(`invalid verdict: ${i.verdict}`);
        return deps.tasks.writeSummary(i.taskId, {
          summary: i.summary,
          verdict: i.verdict as TaskVerdict,
          reason: i.reason,
        });
      },
    },
  };
}

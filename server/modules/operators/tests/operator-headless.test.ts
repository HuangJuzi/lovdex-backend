import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperatorSdkTools,
  runOperatorHeadless,
} from '@/claude-sdk.js';

/**
 * Minimal fake OperatorToolDeps.tasks — stubs every method the operator tool
 * set references so buildOperatorTools/buildOperatorSdkTools can wire without
 * the real TasksService. Only `writeSummary` is exercised here; the rest just
 * need to exist so the tool handlers can be constructed.
 */
function fakeTasks() {
  return {
    createTask: (i: unknown) => ({ task_id: 't1', ...(i as object) }),
    listTasks: () => [],
    getTask: (id: string) => ({ task_id: id }),
    writeSummary: (id: string, i: unknown) => ({ task_id: id, ...(i as object) }),
    startExecution: (id: string) => ({ task_id: id, started: true }),
    updateTask: (id: string, u: unknown) => ({ task_id: id, ...(u as object) }),
    moveTask: (id: string, status: string) => ({ task_id: id, status }),
  };
}

function fakeDeps() {
  return {
    tasks: fakeTasks(),
    projects: {
      getProjectPaths: () => [],
      getProjectPathById: () => null,
    },
    sessions: {
      fetchHistory: () => ({ messages: [], total: 0 }),
    },
    contextProjectPath: null,
  };
}

/** An async iterable that drains immediately — simulates a query() result. */
function emptyIterable() {
  return (async function* () {
    /* no messages */
  })();
}

test('buildOperatorSdkTools includes the closed operator tool set', () => {
  const tools = buildOperatorSdkTools(fakeDeps() as never);
  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('write_task_summary'), `write_task_summary missing: ${names.join(',')}`);
  // safety boundary: no built-in bash/Edit/Write leak in the operator tool set
  for (const forbidden of ['Bash', 'Edit', 'Write', 'Read', 'AskUserQuestion']) {
    assert.ok(!names.includes(forbidden), `${forbidden} leaked into operator tools`);
  }
});

test('runOperatorHeadless calls query with prompt containing sessionId/taskId/title', async () => {
  let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
  const queryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => {
    captured = params;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 'sess-123',
    taskId: 'task-456',
    title: 'Implement login',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      auto_move_enabled: true,
      auto_move_done: false,
      auto_move_only_plan_to_todo: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  const prompt = String(captured.prompt);
  assert.ok(prompt.includes('sess-123'), `prompt missing sessionId: ${prompt}`);
  assert.ok(prompt.includes('task-456'), `prompt missing taskId: ${prompt}`);
  assert.ok(prompt.includes('Implement login'), `prompt missing title: ${prompt}`);

  const options = captured.options!;
  // operator MCP server wired
  const mcp = options.mcpServers as Record<string, unknown>;
  assert.ok(mcp && mcp['lovdex-operator'], 'operator mcp server not wired');
  // closed tool set: built-in tools disabled
  assert.deepEqual(options.tools, [], 'built-in tools not disabled');
  // headless: no websocket sink plumbed through the SDK options
  assert.ok(!('ws' in options) && !('writer' in options), 'ws/writer leaked into headless options');
});

test('runOperatorHeadless swallows query failures (logs, does not throw)', async () => {
  const throwingQuery = () => {
    return (async function* () {
      throw new Error('boom from claude');
    })();
  };

  // must not reject
  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: throwingQuery as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: true,
      auto_move_enabled: true,
      auto_move_done: false,
      auto_move_only_plan_to_todo: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });
});

test('runOperatorHeadless returns early without calling query when auto_verdict_enabled is false', async () => {
  let called = false;
  const queryFn = () => {
    called = true;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: true,
      auto_verdict_enabled: false,
      auto_move_enabled: true,
      auto_move_done: false,
      auto_move_only_plan_to_todo: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  assert.equal(called, false, 'query was called despite auto_verdict_enabled=false');
});

test('runOperatorHeadless returns early when operator disabled', async () => {
  let called = false;
  const queryFn = () => {
    called = true;
    return emptyIterable();
  };

  await runOperatorHeadless({
    sessionId: 's',
    taskId: 't',
    title: 'x',
    queryFn: queryFn as never,
    deps: fakeDeps() as never,
    config: {
      enabled: false,
      auto_verdict_enabled: true,
      auto_move_enabled: true,
      auto_move_done: false,
      auto_move_only_plan_to_todo: true,
      model: '',
      workspace: '/tmp/op',
      max_concurrent: 1,
      verdict_prompt_override: null,
      interactive_chat_enabled: true,
    },
  });

  assert.equal(called, false, 'query was called despite enabled=false');
});

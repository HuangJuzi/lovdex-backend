import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperatorTools } from '@/modules/operators/operator.tools.js';

test('create_task handler defaults status to todo + uses contextProjectPath', async () => {
  let received: { projectPath?: string; title?: string; status?: string } = {};
  const fakeTasks = {
    createTask: (i: unknown) => {
      received = i as typeof received;
      return { task_id: 't1', status: 'todo' };
    },
  };
  const tools = buildOperatorTools({ tasks: fakeTasks as never, contextProjectPath: '/ctx-proj' });

  await tools.create_task.handler({ title: 'x' });
  assert.equal(received.status, 'todo');
  assert.equal(received.projectPath, '/ctx-proj');

  // explicit projectPath overrides the context fallback
  await tools.create_task.handler({ title: 'y', projectPath: '/explicit' });
  assert.equal(received.projectPath, '/explicit');
});

test('write_task_summary handler delegates to service', async () => {
  let called = false;
  const fakeTasks = { writeSummary: () => { called = true; return { verdict: 'done' }; } };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'done' });
  assert.equal(called, true);
});

test('write_task_summary handler rejects invalid verdict', async () => {
  const fakeTasks = { writeSummary: () => ({ verdict: 'done' }) };
  const tools = buildOperatorTools({ tasks: fakeTasks as never });
  await assert.rejects(() =>
    tools.write_task_summary.handler({ taskId: 't1', summary: 's', verdict: 'bogus' }),
  );
});

test('get_session_transcript returns finalOutput = newest assistant text (offset 0)', async () => {
  const messages = [
    { role: 'user', content: '开头' },
    { role: 'assistant', content: '我在改代码' },
    { role: 'tool', kind: 'tool', toolName: 'Bash', toolResult: 'ok' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '要我按你惯常的方式提交并推送吗？还是先在 dev server 里看效果？' },
  ];
  const fakeSessions = {
    fetchHistory: async () => ({ messages, total: messages.length, hasMore: false }),
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's' });
  assert.equal(out.finalOutput, '要我按你惯常的方式提交并推送吗？还是先在 dev server 里看效果？');
  assert.ok(out.transcript.includes('要我按你惯常的方式提交并推送吗？'), 'final question should also appear in transcript');
  assert.equal(out.offset, 0);
  assert.equal(out.limit, 40);
});

test('get_session_transcript finalOutput stays the newest assistant text when paginating older pages', async () => {
  const tailMessages = [{ role: 'assistant', content: '最终输出：全部完成，无待决策事项' }];
  const pageMessages = [{ role: 'user', content: '一段更早的历史消息' }];
  const fakeSessions = {
    fetchHistory: async (_id: string, opts: { limit?: number; offset?: number }) => {
      const offset = opts?.offset ?? 0;
      return { messages: offset === 0 ? tailMessages : pageMessages, total: 100, hasMore: true };
    },
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's', offset: 40, limit: 40 });
  assert.equal(out.finalOutput, '最终输出：全部完成，无待决策事项');
  assert.ok(out.transcript.includes('一段更早的历史消息'), 'page should carry the requested older slice');
});

test('get_session_transcript finalOutput is null when no assistant text exists', async () => {
  const fakeSessions = {
    fetchHistory: async () => ({ messages: [{ role: 'user', content: '只有用户消息' }], total: 1, hasMore: false }),
  };
  const tools = buildOperatorTools({ tasks: {} as never, sessions: fakeSessions as never });
  const out = await tools.get_session_transcript.handler({ sessionId: 's' });
  assert.equal(out.finalOutput, null);
});

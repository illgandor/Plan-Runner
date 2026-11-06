// P25-S01 (CONTRACTS §Chat timeline, D-109): subagent tool rows carry `parent`, subagent text is
// dropped, and task_started/task_notification map to `task` events. Top-level events must stay
// byte-identical — no `parent` key at all — so every existing consumer is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const { mapMessage } = require('../src/session');

const assistant = (content, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content } });
const user = (content, parent = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content } });
const blocks = [
  { type: 'text', text: 'hi' },
  { type: 'thinking', thinking: 'hmm' },
  { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } },
];

test('top-level assistant/user messages map exactly as before, with no parent key', () => {
  assert.deepStrictEqual(mapMessage(assistant(blocks)), [
    { type: 'assistant-text', text: 'hi' },
    { type: 'thinking', text: 'hmm' },
    { type: 'tool-use', toolUseId: 't1', name: 'Read', input: { file_path: 'a.js' } },
  ]);
  const r = mapMessage(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }]));
  assert.deepStrictEqual(r, [{ type: 'tool-result', toolUseId: 't1', result: 'ok', isError: false }]);
  assert.ok(!('parent' in r[0]));
  // A message with no parent_tool_use_id field at all behaves the same.
  assert.ok(!('parent' in mapMessage({ type: 'assistant', message: { content: blocks } })[2]));
});

test('parented tool rows carry parent; parented text and thinking are dropped', () => {
  assert.deepStrictEqual(mapMessage(assistant(blocks, 'agent1')), [
    { type: 'tool-use', toolUseId: 't1', name: 'Read', input: { file_path: 'a.js' }, parent: 'agent1' },
  ]);
  assert.deepStrictEqual(
    mapMessage(user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }], is_error: true }], 'agent1')),
    [{ type: 'tool-result', toolUseId: 't1', result: 'x', isError: true, parent: 'agent1' }]);
});

test('a parented stream_event maps to nothing; a top-level one is unchanged', () => {
  const ev = (parent) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { delta: { type: 'text_delta', text: 'x' } } });
  assert.deepStrictEqual(mapMessage(ev('agent1')), []);
  assert.deepStrictEqual(mapMessage(ev(null)), [{ type: 'text-delta', text: 'x' }]);
});

test('task_started and task_notification map to task events with the frozen fields', () => {
  assert.deepStrictEqual(
    mapMessage({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'agent1', description: 'look', uuid: 'u' }),
    [{ type: 'task', phase: 'started', taskId: 'k1', toolUseId: 'agent1', description: 'look' }]);
  assert.deepStrictEqual(
    mapMessage({ type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'agent1', status: 'failed',
      output_file: 'f', summary: 's', uuid: 'u' }),
    [{ type: 'task', phase: 'done', taskId: 'k1', toolUseId: 'agent1', status: 'failed' }]);
});

test('an absent tool_use_id is null; other system subtypes map to nothing', () => {
  assert.strictEqual(mapMessage({ type: 'system', subtype: 'task_started', task_id: 'k', description: 'd' })[0].toolUseId, null);
  assert.strictEqual(mapMessage({ type: 'system', subtype: 'task_notification', task_id: 'k', status: 'completed' })[0].toolUseId, null);
  for (const subtype of ['task_progress', 'task_updated', 'background_tasks_changed', 'something_new']) {
    assert.deepStrictEqual(mapMessage({ type: 'system', subtype, task_id: 'k' }), [], subtype);
  }
});

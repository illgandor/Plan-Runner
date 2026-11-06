// P25-S04: readable tool rows. tool-view.js is a browser IIFE (like presence-view.js), so we give it a
// window, require it, and drive the three exports. Pure functions — stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');

global.window = {};
require('../src/webview/tool-view.js');
const { toolLabel, toolMeta, todoItems, agentTracker } = global.window;

test('the four names are on window', () => {
  for (const f of [toolLabel, toolMeta, todoItems, agentTracker]) assert.strictEqual(typeof f, 'function');
});

test('toolLabel: MCP names read as server · tool, plain names unchanged', () => {
  assert.strictEqual(toolLabel('mcp__tavily__tavily_search'), 'tavily · tavily_search');
  assert.strictEqual(toolLabel('mcp__claude_ai_Docs__read'), 'claude_ai_Docs · read');
  assert.strictEqual(toolLabel('Read'), 'Read');
  assert.strictEqual(toolLabel('shell'), 'shell');
  assert.strictEqual(toolLabel(undefined), '');
});

test('toolMeta: Read counts result lines', () => {
  assert.strictEqual(toolMeta('Read', { file_path: 'a' }, 'one\ntwo\nthree\n', false), '3 lines');
  assert.strictEqual(toolMeta('Read', {}, 'one', false), '1 line');
});

test('toolMeta: Bash counts lines, or says no output', () => {
  assert.strictEqual(toolMeta('Bash', { command: 'ls' }, 'a\nb', false), '2 lines');
  assert.strictEqual(toolMeta('Bash', { command: 'true' }, '', false), 'no output');
  assert.strictEqual(toolMeta('Bash', { command: 'true' }, '  \n', false), 'no output');
});

test('toolMeta: Grep/Glob count non-empty lines; their own "No … found" is zero', () => {
  assert.strictEqual(toolMeta('Grep', {}, 'a.js\n\nb.js\n', false), '2 results');
  assert.strictEqual(toolMeta('Glob', {}, 'only.js', false), '1 result');
  assert.strictEqual(toolMeta('Glob', {}, 'No files found', false), '0 results');
  assert.strictEqual(toolMeta('Grep', {}, 'No matches found', false), '0 results');
});

test('toolMeta: Edit is +new −old lines, MultiEdit sums every edit, Write is all adds', () => {
  assert.strictEqual(toolMeta('Edit', { old_string: 'a', new_string: 'b\nc' }), '+2 −1');
  assert.strictEqual(toolMeta('MultiEdit', { edits: [
    { old_string: 'a\nb', new_string: 'c' }, { old_string: 'd', new_string: 'e\nf\ng' },
  ] }), '+4 −3');
  assert.strictEqual(toolMeta('Write', { content: 'x\ny\nz\n' }), '+3');
});

test('toolMeta: TodoWrite is completed/total done', () => {
  const input = { todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ] };
  assert.strictEqual(toolMeta('TodoWrite', input), '1/3 done');
});

test('toolMeta: any error is "error"; unknown tools and pending results are empty', () => {
  assert.strictEqual(toolMeta('Read', {}, 'boom', true), 'error');
  assert.strictEqual(toolMeta('Edit', { old_string: 'a', new_string: 'b' }, null, true), 'error');
  assert.strictEqual(toolMeta('WebFetch', { url: 'x' }, 'page', false), '');
  assert.strictEqual(toolMeta('Read', {}, undefined, false), '');
});

test('empty and absent inputs never throw', () => {
  for (const name of ['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'TodoWrite', 'x', undefined]) {
    for (const input of [undefined, null, {}, 'str', { edits: null, todos: 'no' }]) {
      assert.doesNotThrow(() => toolMeta(name, input, undefined, false));
      assert.doesNotThrow(() => toolMeta(name, input, '', false));
    }
  }
  assert.strictEqual(toolMeta('Edit', {}), '+0 −0');
  assert.strictEqual(toolMeta('MultiEdit', { edits: [null, {}] }), '+0 −0');
  assert.strictEqual(toolMeta('TodoWrite', undefined), '0/0 done');
});

test('todoItems: text and status as given; absent input is an empty list', () => {
  assert.deepStrictEqual(todoItems({ todos: [{ content: 'a', status: 'pending', activeForm: 'A' }] }),
    [{ text: 'a', status: 'pending' }]);
  assert.deepStrictEqual(todoItems(undefined), []);
  assert.deepStrictEqual(todoItems({ todos: 'nope' }), []);
  assert.deepStrictEqual(todoItems({ todos: [null] }), [{ text: '', status: undefined }]);
});

// P25-S05: agentTracker (D-110) — running counts for the activity line.
const agent = (id, bg) => ({ type: 'tool-use', toolUseId: id, name: 'Agent', input: bg ? { run_in_background: true } : {} });
const result = (id) => ({ type: 'tool-result', toolUseId: id, result: 'x', isError: false });
const taskDone = (id) => ({ type: 'task', phase: 'done', taskId: 't', toolUseId: id, status: 'completed' });

test('agentTracker: a foreground agent runs until its tool-result', () => {
  const t = agentTracker();
  assert.strictEqual(t.running, 0);
  t.onEvent(agent('a1'));
  t.onEvent({ type: 'tool-use', toolUseId: 'r1', name: 'Read', input: {}, parent: 'a1' });   // not an agent
  t.onEvent({ type: 'tool-use', toolUseId: 'k1', name: 'Task', input: {} });                   // Task counts too
  assert.strictEqual(t.running, 2);
  assert.strictEqual(t.background, 0);
  t.onEvent(result('r1')); t.onEvent(result('a1'));
  assert.strictEqual(t.running, 1);
  t.onEvent(result('k1'));
  assert.strictEqual(t.running, 0);
});

test('agentTracker: a background agent outlives its tool-result until its task done', () => {
  const t = agentTracker();
  t.onEvent(agent('b1', true));
  t.onEvent(result('b1'));
  t.onEvent({ type: 'result' });
  assert.strictEqual(t.running, 1);
  assert.strictEqual(t.background, 1);
  t.onEvent({ type: 'task', phase: 'started', taskId: 't', toolUseId: 'b1', description: 'd' });
  assert.strictEqual(t.running, 1);
  t.onEvent(taskDone('b1'));
  assert.strictEqual(t.running, 0);
  assert.strictEqual(t.background, 0);
});

test('agentTracker: unmatched task events and foreground task-done change nothing', () => {
  const t = agentTracker();
  t.onEvent(agent('a1'));
  t.onEvent(taskDone('nope')); t.onEvent(taskDone(null)); t.onEvent(taskDone('a1'));
  assert.strictEqual(t.running, 1);
  t.onEvent(undefined); t.onEvent({}); t.onEvent({ type: 'tool-use', toolUseId: 'x', name: 'Agent' });
  assert.strictEqual(t.running, 2);   // absent input is a foreground agent, never a throw
});

test('agentTracker: init, step-started and done reset it', () => {
  for (const reset of [{ type: 'init' }, { kind: 'step-started' }, { kind: 'done' }]) {
    const t = agentTracker();
    t.onEvent(agent('a1')); t.onEvent(agent('b1', true));
    assert.strictEqual(t.running, 2);
    t.onEvent(reset);
    assert.strictEqual(t.running, 0);
    assert.strictEqual(t.background, 0);
  }
  const a = agentTracker(), b = agentTracker();
  a.onEvent(agent('a1'));
  assert.strictEqual(b.running, 0);   // each call is a fresh tracker
});

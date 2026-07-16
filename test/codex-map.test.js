// mapCodexEvent turns real `codex exec --json` JSONL into the SAME thin UI events session.js
// emits, so the webview/Runner are engine-agnostic. Fixtures below are verbatim from a live
// S02/S04 headless run (agent_message, command_execution, turn.completed); reasoning/file_change/
// mcp_tool_call/error are the documented shapes. Stdlib only, spends no usage. (P02-S04)
const test = require('node:test');
const assert = require('node:assert');
const { mapCodexEvent, reviewNote } = require('../src/codex');

test('thread.started → init carrying the thread id (currentSessionId source)', () => {
  assert.deepStrictEqual(
    mapCodexEvent({ type: 'thread.started', thread_id: '019f5d98-7b9e' }),
    [{ type: 'init', sessionId: '019f5d98-7b9e', slashCommands: [], mcpServers: [] }]);
});

test('item.completed agent_message → assistant-text', () => {
  assert.deepStrictEqual(
    mapCodexEvent({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi there' } }),
    [{ type: 'assistant-text', text: 'hi there' }]);
});

test('item.completed reasoning → thinking', () => {
  assert.deepStrictEqual(
    mapCodexEvent({ type: 'item.completed', item: { id: 'r0', type: 'reasoning', text: 'let me think' } }),
    [{ type: 'thinking', text: 'let me think' }]);
});

test('command_execution: started → tool-use, completed(exit 0) → tool-result (not error)', () => {
  const started = { type: 'item.started',
    item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: '', exit_code: null, status: 'in_progress' } };
  assert.deepStrictEqual(mapCodexEvent(started),
    [{ type: 'tool-use', toolUseId: 'item_1', name: 'shell', input: { command: 'echo hi' } }]);

  const completed = { type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\r\n', exit_code: 0, status: 'completed' } };
  assert.deepStrictEqual(mapCodexEvent(completed),
    [{ type: 'tool-result', toolUseId: 'item_1', result: 'hi\r\n', isError: false }]);
});

test('command_execution non-zero exit flags isError', () => {
  const evt = { type: 'item.completed',
    item: { id: 'item_2', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 2, status: 'completed' } };
  assert.strictEqual(mapCodexEvent(evt)[0].isError, true);
});

test('file_change (completed) → tool-use carrying the changes', () => {
  const evt = { type: 'item.completed',
    item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.js', kind: 'modify' }], status: 'completed' } };
  assert.deepStrictEqual(mapCodexEvent(evt),
    [{ type: 'tool-use', toolUseId: 'f1', name: 'file_change', input: { changes: [{ path: 'a.js', kind: 'modify' }] } }]);
});

test('mcp_tool_call: started → tool-use (server.tool), completed(failed) → error tool-result', () => {
  const started = { type: 'item.started',
    item: { id: 'm1', type: 'mcp_tool_call', server: 'railway', tool: 'deploy', arguments: { env: 'prod' } } };
  assert.deepStrictEqual(mapCodexEvent(started),
    [{ type: 'tool-use', toolUseId: 'm1', name: 'railway.deploy', input: { env: 'prod' } }]);

  const completed = { type: 'item.completed',
    item: { id: 'm1', type: 'mcp_tool_call', server: 'railway', tool: 'deploy', status: 'failed', result: 'nope' } };
  const out = mapCodexEvent(completed);
  assert.strictEqual(out[0].type, 'tool-result');
  assert.strictEqual(out[0].isError, true);
  assert.strictEqual(out[0].result, 'nope');
});

test('turn.completed → result (step-done signal), context = input_tokens, turnTokens = input+output', () => {
  const evt = { type: 'turn.completed', usage: { input_tokens: 26442, cached_input_tokens: 22016, output_tokens: 83 } };
  assert.deepStrictEqual(mapCodexEvent(evt),
    [{ type: 'result', subtype: 'success', text: '', costUsd: null, contextTokens: 26442, turnTokens: 26525 }]);
});

test('turn.failed / error → error event', () => {
  assert.deepStrictEqual(mapCodexEvent({ type: 'turn.failed', error: { message: 'rate limited' } }),
    [{ type: 'error', message: 'rate limited' }]);
  assert.strictEqual(mapCodexEvent({ type: 'error', message: 'auth' })[0].type, 'error');
});

// ── P03-S03: auto-review escalate→retry note ─────────────────────────────────────
// The observable auto-review pattern: a `.git` command fails under the sandbox, then the SAME
// command re-runs and succeeds after the invisible review. reviewNote fires exactly on the retry.
test('reviewNote fires on the approved retry (same command re-run, fail→success)', () => {
  const st = {};
  const gitDenied = { type: 'command_execution', command: 'git commit -m x', exit_code: 1 };
  const gitOk = { type: 'command_execution', command: 'git commit -m x', exit_code: 0 };
  assert.strictEqual(reviewNote(st, gitDenied), '', 'the first failure alone is not a note');
  const note = reviewNote(st, gitOk);
  assert.match(note, /reviewed permission/);
  assert.match(note, /git commit -m x/);
  assert.match(note, /approved/);
  assert.strictEqual(st.lastFailedCmd, null, 'state cleared after the approved retry');
});

test('reviewNote stays silent for plain failures, plain successes, and command arrays', () => {
  assert.strictEqual(reviewNote({}, { type: 'command_execution', command: 'ls', exit_code: 0 }), '',
    'a lone success is not an escalation');
  // A failure followed by a DIFFERENT successful command is not an approved retry.
  const st = {};
  reviewNote(st, { type: 'command_execution', command: 'git commit', exit_code: 1 });
  assert.strictEqual(reviewNote(st, { type: 'command_execution', command: 'echo done', exit_code: 0 }), '');
  // in_progress (exit_code null) and non-command items never trigger it.
  assert.strictEqual(reviewNote({}, { type: 'command_execution', command: 'x', exit_code: null }), '');
  assert.strictEqual(reviewNote({}, { type: 'reasoning', text: 'hm' }), '');
  // command as an argv array joins for the comparison + label.
  const arr = {};
  reviewNote(arr, { type: 'command_execution', command: ['git', 'push'], exit_code: 1 });
  assert.match(reviewNote(arr, { type: 'command_execution', command: ['git', 'push'], exit_code: 0 }), /git push/);
});

test('turn.started and unknown/garbage events map to nothing', () => {
  assert.deepStrictEqual(mapCodexEvent({ type: 'turn.started' }), []);
  assert.deepStrictEqual(mapCodexEvent({ type: 'item.completed', item: { type: 'web_search' } }), []);
  assert.deepStrictEqual(mapCodexEvent(null), []);
  assert.deepStrictEqual(mapCodexEvent({}), []);
});

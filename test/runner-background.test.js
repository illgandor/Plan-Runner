// P26-S01 (CONTRACTS §Background tasks, D-115): a result with background agents still live is not a
// turn end. Each test replays a research 13 §1.2 timeline as fake-provider message sequences; (e) is
// the never-cut invariance — a foreground-only step emits exactly the events it did before S01.
// Stdlib-only; stubs the provider module like runner-adaptive/runner-pause.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner, RESUME_PROMPT } = require('../src/runner');

const OPUS = '  `[model: opus]`  `[effort: high]`';

// A temp project on P04-S35; `tags` makes it adaptive, so a wrong turn-end would escalate.
function tempProject(tags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P04-S35\n');
  fs.mkdirSync(path.join(dir, 'planning', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'planning', 'plans', 'PLAN-04-x.md'),
    `# PLAN-04\n#### [P04-S35] A step  \`[M]\`  \`[deps: —]\`  \`[owner-gate: no]\`${tags || ''}\nbody\n`);
  return { id: dir, path: dir, name: 'tmp', model: 'opus[1m]', effort: 'high', mode: 'auto', maxTurns: 50 };
}

// start/chat record their call and keep the hooks, so the test pushes messages as the SDK would.
function stubSession() {
  const keys = ['start', 'chat', 'stop', 'interrupt', 'currentSessionId', 'defaultSend'];
  const saved = Object.fromEntries(keys.map((k) => [k, session[k]]));
  const calls = [];
  let send = null;
  session.defaultSend = () => {};
  session.currentSessionId = () => 'sess-1';
  session.stop = () => calls.push({ kind: 'stop' });
  session.interrupt = () => calls.push({ kind: 'interrupt' });
  session.start = (args, hooks) => { calls.push({ kind: 'start', prompt: args.prompt, options: args.options }); send = hooks.send; };
  session.chat = (args, hooks) => { calls.push({ kind: 'chat', prompt: args.prompt }); send = hooks.send; };
  const push = (...msgs) => msgs.forEach((msg) => send('session:message', { msg }));
  return { calls, push, restore: () => Object.assign(session, saved) };
}

function runner(p) {
  const r = new Runner(p);
  r.finalizeMs = 0;
  r.retryBackoffMs = 0;
  r.now = () => 0;
  r.gitCheck = () => ({ clean: true, pushed: true, behind: false });
  r.headSha = () => 'abc1234';
  r.openDiagnostic = () => null;
  r.readLedger = () => [];
  r.ledger = [];
  r.appendLedger = (_cwd, rec) => r.ledger.push(rec);
  // The real gate pauses at the threshold on the session reading; 0.9 is the owner's setting.
  r.gate = { u: 0, isOverThreshold() { return this.u >= 0.9; }, describe: () => '' };
  r.usageGate = r.gate;
  r.log = [];
  const emit = r.emit.bind(r);
  r.emit = (name, data) => { r.log.push([name, data]); return emit(name, data); };
  return r;
}

const agent = (id) => ({ type: 'tool-use', toolUseId: id, name: 'Agent', input: { prompt: 'review' } });
const launched = (id) => ({ type: 'tool-result', toolUseId: id, result: 'Async agent launched successfully.', isError: false });
const started = (k, id) => ({ type: 'task', phase: 'started', taskId: k, toolUseId: id, description: 'critic' });
const done = (k, id) => ({ type: 'task', phase: 'done', taskId: k, toolUseId: id, status: 'completed' });
const text = (t) => ({ type: 'assistant-text', text: t });
const result = (t = '') => ({ type: 'result', text: t });
const statuses = (r) => r.log.filter(([n]) => n === 'status').map(([, d]) => d);

test('(a) P04-S35: four background reviewers → waiting, hand-backs spend usage → paused at 0.9, resumed on reset', () => {
  const s = stubSession();
  try {
    const r = runner(tempProject('  `[model: fable]`  `[effort: high]`')); // P04-S35 ran at the top tier
    r.start();
    // 23:38:21–44 four Agent calls; the CLI runs them in the background (no run_in_background input).
    for (const i of [1, 2, 3, 4]) s.push(agent(`a${i}`), started(`k${i}`, `a${i}`), launched(`a${i}`));
    s.push({ type: 'background-tasks', taskIds: ['k1', 'k2', 'k3', 'k4'] });
    s.push(text('Review gate is running: four fresh-context reviewers …'), result('Review gate is running'));  // 23:39:04
    assert.strictEqual(r.needsYou, false, 'a clean result with agents live is not needs-you');
    assert.strictEqual(r._turnLive, true, 'the step stays live');
    assert.deepStrictEqual(statuses(r).at(-1), { state: 'running', step: 'P04-S35',
      detail: 'P04-S35: waiting on 4 background agent(s)' });
    // 23:41:06 an agent hands back → a new turn in the same live session, judged again.
    s.push(done('k1', 'a1'), { type: 'background-tasks', taskIds: ['k2', 'k3', 'k4'] },
      { type: 'init', sessionId: 'sess-1' }, text('Critic 1 is back; waiting on the rest.'), result());
    assert.strictEqual(r.needsYou, false);
    assert.strictEqual(statuses(r).at(-1).detail, 'P04-S35: waiting on 3 background agent(s)');
    // 23:42:09 allowed_warning 0.91 → the gate now pauses (before S01 it was blind).
    r.gate.u = 0.91; r.onUsageUpdate();
    assert.strictEqual(r.paused, true, 'paused at the threshold');
    assert.strictEqual(s.calls.filter((c) => c.kind === 'interrupt').length, 1, 'one interrupt');
    assert.strictEqual(r.log.filter(([n]) => n === 'paused').length, 1);
    // The interrupt also stops the background agents (probe) — their stopped notices land while paused.
    s.push({ type: 'background-tasks', taskIds: [] }, result());
    assert.strictEqual(r.paused, true, 'a turn end while paused is dropped, as before');
    // 03:00 the window resets → the gate releases and the same session resumes.
    r.gate.u = 0.05; r.onUsageUpdate();
    const starts = s.calls.filter((c) => c.kind === 'start');
    assert.strictEqual(starts.length, 2);
    assert.strictEqual(starts[1].prompt, RESUME_PROMPT);
    assert.strictEqual(starts[1].options.resume, 'sess-1', 'resumed the captured session');
    assert.strictEqual(r.log.filter(([n]) => n === 'resumed').length, 1);
    assert.strictEqual(r.ledger.filter((x) => x.kind === 'escalation').length, 0, 'never escalated');
  } finally { s.restore(); }
});

test('(b) a clean result with tasks live never escalates; the last hand-back is judged as today', () => {
  const s = stubSession();
  try {
    const r = runner(tempProject(OPUS));
    r.start();
    s.push(agent('a1'), launched('a1'), { type: 'background-tasks', taskIds: ['k1'] },
      text('Waiting on the round-2 critic before commit'), result());           // P04-S32 04:12:33
    assert.strictEqual(r.ledger.filter((x) => x.kind === 'escalation').length, 0, 'no escalation');
    assert.strictEqual(s.calls.filter((c) => c.kind === 'stop').length, 0, 'the critic is not killed');
    assert.strictEqual(s.calls.filter((c) => c.kind === 'start').length, 1, 'no restart on a new tier');
    assert.strictEqual(r.needsYou, false);
    // The critic hands back and the set empties; that turn ends without advancing → today's path.
    s.push(done('k1', 'a1'), { type: 'background-tasks', taskIds: [] }, text('Critic clean.'), result());
    assert.strictEqual(r.ledger.filter((x) => x.kind === 'escalation').length, 1, 'now it is judged as today');
  } finally { s.restore(); }
});

test('(c) P04-S32: the flag was cleared, later activity re-arms the gate → paused at 0.9', () => {
  const s = stubSession();
  try {
    const r = runner(tempProject());
    r.start();
    s.push(text('Waiting on the critic.'), result());                         // a missed set → needs-you
    assert.strictEqual(r.needsYou, true);
    assert.strictEqual(r._turnLive, false, 'the flag is cleared');
    r.gate.u = 0.85; r.onUsageUpdate();
    assert.strictEqual(r.paused, false, 'under the threshold, nothing to do');
    // 04:12:39 → the session keeps working with no new prompt from the runner.
    s.push({ type: 'tool-use', toolUseId: 't9', name: 'Edit', input: {} });
    assert.strictEqual(r._turnLive, true, 'the safety net re-arms the gate');
    assert.strictEqual(r.needsYou, false, 'and lifts the needs-you');
    assert.deepStrictEqual(statuses(r).at(-1), { state: 'running', step: 'P04-S35', detail: 'P04-S35: working again' });
    r.gate.u = 0.90; r.onUsageUpdate();                                         // 04:13:57
    assert.strictEqual(r.paused, true, 'paused at 0.9');
    assert.strictEqual(s.calls.filter((c) => c.kind === 'interrupt').length, 1);
  } finally { s.restore(); }
});

test('(d) the idle cap ends the wait; any message restarts it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const s = stubSession();
  try {
    const r = runner(tempProject());
    r.bgIdleMs = 1000;
    r.start();
    s.push(agent('a1'), started('k1', 'a1'), launched('a1'), result());
    assert.strictEqual(statuses(r).at(-1).detail, 'P04-S35: waiting on 1 background agent(s)');
    t.mock.timers.tick(999);
    s.push({ type: 'tool-use', toolUseId: 's1', name: 'Bash', input: {}, parent: 'a1' }); // the agent works
    t.mock.timers.tick(999);
    assert.strictEqual(r.needsYou, false, 'a message restarted the cap');
    t.mock.timers.tick(1);
    assert.strictEqual(r.needsYou, true, 'silence for the full cap → judged as today (needs-you)');
    assert.strictEqual(r._turnLive, false);
    assert.deepStrictEqual(statuses(r).at(-1), { state: 'needs-you', step: 'P04-S35',
      detail: 'P04-S35: waiting on you — answer in the panel' });
  } finally { s.restore(); }
});

test('(e) a foreground-only step emits exactly the pre-S01 event sequence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const s = stubSession();
  try {
    const p = tempProject();
    const r = runner(p);
    r.start();
    // A foreground agent: its task events bracket its result, so nothing is left live at the end.
    s.push({ type: 'init', sessionId: 'sess-1' }, agent('a1'), started('k1', 'a1'),
      { type: 'tool-use', toolUseId: 's1', name: 'Read', input: {}, parent: 'a1' },
      { type: 'tool-result', toolUseId: 's1', result: 'x', isError: false, parent: 'a1' },
      done('k1', 'a1'), { type: 'tool-result', toolUseId: 'a1', result: 'ok', isError: false },
      text('Which option?'), result('Which option?'));
    r.answer('the first');
    fs.writeFileSync(path.join(p.path, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: none\n');
    s.push(text('Done.'), result('Done.'));
    t.mock.timers.tick(0);
    // Recorded on 693c151 (before S01) with this same script.
    assert.deepStrictEqual(r.log, [
      ['status', { state: 'running', step: 'P04-S35', detail: 'Running P04-S35' }],
      ['step-started', { step: 'P04-S35' }],
      ['status', { state: 'needs-you', step: 'P04-S35', detail: 'P04-S35: waiting on you — answer in the panel' }],
      ['status', { state: 'running', step: 'P04-S35', detail: 'Continuing P04-S35…' }],
      ['step-done', { from: 'P04-S35', to: 'none' }],
      ['status', { state: 'done', detail: 'Project complete (none)' }],
      ['done', { state: 'done', detail: 'Project complete (none)', startedAtMs: 0 }],
    ]);
    assert.deepStrictEqual(s.calls.map((c) => c.kind), ['start', 'chat', 'stop']);
  } finally { s.restore(); }
});

// Adaptive effort in the runner (P24-S04, CONTRACTS §Adaptive effort, D-103/D-106/D-107). A step
// heading carrying BOTH tags runs every session of that step — start, retry, resume, answer — on its
// resolved model/effort, and the usage gate is asked about that model. An untagged step is today's
// behaviour exactly: that invariance is the never-cut test, so it runs FIRST, on both engines.
// Stdlib-only; stubs the provider module like runner-answer/runner-retry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const codex = require('../src/codex');
const { Runner } = require('../src/runner');

const HEAD = '#### [P05-S03] A step  `[M]`  `[deps: —]`  `[owner-gate: no]`';

function tempProject(engine, tags, ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P05-S03\n');
  fs.mkdirSync(path.join(dir, 'planning', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'planning', 'plans', 'PLAN-05-x.md'), `# PLAN-05\n${HEAD}${tags || ''}\nbody\n`);
  if (ledger) {
    fs.mkdirSync(path.join(dir, '.plan-runner'));
    fs.writeFileSync(path.join(dir, '.plan-runner', 'runs.jsonl'), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const model = engine === 'codex' ? 'gpt-5.6-sol' : 'opus[1m]';
  return { id: dir, path: dir, name: 'tmp', engine, model, effort: 'high', mode: 'auto', maxTurns: 50 };
}

// Stub both providers' lifecycle. start() follows `script` (one entry per call: 'error' ends the turn
// errored, 'live' leaves it streaming, 'idle' ends it cleanly with the pointer unchanged); chat()
// records and stays live. Every options object either receives is captured in call order.
function stubProviders(script) {
  const keys = ['start', 'chat', 'stop', 'interrupt', 'currentSessionId', 'defaultSend'];
  const saved = [session, codex].map((m) => Object.fromEntries(keys.map((k) => [k, m[k]])));
  const calls = [];
  for (const mod of [session, codex]) {
    mod.defaultSend = () => {};
    mod.interrupt = () => {};
    mod.stop = () => {};
    mod.currentSessionId = () => 'sess-1';
    mod.start = (args, hooks) => {
      calls.push({ kind: 'start', prompt: args.prompt, options: args.options });
      const what = script.shift() || 'live';
      if (what === 'error') hooks.send('session:message', { msg: { type: 'error' } });
      if (what === 'idle') hooks.send('session:message', { msg: { type: 'result' } });
      return {};
    };
    mod.chat = (args) => { calls.push({ kind: 'chat', options: args.options }); };
  }
  return { calls, restore: () => [session, codex].forEach((m, i) => Object.assign(m, saved[i])) };
}

function runner(p) {
  const r = new Runner(p);
  r.finalizeMs = 0;
  r.retryBackoffMs = 0;
  r.gitCheck = () => ({ clean: true, pushed: true, behind: false });
  r.headSha = () => 'abc1234';
  r.ledger = [];
  r.appendLedger = (_cwd, rec) => r.ledger.push(rec);
  r.gateModels = [];
  r.usageGate = { isOverThreshold: (m) => { r.gateModels.push(m); return false; },
    describe: (m) => { r.gateModels.push(m); return ''; } };
  return r;
}

// start → errored → retry (live) → pause → resume (clean end, pointer unchanged = needs-you) → answer.
function driveEveryPath(t, p) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const stub = stubProviders(['error', 'live', 'idle']);
  try {
    const r = runner(p);
    const statuses = [];
    r.on('status', (s) => statuses.push(s));
    r.start();
    t.mock.timers.tick(0);        // the retry's backoff (0ms)
    r.onUsageUpdate();            // a poll mid-turn asks the gate too
    r.pauseManual();
    r.resumeManual();
    assert.ok(r.needsYou, 'the resumed turn ended with the pointer unchanged → needs-you');
    r.answer('carry on');
    return { r, calls: stub.calls, statuses };
  } finally { stub.restore(); }
}

const today = (p, extra) => ({ model: p.model, effort: p.effort, permissionMode: p.mode, maxTurns: p.maxTurns, ...extra });

for (const engine of ['claude', 'codex']) {
  test(`untagged (${engine}): every session's options and the gate argument are today's, exactly`, (t) => {
    const p = tempProject(engine);
    const { r, calls, statuses } = driveEveryPath(t, p);
    assert.deepEqual(calls.map((c) => c.kind), ['start', 'start', 'start', 'chat'], 'start, retry, resume, answer');
    assert.deepEqual(calls[0].options, today(p), 'start');
    assert.deepEqual(calls[1].options, today(p), 'retry');
    assert.deepEqual(calls[2].options, today(p, { resume: 'sess-1' }), 'resume');
    assert.deepEqual(calls[3].options, today(p, { resume: 'sess-1' }), 'answer');
    assert.ok(r.gateModels.length >= 2 && r.gateModels.every((m) => m === p.model), 'gate asked about project.model');
    assert.equal(r.gateModel(), p.model);
    assert.ok(statuses.some((s) => s.detail === 'Running P05-S03'), 'status detail unchanged');
  });

  test(`a half-tagged heading (${engine}) is untagged — the dropdown runs it`, (t) => {
    const p = tempProject(engine, '  `[model: sonnet]`');
    const { calls } = driveEveryPath(t, p);
    assert.deepEqual(calls[0].options, today(p));
  });
}

const TAGGED = [
  { engine: 'claude', tags: '  `[model: sonnet]`  `[effort: medium]`', model: 'sonnet', effort: 'medium' },
  { engine: 'codex', tags: '  `[model: sonnet]`  `[effort: medium]`', model: 'gpt-5.6-terra', effort: 'medium' },
  { engine: 'codex', tags: '  `[model: haiku]`  `[effort: max]`', model: 'gpt-5.6-luna', effort: 'xhigh' },
];
for (const c of TAGGED) {
  test(`tagged (${c.engine}, ${c.model}/${c.effort}): start, retry, resume and answer all carry it`, (t) => {
    const p = tempProject(c.engine, c.tags);
    const { r, calls, statuses } = driveEveryPath(t, p);
    const want = { model: c.model, effort: c.effort, permissionMode: p.mode, maxTurns: p.maxTurns };
    assert.deepEqual(calls.map((x) => x.options), [want, want, { ...want, resume: 'sess-1' }, { ...want, resume: 'sess-1' }]);
    assert.ok(r.gateModels.length >= 2 && r.gateModels.every((m) => m === c.model), 'gate asked about the step\'s model');
    assert.equal(r.gateModel(), c.model, 'postUsage reads this while the run is live');
    const tier = c.tags.match(/model: (\w+)/)[1];
    assert.ok(statuses.some((s) => s.detail === `Running P05-S03 · ${tier} / ${c.effort} (adaptive)`), 'status names the tier');
  });
}

test('a restart starts at the tier the ledger says it already reached (effort raised to high)', (t) => {
  const p = tempProject('claude', '  `[model: haiku]`  `[effort: low]`',
    [{ kind: 'escalation', stepId: 'P05-S03', from: 'haiku', to: 'opus', reason: 'errored', at: 'x' }]);
  const { calls } = driveEveryPath(t, p);
  assert.equal(calls[0].options.model, 'opus[1m]');
  assert.equal(calls[0].options.effort, 'high');
});

test('the done record carries the model it ran on plus adaptive/escalations; PLAN COMPLETE uses the dropdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('claude', '  `[model: sonnet]`  `[effort: low]`');
  const stub = stubProviders([]);
  // The step's session advances the pointer to PLAN COMPLETE; master-plan's ends cleanly → done.
  let n = 0;
  session.start = (args, hooks) => {
    stub.calls.push({ kind: 'start', options: args.options });
    if (n++ === 0) fs.writeFileSync(path.join(p.path, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: PLAN COMPLETE\n');
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  try {
    const r = runner(p);
    r.start();
    for (let i = 0; i < 5; i++) t.mock.timers.tick(0);
    const done = r.ledger.find((x) => x.outcome === 'done');
    assert.equal(done.model, 'sonnet');
    assert.equal(done.effort, 'low');
    assert.equal(done.adaptive, true);
    assert.equal(done.escalations, 0, 'escalation is S05');
    assert.equal(stub.calls.length, 2, 'the step, then master-plan');
    assert.deepEqual(stub.calls[1].options, today(p), 'master-plan runs on the dropdown');
    assert.equal(r.gateModel(), p.model, 'cleared once the run finished');
  } finally { stub.restore(); }
});

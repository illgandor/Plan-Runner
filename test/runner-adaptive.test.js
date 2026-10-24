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

function tempProject(engine, tags, ledger, head = HEAD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P05-S03\n');
  fs.mkdirSync(path.join(dir, 'planning', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'planning', 'plans', 'PLAN-05-x.md'), `# PLAN-05\n${head}${tags || ''}\nbody\n`);
  if (ledger) {
    fs.mkdirSync(path.join(dir, '.plan-runner'));
    fs.writeFileSync(path.join(dir, '.plan-runner', 'runs.jsonl'), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const model = engine === 'codex' ? 'gpt-5.6-sol' : 'opus[1m]';
  return { id: dir, path: dir, name: 'tmp', engine, model, effort: 'high', mode: 'auto', maxTurns: 50 };
}

// Stub both providers' lifecycle. start() follows `script` (one entry per call: 'error' ends the turn
// errored, 'live' leaves it streaming, 'idle' ends it cleanly with the pointer unchanged, 'owner' ends
// it cleanly on a `NEEDS OWNER:` line — in the result text on Claude, in the last assistant text on
// Codex, whose result carries none — and 'advance' moves NEXT on, then ends cleanly); chat() records
// and stays live. Every options object either receives is captured in call order.
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
      if (what === 'idle') hooks.send('session:message', { msg: { type: 'result', text: '' } });
      if (what === 'owner') {
        const line = 'Stopped here.\nNEEDS OWNER: a credential only the owner has';
        hooks.send('session:message', { msg: { type: 'assistant-text', text: mod === codex ? line : 'Stopped here.' } });
        hooks.send('session:message', { msg: { type: 'result', text: mod === codex ? '' : line } });
      }
      if (what === 'advance') {
        fs.writeFileSync(path.join(args.cwd, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P05-S04\n');
        hooks.send('session:message', { msg: { type: 'result', text: '' } });
      }
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
  r.openDiagnostic = () => null;
  r.ledger = [];
  r.appendLedger = (_cwd, rec) => r.ledger.push(rec);
  r.gateModels = [];
  r.usageGate = { isOverThreshold: (m) => { r.gateModels.push(m); return false; },
    describe: (m) => { r.gateModels.push(m); return ''; } };
  return r;
}

// start → errored → retry (live) → pause → resume (ends on NEEDS OWNER = needs-you) → answer. The
// resume ends on NEEDS OWNER so a tagged step stops there too — a bare clean end would step it up (S05).
function driveEveryPath(t, p) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const stub = stubProviders(['error', 'live', 'owner']);
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

// ---- P24-S05: step up one tier before stopping (D-105, §Adaptive effort "The three triggers") ----

// Run `script` to rest (every retry backoff is 0ms under mocked timers) and return what happened.
function drive(t, p, script) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const stub = stubProviders(script);
  try {
    const r = runner(p);
    const statuses = [];
    r.on('status', (s) => statuses.push(s));
    r.start();
    for (let i = 0; i < 40; i++) t.mock.timers.tick(0);
    const ups = r.ledger.filter((x) => x.kind === 'escalation');
    return { r, calls: stub.calls, statuses, ups };
  } finally { stub.restore(); t.mock.timers.reset(); }
}

const SONNET = '  `[model: sonnet]`  `[effort: medium]`';
const OPUS = { claude: 'opus[1m]', codex: 'gpt-5.6-sol' };
const { STEP_PROMPT } = require('../src/constants');
const { ESCALATE_PROMPT } = require('../src/adaptive');
const ERR3 = ['error', 'error', 'error'];
const hops = (ups) => ups.map(({ from, to, reason }) => [from, to, reason]);

for (const engine of ['claude', 'codex']) {
  test(`errored (${engine}): a spent retry budget steps up one tier into a FRESH session, budget reset`, (t) => {
    const { r, calls, statuses, ups } = drive(t, tempProject(engine, SONNET), [...ERR3, 'live']);
    assert.equal(calls.length, 4, 'start + 2 retries on sonnet, then one fresh start on opus');
    assert.equal(calls[3].options.model, OPUS[engine]);
    assert.equal(calls[3].options.effort, 'high', 'effort raised to at least high');
    assert.equal(calls[3].options.resume, undefined, 'fresh, not resumed');
    assert.ok(calls[3].prompt.startsWith(STEP_PROMPT), 'the normal step prompt');
    assert.deepEqual(hops(ups), [['sonnet', 'opus', 'errored']]);
    assert.equal(r._retries, 0, 'the retry budget resets on the new tier');
    assert.equal(r.gateModel(), OPUS[engine], 'the gate sees the new model at once');
    assert.ok(statuses.some((s) => s.detail === 'P05-S03 did not finish on sonnet — stepping up to opus'));
    assert.equal(r.needsYou, false);
  });

  test(`unfinished (${engine}): a clean end with the pointer unchanged RESUMES the session one tier up`, (t) => {
    const { r, calls, ups } = drive(t, tempProject(engine, SONNET), ['idle', 'live']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].options, { model: OPUS[engine], effort: 'high', permissionMode: 'auto',
      maxTurns: 50, resume: 'sess-1' }, 'same session id, new tier');
    assert.equal(calls[1].prompt, ESCALATE_PROMPT);
    assert.deepEqual(hops(ups), [['sonnet', 'opus', 'unfinished']]);
    assert.equal(r.needsYou, false);
  });

  test(`NEEDS OWNER (${engine}): a turn ending on it is never escalated — needs-you as today`, (t) => {
    const { r, calls, ups } = drive(t, tempProject(engine, SONNET), ['owner']);
    assert.equal(calls.length, 1);
    assert.equal(ups.length, 0);
    assert.ok(r.needsYou);
  });

  test(`stuck (${engine}): diagnosis firing at step start steps up once before the session starts`, (t) => {
    const seen = [1, 2, 3].map(() => ({ kind: 'step-attempt', stepId: 'P05-S03', head: 'abc1234', at: 'x' }));
    const { calls, statuses, ups } = drive(t, tempProject(engine, SONNET, seen), ['live']);
    assert.equal(calls.length, 1, 'no session ever ran on the old tier');
    assert.equal(calls[0].options.model, OPUS[engine]);
    assert.deepEqual(hops(ups), [['sonnet', 'opus', 'stuck']]);
    assert.equal(statuses[statuses.length - 1].state, 'diagnosing', 'diagnosis mode still owns the state');
  });

  test(`owner-gated (${engine}): a tagged [owner-gate: yes] step never steps up`, (t) => {
    const head = HEAD.replace('owner-gate: no', 'owner-gate: yes');
    const { r, calls, ups } = drive(t, tempProject(engine, SONNET, null, head), [...ERR3]);
    assert.equal(calls.length, 3);
    assert.equal(ups.length, 0);
    assert.ok(r.needsYou);
  });

  test(`untagged (${engine}): every failure path is exactly as before — no escalation, no record`, (t) => {
    const p = tempProject(engine);
    const err = drive(t, p, [...ERR3]);
    assert.equal(err.calls.length, 3);
    assert.equal(err.statuses[err.statuses.length - 1].detail,
      'P05-S03: errored (retried 2×) — answer in the panel to continue, or Stop');
    const idle = drive(t, tempProject(engine), ['idle']);
    assert.equal(idle.calls.length, 1);
    assert.equal(idle.statuses[idle.statuses.length - 1].detail, 'P05-S03: waiting on you — answer in the panel');
    for (const run of [err, idle]) {
      assert.equal(run.ups.length, 0);
      assert.ok(run.calls.every((c) => c.options.model === p.model));
    }
  });
}

test('the Codex ladder stops at opus: sonnet → sol once, then needs-you', (t) => {
  const { r, calls, ups } = drive(t, tempProject('codex', SONNET), [...ERR3, ...ERR3]);
  assert.equal(calls.length, 6);
  assert.deepEqual(ups.map((u) => u.to), ['opus']);
  assert.ok(r.needsYou);
});

test('the Claude ladder climbs one tier per trigger to fable, then needs-you exactly as before', (t) => {
  const { r, calls, statuses, ups } = drive(t, tempProject('claude', SONNET), [...ERR3, ...ERR3, ...ERR3]);
  assert.deepEqual(calls.map((c) => c.options.model), [...Array(3).fill('sonnet'), ...Array(3).fill('opus[1m]'),
    ...Array(3).fill('fable')]);
  assert.deepEqual(ups.map((u) => `${u.from}>${u.to}`), ['sonnet>opus', 'opus>fable']);
  assert.ok(r.needsYou);
  assert.equal(statuses[statuses.length - 1].detail,
    'P05-S03: errored (retried 2×) — answer in the panel to continue, or Stop');
});

test('top tier, unfinished: a tagged fable step that stops clean is needs-you, no record', (t) => {
  const { r, ups } = drive(t, tempProject('claude', '  `[model: fable]`  `[effort: high]`'), ['idle']);
  assert.equal(ups.length, 0);
  assert.ok(r.needsYou);
});

test('the done record names the tier it finished on and counts the escalation', (t) => {
  const { r } = drive(t, tempProject('claude', SONNET), ['idle', 'advance', 'live']);
  const done = r.ledger.find((x) => x.outcome === 'done');
  assert.equal(done.model, 'opus[1m]');
  assert.equal(done.effort, 'high');
  assert.equal(done.adaptive, true);
  assert.equal(done.escalations, 1);
});

test('a restart resumes at reachedTier and still counts the escalations already in the ledger', (t) => {
  const prior = [{ kind: 'escalation', stepId: 'P05-S03', from: 'sonnet', to: 'opus', reason: 'unfinished', at: 'x' }];
  const { r, calls } = drive(t, tempProject('claude', SONNET, prior), ['advance', 'live']);
  assert.equal(calls[0].options.model, 'opus[1m]');
  assert.equal(r.ledger.find((x) => x.outcome === 'done').escalations, 1);
});

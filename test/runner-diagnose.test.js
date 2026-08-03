// P22-S01 — stuckSignal(): the diagnosis trigger, read from the run ledger (D-094).
// Pure predicate, so every case is a fixture: no run, no git, no session. The three triggers each
// return their OWN reason, and anything the ledger can't answer reads as "not stuck" (D-017).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stuckSignal, STUCK_REPEATS } = require('../src/runner');

const attempt = (stepId, head) => ({ kind: 'step-attempt', stepId, head });
const gateFail = (stepId, gate) => ({ kind: 'gate-fail', stepId, gate });

test('the same focused gate failing twice is its own reason', () => {
  const recs = [gateFail('S1', 'unit'), gateFail('S1', 'build'), gateFail('S1', 'unit')];
  assert.equal(stuckSignal(recs, 'S1').reason, 'gate-failed-twice');
  assert.match(stuckSignal(recs, 'S1').detail, /unit/);
  // two DIFFERENT gates failing once each is not the trigger — it's ordinary iteration
  assert.equal(stuckSignal([gateFail('S1', 'unit'), gateFail('S1', 'build')], 'S1'), null);
  // another step's failures are not this step's
  assert.equal(stuckSignal([gateFail('S2', 'unit'), gateFail('S2', 'unit')], 'S1'), null);
});

test('a third start of the same step is its own reason', () => {
  const two = [attempt('S1', 'aaa'), attempt('S1', 'aaa')];
  assert.equal(stuckSignal(two, 'S1'), null, 'a retry is normal; two starts is under the budget');
  const three = [...two, attempt('S1', 'aaa')];
  assert.equal(stuckSignal(three, 'S1').reason, 'restart-loop');
  assert.match(stuckSignal(three, 'S1').detail, /3×/);
});

test('committing for a step then rolling back is its own reason', () => {
  // HEAD left aaa for bbb (the step committed), then came back to aaa — that work is gone.
  const recs = [attempt('S1', 'aaa'), attempt('S1', 'bbb'), attempt('S1', 'aaa')];
  const sig = stuckSignal(recs, 'S1');
  assert.equal(sig.reason, 'commits-reverted', 'the specific reason wins over the restart count');
  assert.match(sig.detail, /aaa/);
  // moving FORWARD through new commits is progress, not a revert
  assert.equal(stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'bbb')], 'S1'), null);
});

test('the three reasons are distinct', () => {
  const reasons = [
    stuckSignal([gateFail('S1', 'unit'), gateFail('S1', 'unit')], 'S1').reason,
    stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'aaa'), attempt('S1', 'aaa')], 'S1').reason,
    stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'bbb'), attempt('S1', 'aaa')], 'S1').reason,
  ];
  assert.equal(new Set(reasons).size, 3);
});

test('absent, empty and malformed ledger data are "not stuck", and throw nothing', () => {
  for (const bad of [undefined, null, [], 'not an array', 42, {}, [null], [undefined], ['line'],
    [{ }], [{ kind: 'step-attempt' }], [{ kind: 'gate-fail', stepId: 'S1' }],
    [{ kind: 'usage-event', stepId: 'S1' }], [{ stepId: 'S1', outcome: 'done' }]]) {
    assert.equal(stuckSignal(bad, 'S1'), null, `${JSON.stringify(bad)} → null`);
  }
  assert.equal(stuckSignal([attempt('S1', 'aaa')], ''), null, 'no step id → null');
  assert.equal(stuckSignal([attempt('S1', 'aaa')], undefined), null);
});

test('the threshold is one named constant that both counting triggers read', () => {
  assert.equal(typeof STUCK_REPEATS, 'number');
  const gates = Array.from({ length: STUCK_REPEATS }, () => gateFail('S1', 'unit'));
  assert.equal(stuckSignal(gates.slice(0, -1), 'S1'), null, 'one under the threshold: not stuck');
  assert.equal(stuckSignal(gates, 'S1').reason, 'gate-failed-twice');
  const starts = Array.from({ length: STUCK_REPEATS + 1 }, () => attempt('S1', 'aaa'));
  assert.equal(stuckSignal(starts.slice(0, -1), 'S1'), null);
  assert.equal(stuckSignal(starts, 'S1').reason, 'restart-loop');
});

// ---- P22-S02 — the `diagnosing` state and the artifact it opens ----------------------------
// The trigger is now wired: every step start records an attempt, then asks the ledger. A fired
// signal changes the emitted STATE and opens an artifact — and nothing else: the step still runs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const session = require('../src/session');
const { Runner, appendLedger, openDiagnostic, DIAGNOSIS_SECTIONS } = require('../src/runner');

function tempProject(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-diag-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: 'opus', effort: 'high', mode: 'auto' };
}
// On start, advance the pointer to `to` and end the turn — the same stub runner-ledger uses.
function fakeSession(dir, to) {
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {}; session.interrupt = () => {};
  session.currentSessionId = () => 'sess'; session.stop = () => {};
  session.start = (args, hooks) => {
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  return () => { for (const k of Object.keys(orig)) session[k] = orig[k]; };
}
function runner(p, head = 'aaa1111') {
  const r = new Runner(p);
  r.finalizeMs = 0;
  r.gitCheck = () => ({ clean: true, pushed: true });
  r.headSha = () => head;
  return r;
}

test('an unfired signal leaves the state exactly as it is today', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const restore = fakeSession(p.path, 'none');
  try {
    const r = runner(p);
    const states = [];
    r.on('status', (s) => states.push(s.state));
    r.start(); t.mock.timers.tick(0);
    assert.ok(states.includes('running'), 'a first attempt still reads as running');
    assert.ok(!states.includes('diagnosing'), 'nothing to be stuck about yet');
    assert.equal(fs.existsSync(path.join(p.path, '.plan-runner', 'diagnostics')), false);
  } finally { restore(); }
});

test('a fired signal emits diagnosing and opens the artifact', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  // two prior starts on disk; this run's own attempt is the third → restart-loop
  appendLedger(p.path, { kind: 'step-attempt', stepId: 'S1', head: 'aaa1111' });
  appendLedger(p.path, { kind: 'step-attempt', stepId: 'S1', head: 'bbb2222' });
  const restore = fakeSession(p.path, 'none');
  try {
    const r = runner(p, 'ccc3333');
    const states = [];
    r.on('status', (s) => states.push(s.state));
    r.start(); t.mock.timers.tick(0);

    assert.ok(states.includes('diagnosing'), 'the stuck step announces the method change');
    assert.ok(!states.includes('running'), 'and never as a plain running step');
    const md = fs.readFileSync(path.join(p.path, '.plan-runner', 'diagnostics', 'S1.md'), 'utf8');
    assert.match(md, /# Diagnosis — S1/);
    assert.match(md, /restart-loop/, 'the named reason');
    assert.match(md, /ccc3333/, 'the base commit');
    for (const h of DIAGNOSIS_SECTIONS) assert.ok(md.includes(`## ${h}`), `heading: ${h}`);
    // opened EMPTY: the runner writes no findings, so no section has a body
    assert.equal(md.split('\n').filter((l) => l.startsWith('## ')).length, DIAGNOSIS_SECTIONS.length);
    // the self-ignoring dir covers diagnostics/ too — one rule, no second one added
    assert.equal(fs.readFileSync(path.join(p.path, '.plan-runner', '.gitignore'), 'utf8'), '*\n');
    assert.equal(fs.existsSync(path.join(p.path, '.plan-runner', 'diagnostics', '.gitignore')), false);
  } finally { restore(); }
});

test('a failed artifact write is swallowed — the step still runs and the loop still finishes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  appendLedger(p.path, { kind: 'step-attempt', stepId: 'S1', head: 'aaa1111' });
  appendLedger(p.path, { kind: 'step-attempt', stepId: 'S1', head: 'bbb2222' });
  // a FILE where the diagnostics dir must go: the real writer's mkdir fails for real
  fs.writeFileSync(path.join(p.path, '.plan-runner', 'diagnostics'), 'not a dir');
  const restore = fakeSession(p.path, 'none');
  try {
    const r = runner(p, 'ccc3333');
    let done = null;
    r.on('done', (d) => { done = d; });
    assert.doesNotThrow(() => { r.start(); t.mock.timers.tick(0); });
    assert.ok(done, 'the run reached its end despite the failed write');
  } finally { restore(); }
  assert.equal(openDiagnostic(p.path, { stepId: 'S1', reason: 'x' }), null, 'and it reports null, not a throw');
});

test('the panel renders diagnosing as its own state, not as running', () => {
  const js = fs.readFileSync(require.resolve('../src/webview/chat.js'), 'utf8');
  const css = fs.readFileSync(require.resolve('../src/webview/chat.css'), 'utf8');
  assert.match(js, /d\.state === 'diagnosing' \? ' diagnosing'/, 'its own status class');
  assert.match(css, /\.status\.diagnosing\s*\{/, 'and its own look');
  assert.match(js, /d\.state === 'diagnosing'[\s\S]{0,40}reflect\(\)/,
    'still counted as a LIVE run, so Stop/Pause stay visible');
});

test('the runner calls stuckSignal exactly once — its definition plus the one wired call site', () => {
  const src = fs.readFileSync(require.resolve('../src/runner.js'), 'utf8');
  assert.equal((src.match(/stuckSignal\(/g) || []).length, 2, 'definition + _diagnose, no third caller');
  assert.match(src, /_diagnose\(stepId\)/);
});

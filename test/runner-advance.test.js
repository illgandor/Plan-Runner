// Plan-boundary auto-advance (P02-S08): when PROGRESS.md's pointer reads "PLAN COMPLETE" the
// runner runs the master-plan skill ONCE (instead of stopping for the owner), then re-reads
// the pointer and continues to the next plan's first step or finishes. "none" always finishes
// directly — no master-plan run. Guard: a master-plan run that leaves the pointer unchanged
// finishes rather than looping. Stdlib-only; stubs the session provider like runner-finalize.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner } = require('../src/runner');
const { MASTER_PLAN_PROMPT, STEP_PROMPT } = require('../src/constants');

function tempProject(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto' };
}

// Fake session: each start records the prompt and calls script(prompt) → the new pointer to
// write (null = leave unchanged), then ends the turn with a `result`. Returns spies + restore.
function fakeScripted(dir, script) {
  const calls = { prompts: [], start: 0, stop: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => { calls.stop++; };
  session.start = (args, hooks) => {
    calls.start++;
    calls.prompts.push(args.prompt);
    const to = script(args.prompt);
    if (to != null) fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  return { calls, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('PLAN COMPLETE → runs master-plan once, then continues into the next plan\'s step', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('PLAN COMPLETE');
  // master-plan activates the queued plan (→ S1); S1 then finishes the project (→ none).
  const { calls, restore } = fakeScripted(p.path, (prompt) =>
    prompt === MASTER_PLAN_PROMPT ? 'S1' : 'none');
  try {
    const r = new Runner(p);
    r.finalizeMs = 0; // straight to the git guard on the step turn-end
    r.gitCheck = () => ({ clean: true, pushed: true });
    let done = null;
    r.on('done', (d) => { done = d; });

    r.start();
    t.mock.timers.tick(0); // drain the setImmediate chain (master-plan end → S1 → finish)

    assert.deepEqual(calls.prompts, [MASTER_PLAN_PROMPT, STEP_PROMPT], 'master-plan once, then the step');
    assert.equal(done && done.state, 'done', 'finished the project');
  } finally { restore(); }
});

test('master-plan leaves pointer unchanged → finishes, does NOT run master-plan twice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('PLAN COMPLETE');
  const { calls, restore } = fakeScripted(p.path, () => null); // nothing changes the pointer
  try {
    const r = new Runner(p);
    let done = null;
    r.on('done', (d) => { done = d; });

    r.start();
    t.mock.timers.tick(0);

    assert.deepEqual(calls.prompts, [MASTER_PLAN_PROMPT], 'exactly one master-plan run, no loop');
    assert.equal(done && done.state, 'done', 'finished rather than re-running');
  } finally { restore(); }
});

test('errored PLAN COMPLETE close-out → retries then needs-you, never "done" (P09-S03)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('PLAN COMPLETE');
  // Every master-plan turn errors; the pointer never advances → it must land on needs-you.
  const calls = { start: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => {};
  session.start = (args, hooks) => {
    calls.start++;
    hooks.send('session:message', { msg: { type: 'error' } });
    return {};
  };
  try {
    const r = new Runner(p);
    r.retryBackoffMs = 10;
    let done = null;
    const states = [];
    r.on('done', (d) => { done = d; });
    r.on('status', (s) => states.push(s.state));

    r.start();
    t.mock.timers.tick(1000); // drain the backoff retries

    assert.equal(done, null, 'never emits done for an errored close-out');
    assert.equal(calls.start, 2, 'initial master-plan run + exactly one retry');
    assert.equal(states[states.length - 1], 'needs-you', 'ends flagged needs-you, not "Plan complete"');
    assert.ok(r.needsYou, 'needsYou is set');
  } finally { for (const k of Object.keys(orig)) session[k] = orig[k]; }
});

test('NEXT: none finishes directly — no master-plan session started', (t) => {
  const p = tempProject('none');
  const { calls, restore } = fakeScripted(p.path, () => null);
  try {
    const r = new Runner(p);
    let done = null;
    r.on('done', (d) => { done = d; });
    r.start();
    assert.equal(calls.start, 0, 'no session for a terminal "none"');
    assert.equal(done && done.state, 'done', 'finished');
  } finally { restore(); }
});

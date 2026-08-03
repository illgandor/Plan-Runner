// P07-S01: graceful Stop (finish the current step, THEN halt) vs hard Abort (tear down NOW).
// Drives the Runner with a fake session that captures each step's send hook, so a test can fire
// a turn-end and watch the boundary logic. Stdlib-only, no Claude usage. (D-022)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner } = require('../src/runner');

function tempProject(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { dir, project: { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto' } };
}

// Swap the session singleton for spies; capture the send hook so a test can end a turn.
function fakeSession() {
  const calls = { start: [], stop: 0, interrupt: 0 };
  const orig = {};
  for (const k of ['start', 'interrupt', 'stop', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.start = (args, hooks) => { calls.start.push({ args, hooks }); return {}; }; // never fires send → turn stays live
  session.interrupt = () => { calls.interrupt++; };
  session.stop = () => { calls.stop++; };
  session.currentSessionId = () => 'sess-live';
  session.defaultSend = () => {};
  const restore = () => { for (const k of Object.keys(orig)) session[k] = orig[k]; };
  return { calls, restore };
}

// Fire a clean result turn-end on the most recent step's session.
function endTurn(calls) { calls.start.at(-1).hooks.send('session:message', { msg: { type: 'result' } }); }

test('graceful Stop mid-step keeps the session, finishes the step, then halts', () => {
  const { calls, restore } = fakeSession();
  try {
    const { dir, project } = tempProject('P07-S01');
    const r = new Runner(project);
    r.finalizeMs = 0; // no settle window → advance synchronously on turn-end
    const dones = [];
    r.on('done', (d) => dones.push(d.detail));

    r.start();
    assert.strictEqual(calls.start.length, 1, 'a step session started');
    assert.strictEqual(r._turnLive, true, 'turn is live');

    r.stop(); // graceful
    assert.strictEqual(r.stopRequested, true, 'stop requested');
    assert.strictEqual(calls.stop, 0, 'graceful Stop does NOT tear the session down');
    assert.strictEqual(r.running, true, 'still running — finishing the current step first');

    // The step completes: pointer advances, the turn ends → halt AFTER the step.
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P07-S02\n');
    endTurn(calls);
    assert.strictEqual(r.running, false, 'halted once the step finished');
    assert.strictEqual(calls.stop, 1, 'session torn down at the boundary');
    assert.strictEqual(calls.start.length, 1, 'no next step started after a graceful Stop');
    assert.ok(dones.some((d) => /Stopped after/.test(d)), `halted with a "Stopped after" done (got ${JSON.stringify(dones)})`);
  } finally { restore(); }
});

test('hard Abort tears the session down immediately, mid-step', () => {
  const { calls, restore } = fakeSession();
  try {
    const { project } = tempProject('P07-S01');
    const r = new Runner(project);
    let done = null;
    r.on('done', (d) => { done = d; });

    r.start();
    assert.strictEqual(r._turnLive, true, 'turn is live');

    r.abort();
    assert.strictEqual(calls.stop, 1, 'abort tears the session down now');
    assert.strictEqual(r.running, false, 'halted immediately, mid-step');
    assert.ok(done, 'emitted done');
  } finally { restore(); }
});

test('graceful Stop with no live turn (idle/gating/paused) halts now', () => {
  const { calls, restore } = fakeSession();
  try {
    const { project } = tempProject('P07-S01');
    const r = new Runner(project);
    r.start();
    r._turnLive = false; r.finalizing = false; // simulate a between-steps hold (no live turn)
    r.stop();
    assert.strictEqual(r.running, false, 'nothing to finish → halts now');
    assert.strictEqual(calls.stop, 1, 'session torn down');
  } finally { restore(); }
});

// D-057. The graceful branch can only end at a turn end, so a turn that never ends (an unanswered
// permission card, a wedged stream, a provider child killed out from under the loop) used to make
// EVERY further Stop click a no-op — the reported "I clicked stop and had to close VS Code".
test('a SECOND Stop escalates to a hard halt when the turn never ends', () => {
  const { calls, restore } = fakeSession();
  try {
    const { project } = tempProject('P07-S01');
    const r = new Runner(project);
    const dones = [];
    r.on('done', (d) => dones.push(d.detail));

    r.start();
    r.stop(); // graceful — the turn is still live and never ends
    assert.strictEqual(r.running, true, 'first Stop waits for the step');
    assert.strictEqual(calls.stop, 0, 'and keeps the session');

    r.stop(); // second click: escape hatch
    assert.strictEqual(r.running, false, 'second Stop halts now');
    assert.strictEqual(calls.stop, 1, 'session torn down');
    assert.ok(dones.some((d) => /Stopped now/.test(d)), `named the escalation (got ${JSON.stringify(dones)})`);
  } finally { restore(); }
});

// A raw provider.interrupt() during a run is invisible to the loop: the turn-end it produces reads
// as a COMPLETED turn, so the runner advanced past the step or retried it. interruptTurn() routes
// through _pause so the `paused` guard in _onTurnEnd drops that turn-end instead.
test('interruptTurn holds the step instead of letting the loop read a completed turn', () => {
  const { calls, restore } = fakeSession();
  try {
    const { dir, project } = tempProject('P07-S01');
    const r = new Runner(project);
    r.finalizeMs = 0;
    r.start();

    assert.strictEqual(r.interruptTurn(), true, 'a live Claude turn is interruptible');
    assert.strictEqual(calls.interrupt, 1, 'the turn was interrupted');
    assert.strictEqual(calls.stop, 0, 'but the session is kept for resume');
    assert.strictEqual(r.paused, true, 'the step is held, not finished');

    // The interrupt's turn-end now arrives. Even with the pointer advanced, the loop must NOT
    // treat it as a finished step and run the next one.
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: P07-S02\n');
    endTurn(calls);
    assert.strictEqual(calls.start.length, 1, 'no next step started off an interrupted turn');
    assert.strictEqual(r.running, true, 'the run is still live, holding the same step');
  } finally { restore(); }
});

test('interruptTurn refuses when there is nothing safe to interrupt', () => {
  const { restore } = fakeSession();
  try {
    const { project } = tempProject('P07-S01');
    const idle = new Runner(project);
    assert.strictEqual(idle.interruptTurn(), false, 'not running → nothing to interrupt');

    const live = new Runner(project);
    live.usageGate = { isOverThreshold() { return false; } };
    live.start();
    live.pauseManual();
    assert.strictEqual(live.interruptTurn(), false, 'already paused → nothing to interrupt');
  } finally { restore(); }
});

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

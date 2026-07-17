// P01-S08: mid-turn pause + auto-resume on usage reset (CONTRACTS §Session API; D-005).
// Drives the Runner state machine with a fake usage gate and a fake session (session.start
// never ends the turn, so the runner sits "live"). Stdlib-only, no Claude usage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner } = require('../src/runner');

// A temp master-plan project whose NEXT pointer stays on one step (the turn never advances
// it here — we only exercise pause/resume within the step).
function tempProject(step, engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', engine, model: '(default)', effort: '(default)', mode: 'auto' };
}

// Swap the session module's methods for spies; the Runner uses the same singleton object.
function fakeSession() {
  const calls = { start: [], interrupt: 0, stop: 0 };
  const orig = {};
  for (const k of ['start', 'interrupt', 'stop', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.start = (args) => { calls.start.push(args); return {}; };      // never fires hooks.send → turn stays live
  session.interrupt = () => { calls.interrupt++; };
  session.stop = () => { calls.stop++; };
  session.currentSessionId = () => 'sess-live';
  session.defaultSend = () => {};
  const restore = () => { for (const k of Object.keys(orig)) session[k] = orig[k]; };
  return { calls, restore };
}

test('over-threshold mid-turn interrupts once; back-under resumes with the captured id', () => {
  const { calls, restore } = fakeSession();
  try {
    const gate = { over: false, isOverThreshold() { return this.over; } };
    const r = new Runner(tempProject('P01-S08'));
    r.usageGate = gate;
    const events = [];
    r.on('paused', (d) => events.push(['paused', d.reason]));
    r.on('resumed', () => events.push(['resumed']));

    r.start();
    assert.strictEqual(calls.start.length, 1, 'step started a fresh session');
    assert.ok(!('resume' in calls.start[0].options), 'first start is a fresh context (no resume)');

    gate.over = true; r.onUsageUpdate();      // crosses threshold mid-turn
    assert.strictEqual(calls.interrupt, 1, 'interrupt called exactly once');
    assert.strictEqual(r.paused, true, 'runner marked paused');
    assert.strictEqual(events[0][0], 'paused');

    r.onUsageUpdate();                          // still over → no double interrupt, no resume
    assert.strictEqual(calls.interrupt, 1, 'no second interrupt while still over');
    assert.strictEqual(calls.start.length, 1, 'no resume while still over');

    gate.over = false; r.onUsageUpdate();      // drops back under → resume the same step
    assert.strictEqual(calls.start.length, 2, 'resume re-entered the session');
    assert.strictEqual(calls.start[1].options.resume, 'sess-live', 'resumed with the captured session id');
    assert.strictEqual(r.paused, false, 'no longer paused after resume');
    assert.strictEqual(events.at(-1)[0], 'resumed');
  } finally { restore(); }
});

test('Stop cancels a pending resume', () => {
  const { calls, restore } = fakeSession();
  try {
    const gate = { over: false, isOverThreshold() { return this.over; } };
    const r = new Runner(tempProject('P01-S08'));
    r.usageGate = gate;

    r.start();
    gate.over = true; r.onUsageUpdate();       // pause mid-turn
    assert.strictEqual(r.paused, true);

    r.stop();                                   // owner stops while paused
    gate.over = false; r.onUsageUpdate();      // usage drops — must NOT resume
    assert.strictEqual(calls.start.length, 1, 'stopped runner never resumes');
    assert.strictEqual(r.running, false, 'runner is halted');
  } finally { restore(); }
});

// P07-S02 (D-023): owner-driven Pause/Resume, Claude only, and the usage gate must NOT
// auto-resume a manual hold when usage happens to drop.
test('manual Pause holds; a usage drop does NOT auto-resume; resumeManual re-enters the step', () => {
  const { calls, restore } = fakeSession();
  try {
    const gate = { over: false, isOverThreshold() { return this.over; } };
    const r = new Runner(tempProject('P07-S02'));
    r.usageGate = gate;

    r.start();
    r.pauseManual();                            // owner pauses a live turn (usage is under)
    assert.strictEqual(calls.interrupt, 1, 'manual pause interrupts the turn');
    assert.strictEqual(r.paused, true);
    assert.strictEqual(r.manualPause, true, 'flagged as a manual hold');

    r.onUsageUpdate();                          // usage under (never went over) — must not resume
    assert.strictEqual(calls.start.length, 1, 'a usage tick never auto-resumes a manual pause');
    assert.strictEqual(r.paused, true, 'still held');

    r.resumeManual();                           // owner resumes → same step, captured id
    assert.strictEqual(calls.start.length, 2, 'resume re-entered the session');
    assert.strictEqual(calls.start[1].options.resume, 'sess-live', 'resumed with the captured id');
    assert.strictEqual(r.paused, false);
    assert.strictEqual(r.manualPause, false, 'manual flag cleared on resume');
  } finally { restore(); }
});

test('pauseManual is refused on Codex (no mid-turn interrupt)', () => {
  const { calls, restore } = fakeSession();
  try {
    const r = new Runner(tempProject('P07-S02', 'codex'));
    r.usageGate = { over: false, isOverThreshold() { return false; } };
    r.running = true; r._turnLive = true;       // simulate a live turn without driving a real Codex session
    r.pauseManual();
    assert.strictEqual(r.paused, false, 'Codex is never paused mid-turn');
    assert.strictEqual(calls.interrupt, 0, 'no interrupt issued for Codex');
  } finally { restore(); }
});

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

// Swap the CODEX provider for the same spies (the Runner resolves it via engine.provider).
// currentSessionId returns the persisted THREAD id — that is what `codex exec resume` takes.
function fakeCodex() {
  const codex = require('../src/codex');
  const calls = { start: [], interrupt: 0, stop: 0 };
  const orig = {};
  for (const k of ['start', 'interrupt', 'stop', 'currentSessionId']) orig[k] = codex[k];
  codex.start = (args) => { calls.start.push(args); return {}; };        // never fires hooks.send → turn stays live
  codex.interrupt = () => { calls.interrupt++; };
  codex.stop = () => { calls.stop++; };
  codex.currentSessionId = () => 'thread-live';
  const restore = () => { for (const k of Object.keys(orig)) codex[k] = orig[k]; };
  return { calls, restore };
}

// P07-S02 (D-023): owner-driven Pause/Resume, and the usage gate must NOT
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

// P16-S09 (D-077) retires D-023's Claude-only half: `codex exec resume <SESSION_ID> [PROMPT]`
// is a real CLI subcommand (observed on codex-cli 0.144.2), and the usage gate has driven this
// exact interrupt→resume path on Codex since P16-S08. So the manual hold works there too.
test('manual Pause holds a Codex turn and resumes it on the persisted thread id', () => {
  const { calls, restore } = fakeCodex();
  try {
    const r = new Runner(tempProject('P16-S09', 'codex'));
    r.usageGate = { over: false, isOverThreshold() { return false; } };

    r.start();
    assert.strictEqual(calls.start.length, 1, 'step started a fresh Codex turn');

    r.pauseManual();
    assert.strictEqual(calls.interrupt, 1, 'the live child is interrupted');
    assert.strictEqual(r.paused, true, 'Codex runner is held');
    assert.strictEqual(r.manualPause, true, 'flagged as a manual hold');
    assert.strictEqual(r._turnLive, false, 'the turn is not left marked live');

    r.onUsageUpdate();                          // usage under — must not auto-resume a manual hold
    assert.strictEqual(calls.start.length, 1, 'a usage tick never auto-resumes a manual pause');

    r.resumeManual();
    assert.strictEqual(calls.start.length, 2, 'resume re-entered the same step');
    assert.strictEqual(calls.start[1].options.resume, 'thread-live', 'resumed onto the Codex thread id');
    assert.strictEqual(r.paused, false);
    assert.strictEqual(r.manualPause, false, 'manual flag cleared on resume');
  } finally { restore(); }
});

// D-074: the parity change must not alter Claude. Same sequence, Claude provider, unchanged.
test('the Codex parity change leaves the Claude manual-hold path byte-identical', () => {
  const { calls, restore } = fakeSession();
  try {
    const r = new Runner(tempProject('P16-S09'));
    r.usageGate = { over: false, isOverThreshold() { return false; } };
    r.start();
    r.pauseManual();
    assert.strictEqual(calls.interrupt, 1, 'Claude still interrupts on a manual pause');
    r.resumeManual();
    assert.strictEqual(calls.start[1].options.resume, 'sess-live', 'Claude still resumes its SDK session id');
  } finally { restore(); }
});

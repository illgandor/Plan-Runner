// Settle window: after a step's turn ends AND the NEXT pointer advanced, the runner holds
// finalizeMs of quiet before teardown+advance (so close-out isn't cut off and the summary
// stays on screen). Restored from the standalone's pty FINALIZE_IDLE_MS. Stdlib-only.
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
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto' };
}

// Fake session: on start it advances the pointer (simulating the step's close-out) then ends
// the turn with a `result`, driving the runner into the finalize path. Returns spy counters.
function fakeAdvancing(dir, to) {
  const calls = { start: 0, stop: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => { calls.stop++; };
  session.start = (args, hooks) => {
    calls.start++;
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  return { calls, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('pointer advanced → holds for finalizeMs, then tears down + emits step-done', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const { calls, restore } = fakeAdvancing(p.path, 'S2');
  try {
    const r = new Runner(p);
    r.finalizeMs = 1000;
    r.gitCheck = () => ({ clean: true, pushed: true }); // temp dir isn't a repo; assert the window, not git
    const events = [];
    for (const e of ['status', 'step-done']) r.on(e, (d) => events.push({ e, ...d }));

    r.start(); // runs S1 → close-out advances pointer to S2 → enter settle window
    assert.equal(r.finalizing, true, 'should be settling, not advanced');
    assert.equal(calls.stop, 0, 'no teardown during the window');
    assert.ok(events.some((x) => x.e === 'status' && x.state === 'finalizing'), 'emits finalizing status');

    t.mock.timers.tick(1000); // window elapses
    assert.equal(r.finalizing, false, 'window done');
    assert.equal(calls.stop, 1, 'torn down exactly once after the window');
    assert.ok(events.some((x) => x.e === 'step-done' && x.from === 'S1' && x.to === 'S2'), 'step-done fired');
  } finally { restore(); }
});

test('usage gate is inert on Codex — never pauses a Codex run on Claude usage', () => {
  const over = { isOverThreshold: () => true };
  const codex = new Runner({ id: 'c', path: '.', engine: 'codex', model: '(default)', effort: '(default)', mode: 'auto' });
  codex.usageGate = over;
  assert.equal(codex._over(), false, 'Codex must ignore the Claude usage gate');
  const claude = new Runner({ id: 'd', path: '.', engine: 'claude', model: '(default)', effort: '(default)', mode: 'auto' });
  claude.usageGate = over;
  assert.equal(claude._over(), true, 'Claude still gates on usage');
});

test('finalizeMs=0 disables the window — advances immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const { calls, restore } = fakeAdvancing(p.path, 'S2');
  try {
    const r = new Runner(p);
    r.finalizeMs = 0;
    r.gitCheck = () => ({ clean: true, pushed: true });
    r.start();
    assert.equal(r.finalizing, false, 'never enters a window');
    assert.equal(calls.stop, 1, 'torn down immediately');
  } finally { restore(); }
});

test('handoff guard: dirty tree blocks the advance → needs-you, session kept alive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const { calls, restore } = fakeAdvancing(p.path, 'S2');
  try {
    const r = new Runner(p);
    r.finalizeMs = 0; // advance immediately → straight to the guard
    r.gitCheck = () => ({ clean: false, pushed: true }); // step left uncommitted work (the S05 failure)
    const events = [];
    r.on('status', (d) => events.push(d));
    r.start();
    assert.equal(calls.stop, 0, 'not torn down — work would be stranded');
    assert.equal(r.needsYou, true, 'hands back to the owner');
    assert.ok(events.some((x) => x.state === 'needs-you' && /close-out is incomplete/.test(x.detail)), 'explains why');
  } finally { restore(); }
});

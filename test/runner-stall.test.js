// Mid-turn stall watchdog (P09-S05, D-030): a live turn that produces no session messages for
// stallMs fires ONE `stall` event — notify-only, the turn is never interrupted/torn down. New
// activity re-arms it; a fresh silent window notifies again; 0 disables. Injected timers, stdlib.
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

// Fake session that keeps the turn LIVE: on start it streams one non-terminal message (arms the
// watchdog) and never sends `result`, so the turn stays open. `cap.send` re-injects activity.
function fakeLiveTurn() {
  const calls = { stop: 0, interrupt: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => { calls.stop++; };
  session.interrupt = () => { calls.interrupt++; };
  const cap = { send: null };
  session.start = (_args, hooks) => {
    cap.send = hooks.send;
    hooks.send('session:message', { msg: { type: 'assistant' } }); // first activity → arms the watchdog
    return {};
  };
  return { calls, cap, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('silence past the threshold emits exactly one stall; new activity re-arms for the next window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const f = fakeLiveTurn();
  try {
    const r = new Runner(p);
    r.stallMs = 1000;
    const stalls = [];
    r.on('stall', (s) => stalls.push(s));

    r.start(); // runs S1 → turn goes live, first message arms the watchdog
    assert.equal(r._turnLive, true, 'turn is live');

    t.mock.timers.tick(1000); // full window of silence
    assert.equal(stalls.length, 1, 'exactly one stall after the threshold');
    assert.deepEqual(stalls[0], { step: 'S1', seconds: 1 });

    t.mock.timers.tick(5000); // more silence, but not re-armed → no repeat
    assert.equal(stalls.length, 1, 'does not re-fire without new activity');

    f.cap.send('session:message', { msg: { type: 'assistant' } }); // new activity re-arms
    t.mock.timers.tick(1000);
    assert.equal(stalls.length, 2, 'a fresh silent window notifies again');

    // Notify-only (D-030): the turn was never interrupted or torn down.
    assert.equal(r._turnLive, true, 'turn still live — watchdog never touched it');
    assert.equal(f.calls.interrupt, 0);
    assert.equal(f.calls.stop, 0);
  } finally { f.restore(); }
});

test('activity before the threshold resets the timer — no premature stall', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const f = fakeLiveTurn();
  try {
    const r = new Runner(p);
    r.stallMs = 1000;
    const stalls = [];
    r.on('stall', (s) => stalls.push(s));

    r.start();
    t.mock.timers.tick(900);                                        // almost there…
    f.cap.send('session:message', { msg: { type: 'assistant' } }); // …activity resets it
    t.mock.timers.tick(900);                                        // 900 since reset < 1000
    assert.equal(stalls.length, 0, 'steady activity never trips the watchdog');
  } finally { f.restore(); }
});

test('stallMs 0 (default) disables the watchdog entirely', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const f = fakeLiveTurn();
  try {
    const r = new Runner(p); // stallMs defaults to 0
    const stalls = [];
    r.on('stall', (s) => stalls.push(s));
    r.start();
    t.mock.timers.tick(3_600_000);
    assert.equal(stalls.length, 0, '0 = off: no stall ever fires');
  } finally { f.restore(); }
});

test('turn end clears the watchdog — a completed turn never stalls', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const f = fakeLiveTurn();
  try {
    const r = new Runner(p);
    r.stallMs = 1000;
    const stalls = [];
    r.on('stall', (s) => stalls.push(s));

    r.start();
    f.cap.send('session:message', { msg: { type: 'result' } }); // turn ends (pointer unchanged → needs-you)
    assert.equal(r._turnLive, false, 'turn ended');
    t.mock.timers.tick(5000);
    assert.equal(stalls.length, 0, 'no stall after the turn ended');
  } finally { f.restore(); }
});

// answer()-loop fix (P05-S01): a "needs you" answered from the panel must ADVANCE the loop on
// BOTH engines, not stall forever. The old answer() called provider.chat() without the turn-end
// wrapper, so a follow-up turn that has no live session (Codex always; Claude after an errored
// turn) ended with nobody watching → the pointer advanced but the Runner never noticed. This
// drives needs-you → answer → pointer-advance → step-done for each engine. Stdlib-only; stubs
// the provider module like runner-advance/runner-finalize.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Runner } = require('../src/runner');

function tempProject(step, engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto', engine };
}

// Stub a provider module (session or codex). start() ends its turn leaving the pointer UNCHANGED
// (→ needs-you). chat() is the answer follow-up: it writes `advanceTo` then fires result through
// the hooks the Runner passes — the ONLY path that reaches _onTurnEnd, so if answer() forgets the
// wrapper this stays a stall and the test fails. Records whether chat got a turn-end wrapper.
function stubProvider(mod, dir, advanceTo) {
  const keys = ['start', 'chat', 'stop', 'interrupt', 'currentSessionId', 'defaultSend'];
  const orig = {};
  for (const k of keys) orig[k] = mod[k];
  const calls = { chat: 0, chatHadHook: false };
  mod.defaultSend = () => {};
  mod.interrupt = () => {};
  mod.stop = () => {};
  mod.currentSessionId = () => 'sess-1';
  mod.start = (_args, hooks) => { hooks.send('session:message', { msg: { type: 'result' } }); return {}; };
  mod.chat = (_args, hooks) => {
    calls.chat++;
    calls.chatHadHook = !!(hooks && typeof hooks.send === 'function');
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${advanceTo}\n`);
    if (hooks && hooks.send) hooks.send('session:message', { msg: { type: 'result' } });
  };
  return { calls, restore: () => { for (const k of keys) mod[k] = orig[k]; } };
}

// P09-S01 (D-027): a composer send while PAUSED is an explicit resume. Before the fix answer()
// left this.paused set, so _onTurnEnd's `paused` guard dropped the follow-up turn's result and the
// loop desynced (pointer advanced, runner never noticed). Pause mid-turn → answer → step advances.
test('answer while paused resumes tracking and advances the loop (D-027)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1', 'claude');
  const mod = require('../src/session');
  const keys = ['start', 'chat', 'stop', 'interrupt', 'currentSessionId', 'defaultSend'];
  const orig = {};
  for (const k of keys) orig[k] = mod[k];
  const calls = { chat: 0 };
  mod.defaultSend = () => {};
  mod.interrupt = () => {};
  mod.stop = () => {};
  mod.currentSessionId = () => 'sess-1';
  mod.start = () => ({}); // never fires a turn-end → the turn stays live so we can pause it
  mod.chat = (_args, hooks) => {
    calls.chat++;
    fs.writeFileSync(path.join(p.path, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: none\n'); // answer advances S1 → done
    if (hooks && hooks.send) hooks.send('session:message', { msg: { type: 'result' } });
  };
  try {
    const gate = { over: false, isOverThreshold() { return this.over; } };
    const r = new Runner(p);
    r.finalizeMs = 0;
    r.usageGate = gate;
    r.gitCheck = () => ({ clean: true, pushed: true });
    let done = null; const advanced = []; const resumed = [];
    r.on('done', (d) => { done = d; });
    r.on('step-done', (d) => advanced.push(d));
    r.on('resumed', () => resumed.push(1));

    r.start();
    t.mock.timers.tick(0);
    gate.over = true; r.onUsageUpdate();        // usage crosses threshold mid-turn → pause
    assert.equal(r.paused, true, 'paused on the usage gate');

    r.answer('keep going');                      // send while paused = explicit resume (D-027)
    t.mock.timers.tick(0);

    assert.equal(r.paused, false, 'answer cleared the pause');
    assert.equal(resumed.length, 1, 'answer emitted resumed');
    assert.equal(calls.chat, 1, 'answer routed through provider.chat');
    assert.deepEqual(advanced.map((a) => a.from), ['S1'], 'the paused step advanced after the answer');
    assert.equal(done && done.state, 'done', 'the loop finished after the answer, did not desync');
  } finally { for (const k of keys) mod[k] = orig[k]; }
});

for (const engine of ['claude', 'codex']) {
  test(`${engine}: needs-you → answer advances the loop (not stall)`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
    const p = tempProject('S1', engine);
    const mod = require(engine === 'codex' ? '../src/codex' : '../src/session');
    const { calls, restore } = stubProvider(mod, p.path, 'none'); // answer advances S1 → done
    try {
      const r = new Runner(p);
      r.finalizeMs = 0;
      r.gitCheck = () => ({ clean: true, pushed: true });
      let done = null; const advanced = [];
      r.on('done', (d) => { done = d; });
      r.on('step-done', (d) => advanced.push(d));

      r.start();
      t.mock.timers.tick(0);
      assert.equal(r.needsYou, true, 'first turn left the pointer unchanged → needs-you');
      assert.equal(done, null, 'not finished — waiting on the answer');

      r.answer('do the thing');
      t.mock.timers.tick(0); // drain the advance → runNext → finish chain

      assert.equal(calls.chat, 1, 'answer routed through provider.chat');
      assert.ok(calls.chatHadHook, 'answer passed the turn-end wrapper so the follow-up turn advances');
      assert.deepEqual(advanced.map((a) => a.from), ['S1'], 'the answered step advanced');
      assert.equal(done && done.state, 'done', 'the loop finished after the answer, did not stall');
    } finally { restore(); }
  });
}

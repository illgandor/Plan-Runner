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

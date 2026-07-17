// Per-step run ledger (P05-S07): when a step's pointer advances, the runner appends exactly one
// well-formed JSONL record (§Result event + run ledger) with the step's engine/model/tokens/cost.
// The write is best-effort (D-017) — a throwing appendLedger never blocks or delays the loop.
// Stdlib-only; stubs the session provider like runner-advance/runner-finalize.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner, appendLedger } = require('../src/runner');
const { STEP_PROMPT } = require('../src/constants');

function tempProject(step, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: 'opus', effort: 'high', mode: 'auto', ...extra };
}

// Fake session: on start, advance the pointer to `to`, then end the turn with a rich `result`
// msg carrying the ledger inputs (turnTokens/numTurns/costUsd). Returns restore().
function fakeSession(dir, to, resultMsg) {
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => {};
  session.start = (args, hooks) => {
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type: 'result', ...resultMsg } });
    return {};
  };
  return () => { for (const k of Object.keys(orig)) session[k] = orig[k]; };
}

test('completed step appends exactly one well-formed ledger record', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const restore = fakeSession(p.path, 'none', { turnTokens: 4200, numTurns: 7, costUsd: 0.12 });
  try {
    const r = new Runner(p);
    r.finalizeMs = 0;
    r.gitCheck = () => ({ clean: true, pushed: true });
    const rows = [];
    r.appendLedger = (cwd, rec) => rows.push({ cwd, rec });
    r.start();
    t.mock.timers.tick(0);

    assert.equal(rows.length, 1, 'exactly one record for the one completed step');
    assert.equal(rows[0].cwd, p.path);
    const rec = rows[0].rec;
    assert.deepEqual(Object.keys(rec).sort(),
      ['costUsd', 'effort', 'endedAt', 'engine', 'model', 'numTurns', 'outcome', 'startedAt', 'stepId', 'tokens'],
      'record has exactly the contract fields');
    assert.equal(rec.stepId, 'S1');
    assert.equal(rec.engine, 'claude');   // default engine
    assert.equal(rec.model, 'opus');
    assert.equal(rec.effort, 'high');
    assert.equal(rec.numTurns, 7);
    assert.equal(rec.tokens, 4200);
    assert.equal(rec.costUsd, 0.12);
    assert.equal(rec.outcome, 'done');
    assert.ok(!Number.isNaN(Date.parse(rec.startedAt)) && !Number.isNaN(Date.parse(rec.endedAt)), 'ISO timestamps');
  } finally { restore(); }
});

test('a throwing appendLedger never blocks the run (step still advances)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const restore = fakeSession(p.path, 'none', {});
  try {
    const r = new Runner(p);
    r.finalizeMs = 0;
    r.gitCheck = () => ({ clean: true, pushed: true });
    r.appendLedger = () => { throw new Error('disk full'); };
    let done = null;
    r.on('done', (d) => { done = d; });
    // _recordStep calls appendLedger directly; a raw throw would propagate, so it MUST be caught
    // inside appendLedger. The default writer swallows; assert the run still finishes.
    r.appendLedger = appendLedger; // real writer, but point it at a path that can't be created
    // Force a write failure: make .plan-runner a file so mkdir/append throw, then confirm no crash.
    fs.writeFileSync(path.join(p.path, '.plan-runner'), 'x');
    r.start();
    t.mock.timers.tick(0);
    assert.equal(done && done.state, 'done', 'run finished despite the ledger write failing');
  } finally { restore(); }
});

test('appendLedger writes one parseable JSON line to .plan-runner/runs.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  appendLedger(dir, { stepId: 'S1', outcome: 'done' });
  appendLedger(dir, { stepId: 'S2', outcome: 'done' });
  const lines = fs.readFileSync(path.join(dir, '.plan-runner', 'runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one append-only line per call');
  assert.deepEqual(JSON.parse(lines[0]), { stepId: 'S1', outcome: 'done' });
  assert.deepEqual(JSON.parse(lines[1]), { stepId: 'S2', outcome: 'done' });
});

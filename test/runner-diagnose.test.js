// P22-S01 — stuckSignal(): the diagnosis trigger, read from the run ledger (D-094).
// Pure predicate, so every case is a fixture: no run, no git, no session. The three triggers each
// return their OWN reason, and anything the ledger can't answer reads as "not stuck" (D-017).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stuckSignal, STUCK_REPEATS } = require('../src/runner');

const attempt = (stepId, head) => ({ kind: 'step-attempt', stepId, head });
const gateFail = (stepId, gate) => ({ kind: 'gate-fail', stepId, gate });

test('the same focused gate failing twice is its own reason', () => {
  const recs = [gateFail('S1', 'unit'), gateFail('S1', 'build'), gateFail('S1', 'unit')];
  assert.equal(stuckSignal(recs, 'S1').reason, 'gate-failed-twice');
  assert.match(stuckSignal(recs, 'S1').detail, /unit/);
  // two DIFFERENT gates failing once each is not the trigger — it's ordinary iteration
  assert.equal(stuckSignal([gateFail('S1', 'unit'), gateFail('S1', 'build')], 'S1'), null);
  // another step's failures are not this step's
  assert.equal(stuckSignal([gateFail('S2', 'unit'), gateFail('S2', 'unit')], 'S1'), null);
});

test('a third start of the same step is its own reason', () => {
  const two = [attempt('S1', 'aaa'), attempt('S1', 'aaa')];
  assert.equal(stuckSignal(two, 'S1'), null, 'a retry is normal; two starts is under the budget');
  const three = [...two, attempt('S1', 'aaa')];
  assert.equal(stuckSignal(three, 'S1').reason, 'restart-loop');
  assert.match(stuckSignal(three, 'S1').detail, /3×/);
});

test('committing for a step then rolling back is its own reason', () => {
  // HEAD left aaa for bbb (the step committed), then came back to aaa — that work is gone.
  const recs = [attempt('S1', 'aaa'), attempt('S1', 'bbb'), attempt('S1', 'aaa')];
  const sig = stuckSignal(recs, 'S1');
  assert.equal(sig.reason, 'commits-reverted', 'the specific reason wins over the restart count');
  assert.match(sig.detail, /aaa/);
  // moving FORWARD through new commits is progress, not a revert
  assert.equal(stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'bbb')], 'S1'), null);
});

test('the three reasons are distinct', () => {
  const reasons = [
    stuckSignal([gateFail('S1', 'unit'), gateFail('S1', 'unit')], 'S1').reason,
    stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'aaa'), attempt('S1', 'aaa')], 'S1').reason,
    stuckSignal([attempt('S1', 'aaa'), attempt('S1', 'bbb'), attempt('S1', 'aaa')], 'S1').reason,
  ];
  assert.equal(new Set(reasons).size, 3);
});

test('absent, empty and malformed ledger data are "not stuck", and throw nothing', () => {
  for (const bad of [undefined, null, [], 'not an array', 42, {}, [null], [undefined], ['line'],
    [{ }], [{ kind: 'step-attempt' }], [{ kind: 'gate-fail', stepId: 'S1' }],
    [{ kind: 'usage-event', stepId: 'S1' }], [{ stepId: 'S1', outcome: 'done' }]]) {
    assert.equal(stuckSignal(bad, 'S1'), null, `${JSON.stringify(bad)} → null`);
  }
  assert.equal(stuckSignal([attempt('S1', 'aaa')], ''), null, 'no step id → null');
  assert.equal(stuckSignal([attempt('S1', 'aaa')], undefined), null);
});

test('the threshold is one named constant that both counting triggers read', () => {
  assert.equal(typeof STUCK_REPEATS, 'number');
  const gates = Array.from({ length: STUCK_REPEATS }, () => gateFail('S1', 'unit'));
  assert.equal(stuckSignal(gates.slice(0, -1), 'S1'), null, 'one under the threshold: not stuck');
  assert.equal(stuckSignal(gates, 'S1').reason, 'gate-failed-twice');
  const starts = Array.from({ length: STUCK_REPEATS + 1 }, () => attempt('S1', 'aaa'));
  assert.equal(stuckSignal(starts.slice(0, -1), 'S1'), null);
  assert.equal(stuckSignal(starts, 'S1').reason, 'restart-loop');
});

test('nothing in runner.js calls stuckSignal yet (S02 owns the wiring)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/runner.js'), 'utf8');
  const calls = src.match(/stuckSignal\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one occurrence: its own definition');
});

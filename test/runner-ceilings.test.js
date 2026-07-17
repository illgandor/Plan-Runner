// P05-S04: optional run ceilings (maxStepsPerRun + stopAtTime), both default OFF, checked
// between steps in _runNext. A step already in flight always finishes; the ceiling only stops
// the run before STARTING the next one. Stdlib-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Runner, stopTimeReached } = require('../src/runner');

function tempProject(step, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto', ...extra };
}

// A run started at 05:00 local time (reference for the wall-clock ceiling).
const FIVE_AM = new Date(2026, 6, 17, 5, 0, 0, 0).getTime();
const at = (h, m) => new Date(2026, 6, 17, h, m, 0, 0).getTime();

test('stopTimeReached: off, before, at, and overnight next-day', () => {
  assert.equal(stopTimeReached(FIVE_AM, at(23, 0), ''), false, 'empty = off, never stops');
  assert.equal(stopTimeReached(FIVE_AM, at(23, 0), 'nonsense'), false, 'malformed = off');
  assert.equal(stopTimeReached(FIVE_AM, at(5, 59), '06:00'), false, 'before target = keep going');
  assert.equal(stopTimeReached(FIVE_AM, at(6, 0), '06:00'), true, 'at target = stop');
  assert.equal(stopTimeReached(FIVE_AM, at(7, 0), '06:00'), true, 'past target = stop');
  // Started 22:00, stop 06:00: target is NEXT day 06:00, not the already-past 06:00 today.
  const tenPm = new Date(2026, 6, 17, 22, 0, 0, 0).getTime();
  const sixNext = new Date(2026, 6, 18, 6, 0, 0, 0).getTime();
  assert.equal(stopTimeReached(tenPm, tenPm, '06:00'), false, 'overnight: 22:00 does not trip 06:00');
  assert.equal(stopTimeReached(tenPm, sixNext, '06:00'), true, 'overnight: trips at next-day 06:00');
});

test('maxStepsPerRun default 0 = unlimited: does not block, proceeds to start the step', () => {
  const p = tempProject('P01-S01', { maxStepsPerRun: 0 });
  const r = new Runner(p);
  r.running = true;
  r.stepsRun = 50; // well past any real count; with 0 = off it must NOT stop
  let started = null;
  r._startSession = (stepId) => { started = stepId; };
  r._runNext();
  assert.equal(started, 'P01-S01', 'unlimited run reaches the step');
});

test('maxStepsPerRun > 0: stops cleanly between steps at the ceiling, reports why', () => {
  const p = tempProject('P01-S01', { maxStepsPerRun: 2 });
  const r = new Runner(p);
  r.running = true;
  r.stepsRun = 2; // ceiling reached
  r._startSession = () => assert.fail('must not start a step past the ceiling');
  const done = [];
  r.on('done', (d) => done.push(d));
  r._runNext();
  assert.equal(done.length, 1, 'finishes the run');
  assert.equal(done[0].state, 'idle');
  assert.match(done[0].detail, /max steps per run \(2\)/, 'explains the ceiling');
});

test('stopAtTime: past the wall-clock ceiling stops the run; empty does not', () => {
  const p = tempProject('P01-S01', { stopAtTime: '06:00' });
  const r = new Runner(p);
  r.running = true;
  r._startedAtMs = FIVE_AM;
  r.now = () => at(6, 30); // clock is past 06:00
  r._startSession = () => assert.fail('must not start a step past the stop time');
  const done = [];
  r.on('done', (d) => done.push(d));
  r._runNext();
  assert.equal(done[0].state, 'idle');
  assert.match(done[0].detail, /stop-at time \(06:00\)/, 'explains the ceiling');

  // Same clock, ceiling OFF → proceeds to the step.
  const p2 = tempProject('P01-S01', { stopAtTime: '' });
  const r2 = new Runner(p2);
  r2.running = true;
  r2._startedAtMs = FIVE_AM;
  r2.now = () => at(6, 30);
  let started = null;
  r2._startSession = (stepId) => { started = stepId; };
  r2._runNext();
  assert.equal(started, 'P01-S01', 'off = never stops');
});

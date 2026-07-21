// Morning digest at run end (P09-S16): buildDigest rolls the run-ledger records into one line
// (step span, token sum, wall time), keeping only records that started at/after the run's start.
// readLedger is best-effort (D-017): a garbled line is skipped, a missing file yields []. Stdlib-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDigest, readLedger, appendLedger } = require('../src/runner');

const T0 = Date.parse('2026-07-21T02:00:00.000Z'); // run start reference
const rec = (stepId, startMin, endMin, tokens) => ({
  stepId,
  startedAt: new Date(T0 + startMin * 60000).toISOString(),
  endedAt: new Date(T0 + endMin * 60000).toISOString(),
  tokens,
});

test('buildDigest rolls multi-step records into one span/token/wall line', () => {
  const rows = [rec('S1', 0, 20, 4000), rec('S2', 20, 95, 5000)]; // 95 min wall = 1h 35m
  assert.equal(buildDigest(rows, T0), 'Run digest: 2 steps (S1 → S2) · 9000 tokens · 1h 35m wall');
});

test('single step: no span arrow, singular "step", sub-hour wall in minutes', () => {
  assert.equal(buildDigest([rec('S1', 0, 12, 4200)], T0), 'Run digest: 1 step (S1) · 4200 tokens · 12m wall');
});

test('records that started before the run start are excluded', () => {
  const rows = [rec('OLD', -60, -30, 9999), rec('S1', 0, 10, 100)];
  assert.equal(buildDigest(rows, T0), 'Run digest: 1 step (S1) · 100 tokens · 10m wall');
});

test('no records in the window → null (caller posts nothing)', () => {
  assert.equal(buildDigest([rec('OLD', -60, -30, 1)], T0), null);
  assert.equal(buildDigest([], T0), null);
  assert.equal(buildDigest(null, T0), null);
});

test('null/missing tokens count as zero in the sum', () => {
  const rows = [rec('S1', 0, 5, null), rec('S2', 5, 10, 300)];
  assert.equal(buildDigest(rows, T0), 'Run digest: 2 steps (S1 → S2) · 300 tokens · 10m wall');
});

test('readLedger round-trips appendLedger, skips a garbled line, [] on missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  assert.deepEqual(readLedger(dir), [], 'missing runs.jsonl → []');
  appendLedger(dir, { stepId: 'S1', startedAt: new Date(T0).toISOString(), endedAt: new Date(T0).toISOString(), tokens: 1 });
  fs.appendFileSync(path.join(dir, '.plan-runner', 'runs.jsonl'), 'not json\n'); // torn tail line
  appendLedger(dir, { stepId: 'S2', startedAt: new Date(T0 + 60000).toISOString(), endedAt: new Date(T0 + 120000).toISOString(), tokens: 2 });
  const recs = readLedger(dir);
  assert.equal(recs.length, 2, 'the two good lines survive, the garbled one is skipped');
  assert.deepEqual(recs.map((r) => r.stepId), ['S1', 'S2']);
});

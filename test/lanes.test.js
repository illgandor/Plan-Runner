// P26-S05: src/lanes.js reads the other lanes from pushed branches (CONTRACTS §Lane view).
// One scratch fixture: a bare origin holding Tyler's and Reno's lane branches plus decoys, and
// Tyler's clone of it. Branch ages are pinned with GIT_COMMITTER_DATE so "newest" is deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readLanes, activePlan, doneSteps, laneView, laneRefresher } = require('../src/lanes');

const progress = (next, plan, done) => [
  '# PROGRESS', '## ▶ NEXT STEP', ...next, '', '## Dashboard', '| Plan | Slug | Status | Done |', '|---|---|---|---|',
  `| PLAN-${plan} | x | 🔵 ACTIVE | ${done.length}/6 |`, '', '## Board', '| Step | Title | M | Status | Done |',
  '|---|---|---|---|---|',
  ...[1, 2, 3, 4, 5, 6].map((n) => `| P${plan}-S0${n} | t${n} | M1 | ${done.includes(n) ? '✅' : '⬜'} | |`),
  '',
].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-lanes-'));
  let t = 1700000000;
  const run = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe',
    env: { ...process.env, GIT_COMMITTER_DATE: `${t} +0000`, GIT_AUTHOR_DATE: `${t} +0000` } }).toString();
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  run(root, 'init', '-q', '--bare', origin);
  fs.mkdirSync(work);
  run(work, 'init', '-q', '-b', 'main');
  run(work, 'config', 'user.email', 't@example.com');
  run(work, 'config', 'user.name', 'T');
  run(work, 'remote', 'add', 'origin', origin);
  const branch = (name, text) => {
    t += 100;
    run(work, 'checkout', '-q', '--orphan', name);
    run(work, 'rm', '-rfq', '--ignore-unmatch', '.');
    if (text == null) fs.writeFileSync(path.join(work, 'notes.txt'), name);
    else fs.writeFileSync(path.join(work, 'PROGRESS.md'), text);
    run(work, 'add', '-A');
    run(work, 'commit', '-qm', name);
    run(work, 'push', '-q', 'origin', name);
  };
  const lanes = (tyler, reno) => [`NEXT[Tyler]: ${tyler}`, `NEXT[Reno]: ${reno}`];
  branch('reno/PLAN-04-draft', progress(lanes('P04-S03', 'P04-S02'), '04', [1]));       // oldest decoy
  branch('reno/PLAN-04-files-fix', progress(lanes('P04-S03', 'P04-S05'), '04', [4]));  // newer match
  branch('reno/PLAN-04', progress(lanes('P04-S03', 'P04-S06'), '04', [1, 4, 5]));      // the convention
  branch('reno/experiment', progress(lanes('P03-S01', 'P03-S02'), '03', [1]));         // other plan
  branch('reno/notes', null);                                                           // no PROGRESS.md
  branch('tyler/PLAN-04', progress([...lanes('P04-S03', 'P04-S01'), 'NEXT[Sam]: P04-S01'], '04', [1, 2]));
  const clone = path.join(root, 'clone');
  run(root, 'clone', '-q', '-b', 'tyler/PLAN-04', origin, clone);
  return { clone, run };
}

const snapshot = (clone, run) => ({
  status: run(clone, 'status', '--porcelain'),
  head: run(clone, 'rev-parse', '--abbrev-ref', 'HEAD'),
  refs: run(clone, 'for-each-ref'),
  progress: fs.readFileSync(path.join(clone, 'PROGRESS.md'), 'utf8'),
});

test('lanes: finds reno/PLAN-04, lists its done steps, writes nothing, then falls back', async () => {
  const { clone, run } = fixture();
  const before = snapshot(clone, run);
  const r = await readLanes(clone, 'Tyler');
  const reno = r.lanes.find((l) => l.lane === 'Reno');
  assert.strictEqual(reno.state, 'found');
  assert.strictEqual(reno.ref, 'origin/reno/PLAN-04', 'the convention wins over the newer decoys');
  assert.strictEqual(reno.next, 'P04-S06');
  assert.deepStrictEqual(reno.doneThere, ['P04-S04', 'P04-S05'], '✅ there, ⬜ here');
  assert.ok(reno.updatedAt > 0);
  assert.deepStrictEqual(r.lanes.find((l) => l.lane === 'Sam'),
    { lane: 'Sam', state: 'no-branch', ref: null, updatedAt: null, next: null, doneThere: [] });
  assert.ok(!r.lanes.some((l) => l.lane === 'Tyler'), 'my own lane is never listed');
  assert.deepStrictEqual(r.combined, { plan: 'PLAN-04', done: 4, total: 6 }, 'S01 S02 here + S04 S05 there');
  assert.deepStrictEqual(snapshot(clone, run), before, 'no file, ref, checkout or fetch change');

  // The convention branch is gone: the newest branch with a Reno pointer on PLAN-04 wins —
  // skipping the newer one with no PROGRESS.md and the newer one on PLAN-03.
  run(clone, 'update-ref', '-d', 'refs/remotes/origin/reno/PLAN-04');
  const f = (await readLanes(clone, 'tyler')).lanes.find((l) => l.lane === 'Reno');
  assert.strictEqual(f.ref, 'origin/reno/PLAN-04-files-fix');
  assert.strictEqual(f.next, 'P04-S05');
  assert.deepStrictEqual(f.doneThere, ['P04-S04']);
});

test('lanes: unlaned → empty result and zero git calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-lanes-solo-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), progress(['NEXT: P04-S03'], '04', [1]));
  let calls = 0;
  const exec = async () => { calls++; return { stdout: '' }; };
  assert.deepStrictEqual(await readLanes(dir, 'Tyler', { exec }), { lanes: [], combined: null });
  assert.deepStrictEqual(await readLanes(path.join(dir, 'missing'), 'Tyler', { exec }), { lanes: [], combined: null });
  assert.strictEqual(calls, 0);
});

test('lanes: a missing git binary → each other lane reads unreadable, never a throw', async () => {
  const { clone } = fixture();
  const r = await readLanes(clone, 'Tyler', { bin: path.join(os.tmpdir(), 'no-such-git-binary') });
  assert.deepStrictEqual(r.lanes.map((l) => [l.lane, l.state]), [['Reno', 'unreadable'], ['Sam', 'unreadable']]);
  assert.deepStrictEqual(r.combined, { plan: 'PLAN-04', done: 2, total: 6 });
});

test('lanes: parsers read the Dashboard total and only ✅ / 👤✅ rows of the plan', () => {
  const text = progress(['NEXT[A]: P04-S01'], '04', [2]) + '| P04-S07 | t | M3 | 👤✅ | |\n| P05-S01 | t | M1 | ✅ | |\n';
  assert.deepStrictEqual(activePlan(text), { nn: '04', total: 6 });
  assert.deepStrictEqual([...doneSteps(text, '04')], ['P04-S02', 'P04-S07']);
});

// P26-S06: the panel text and the refresh guard.
test('lanes: laneView builds each state and the combined count', () => {
  const now = 1700000000000;
  const v = laneView({ lanes: [
    { lane: 'Reno', state: 'found', ref: 'origin/reno/PLAN-04', updatedAt: now - 3 * 3600e3, next: 'P04-S17',
      doneThere: ['P04-S04', 'P04-S05'] },
    { lane: 'Ann', state: 'found', ref: 'origin/ann/x', updatedAt: now - 5 * 60e3, next: 'P04-S02', doneThere: ['P04-S01'] },
    { lane: 'Sam', state: 'no-branch', ref: null, updatedAt: null, next: null, doneThere: [] },
    { lane: 'Kim', state: 'unreadable', ref: null, updatedAt: null, next: null, doneThere: [] },
  ], combined: { plan: 'PLAN-04', done: 9, total: 20 } }, now);
  assert.deepStrictEqual(v.lines.map((l) => [l.text, l.dim]), [
    ["Reno · NEXT P04-S17 · 2 steps done your board doesn't show · updated 3h ago (origin/reno/PLAN-04)", false],
    ["Ann · NEXT P04-S02 · 1 step done your board doesn't show · updated 5m ago (origin/ann/x)", false],
    ['Sam · no branch found', true],
    ["Kim · couldn't read", true],
  ]);
  for (const l of v.lines) assert.strictEqual(l.pre + (l.steps ? l.steps.text : '') + l.post, l.text);
  assert.deepStrictEqual(v.lines[0].steps.ids, ['P04-S04', 'P04-S05'], 'the steps part expands to the ids');
  assert.strictEqual(v.combined, 'PLAN-04: 9/20 across all lanes');
  assert.strictEqual(laneView({ lanes: [], combined: null }).combined, null);
});

test('lanes: one refresh in flight at a time; unlaned posts nothing', async () => {
  const posted = [];
  let reads = 0, release;
  const refresh = laneRefresher((m) => posted.push(m), () => { reads++; return new Promise((r) => { release = r; }); });
  const a = refresh('d', 'Tyler');
  assert.strictEqual(refresh('d', 'Tyler'), a, 'a second call while one is live joins it');
  assert.strictEqual(reads, 1);
  release({ lanes: [{ lane: 'Sam', state: 'no-branch', doneThere: [] }], combined: null });
  await a;
  assert.deepStrictEqual(posted.map((m) => [m.kind, m.lines[0].text]), [['lanes', 'Sam · no branch found']]);
  const b = refresh('d', 'Tyler');
  assert.notStrictEqual(b, a, 'a finished refresh frees the guard');
  assert.strictEqual(reads, 2);
  release({ lanes: [], combined: null });
  await b;
  assert.strictEqual(posted.length, 1, 'unlaned → no message posted');
  await laneRefresher((m) => posted.push(m), () => Promise.reject(new Error('x')))('d', 'T');
  assert.strictEqual(posted.length, 1, 'a failed read neither posts nor rejects');
});

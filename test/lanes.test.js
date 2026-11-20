// P26-S05: src/lanes.js reads the other lanes from pushed branches (CONTRACTS §Lane view).
// One scratch fixture: a bare origin holding Tyler's and Reno's lane branches plus decoys, and
// Tyler's clone of it. Branch ages are pinned with GIT_COMMITTER_DATE so "newest" is deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readLanes, activePlan, doneSteps } = require('../src/lanes');

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

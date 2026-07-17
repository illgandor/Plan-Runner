// Discard-step changes (P06-S06): the runner prefers the SDK file-checkpoint rewind and only
// falls back to `git checkout` when no checkpoint is available (rewind returns falsy/canRewind:
// false, throws, or the engine is Codex). Stdlib-only; stubs the discard seams (rewindFiles /
// stepStartMsgId / gitCheckout) rather than a real session or git repo.
const test = require('node:test');
const assert = require('node:assert');
const { Runner } = require('../src/runner');

function newRunner(extra) {
  const r = new Runner({ id: '/tmp/x', path: '/tmp/x', name: 'tmp', model: 'opus', effort: 'high', mode: 'auto', ...extra });
  r.stepStartMsgId = () => 'msg-uuid';
  let gitCalls = 0;
  r.gitCheckout = () => { gitCalls++; };
  return { r, gits: () => gitCalls };
}

test('rewind succeeds → method checkpoint, git NOT called', async () => {
  const { r, gits } = newRunner();
  r.rewindFiles = async () => ({ canRewind: true, filesChanged: ['a.js', 'b.js'] });
  const res = await r.discardStepChanges();
  assert.equal(res.method, 'checkpoint');
  assert.deepEqual(res.filesChanged, ['a.js', 'b.js']);
  assert.equal(gits(), 0, 'checkpoint success skips the git fallback');
});

test('rewind canRewind:false → git fallback', async () => {
  const { r, gits } = newRunner();
  r.rewindFiles = async () => ({ canRewind: false, error: 'no checkpoints' });
  const res = await r.discardStepChanges();
  assert.equal(res.method, 'git');
  assert.equal(gits(), 1);
});

test('rewind returns null (no live session) → git fallback', async () => {
  const { r, gits } = newRunner();
  r.rewindFiles = async () => null;
  const res = await r.discardStepChanges();
  assert.equal(res.method, 'git');
  assert.equal(gits(), 1);
});

test('rewind throws → git fallback (never propagates)', async () => {
  const { r, gits } = newRunner();
  r.rewindFiles = async () => { throw new Error('SDK too old'); };
  const res = await r.discardStepChanges();
  assert.equal(res.method, 'git');
  assert.equal(gits(), 1);
});

test('Codex engine skips the SDK rewind entirely → git fallback', async () => {
  const { r, gits } = newRunner({ engine: 'codex' });
  let rewound = false;
  r.rewindFiles = async () => { rewound = true; return { canRewind: true }; };
  const res = await r.discardStepChanges();
  assert.equal(res.method, 'git');
  assert.equal(rewound, false, 'Codex has no checkpointing — never call rewindFiles');
  assert.equal(gits(), 1);
});

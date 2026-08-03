// The claim mechanism: one verdict per outcome, decided by exit code + marker and never by the
// rejection prose (four phrasings were observed for one condition). (P18-S01, D-082,
// CONTRACTS §Claims; research 03 §2.2–§2.6)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { take, reclaim, release, holder, claimRef, EMPTY_TREE } = require('../src/claims');

// A fake git: records every argv, and answers per-subcommand. `push` answers throw like
// execFileSync does — non-zero exit, message on stderr.
function fakeGit(answers = {}) {
  const calls = [];
  const exec = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const a = answers[args[0]];
    const v = typeof a === 'function' ? a(args) : a;
    if (v instanceof Error) throw v;
    return v === undefined ? '' : v;
  };
  return { exec, calls };
}
const rejection = (stderr) => Object.assign(new Error('Command failed: git push'), { stderr, status: 1 });

const OPTS = (exec) => ({ exec, now: () => '2026-08-03T12:00:00Z' });

test('a free step is taken: unique parentless commit over the empty tree, pushed with a lease', () => {
  const { exec, calls } = fakeGit({ 'commit-tree': 'fee003a\n', push: ' * [new reference]\n' });
  const r = take('/repo', { step: 'P18-S01', driver: 'tyler', host: 'tylerdesktop' }, OPTS(exec));
  assert.deepStrictEqual(r, { verdict: 'taken', ref: 'refs/claims/P18-S01', sha: 'fee003a', detail: '' });

  const [ct, push] = calls;
  assert.deepStrictEqual(ct.args, ['commit-tree', EMPTY_TREE], 'the empty tree, never a blob (§2.3)');
  assert.match(ct.opts.input, /^claim P18-S01\ndriver: tyler\nhost: tylerdesktop\nts: 2026-08-03T12:00:00Z\n$/,
    'the payload is what makes the object unique — a shared value is stolen by fast-forward (§2.1)');
  assert.deepStrictEqual(push.args,
    ['push', '--force-with-lease=refs/claims/P18-S01:', 'origin', 'fee003a:refs/claims/P18-S01'],
    'empty lease = the ref must not exist (E8b)');
  assert.strictEqual(push.opts.env.GIT_TERMINAL_PROMPT, '0', 'an unattended run never blocks on a prompt');
  assert.ok(push.opts.timeout > 0, 'the timeout is caller-imposed — http.connectTimeout does not bound it (E13b)');
});

// P18-S03, §4.3: the self-reclaim differs from a take in exactly one character — the lease. It is a
// FRESH commit under a lease on the sha just observed, so a claim that changed hands since that read
// is refused (`held`) instead of overwritten. Never the bare `--force` of §4.4.
test('a self-reclaim leases the ref on the sha just observed', () => {
  const { exec, calls } = fakeGit({ 'commit-tree': 'newsha\n', push: '' });
  const r = reclaim('/repo', { step: 'P18-S01', driver: 'tyler', host: 'tylerdesktop' }, 'fee003a', OPTS(exec));
  assert.strictEqual(r.verdict, 'taken');
  assert.deepStrictEqual(calls[1].args,
    ['push', '--force-with-lease=refs/claims/P18-S01:fee003a', 'origin', 'newsha:refs/claims/P18-S01']);
  assert.match(calls[0].opts.input, /^claim P18-S01\n/, 'a fresh payload, so the reclaim is its own object');
});

test('a self-reclaim whose lease is stale is `held`, never a steal', () => {
  const { exec } = fakeGit({ 'commit-tree': 'newsha', push: rejection(' ! [rejected] (stale info)\n') });
  assert.strictEqual(reclaim('/repo', { step: 'P18-S01' }, 'fee003a', OPTS(exec)).verdict, 'held');
});

// §2.4. The parenthetical varies with local ref state, git version and host; the marker does not.
test('all four observed rejection phrasings read `held`', () => {
  for (const line of [
    ' ! [rejected]        fee003a -> refs/claims/P18-S01 (fetch first)',
    ' ! [rejected]        fee003a -> refs/claims/P18-S01 (needs force)',
    ' ! [rejected]        fee003a -> refs/claims/P18-S01 (non-fast-forward)',
    ' ! [rejected]        fee003a -> refs/claims/P18-S01 (stale info)',
  ]) {
    const { exec } = fakeGit({ 'commit-tree': 'fee003a', push: rejection(`${line}\nerror: failed to push some refs\n`) });
    assert.strictEqual(take('/repo', { step: 'P18-S01' }, OPTS(exec)).verdict, 'held', line);
  }
});

test('a remote-side rejection also reads `held`', () => {
  const { exec } = fakeGit({
    'commit-tree': 'fee003a',
    push: rejection('remote: fatal error in commit_refs\n ! [remote rejected] 13ab94e -> refs/claims/P18-S01 (failure)\n'),
  });
  assert.strictEqual(take('/repo', { step: 'P18-S01' }, OPTS(exec)).verdict, 'held');
});

// Exit ≠ 0 with NO marker is infrastructure, not a claim. Calling it `held` would invent another
// driver out of a dead network and stop a solo run for a person who does not exist.
test('offline, auth and a missing origin are `unreachable`, never `held`', () => {
  for (const stderr of [
    "fatal: 'origin' does not appear to be a git repository\n",
    'fatal: could not read Username for https://github.com: terminal prompts disabled\n',
    'ssh: connect to host github.com port 22: Connection timed out\n',
  ]) {
    const { exec } = fakeGit({ 'commit-tree': 'fee003a', push: rejection(stderr) });
    const r = take('/repo', { step: 'P18-S01' }, OPTS(exec));
    assert.strictEqual(r.verdict, 'unreachable', stderr);
    assert.strictEqual(r.detail, stderr, 'the refusal says what it saw (INV-7)');
  }
});

test('a timeout kill is unreachable, and a failed commit-tree never reaches the network', () => {
  const { exec, calls } = fakeGit({ 'commit-tree': Object.assign(new Error('ETIMEDOUT'), { killed: true }) });
  const r = take('/repo', { step: 'P18-S01' }, OPTS(exec));
  assert.strictEqual(r.verdict, 'unreachable');
  assert.strictEqual(r.sha, null);
  assert.deepStrictEqual(calls.map((c) => c.args[0]), ['commit-tree'], 'no push after a local failure');
});

test('take returns exactly one of taken / held / unreachable, always with the ref', () => {
  const cases = [
    [{ push: '' }, 'taken'],
    [{ push: rejection(' ! [rejected] x (fetch first)') }, 'held'],
    [{ push: rejection('fatal: unable to access') }, 'unreachable'],
  ];
  for (const [answers, verdict] of cases) {
    const { exec } = fakeGit({ 'commit-tree': 'fee003a', ...answers });
    const r = take('/repo', { step: 'P18-S01' }, OPTS(exec));
    assert.ok(['taken', 'held', 'unreachable'].includes(r.verdict));
    assert.strictEqual(r.verdict, verdict);
    assert.strictEqual(r.ref, 'refs/claims/P18-S01');
  }
});

test('release push-deletes the ref, and a failed delete is not fatal', () => {
  const { exec, calls } = fakeGit({ push: ' - [deleted]  refs/claims/P18-S01\n' });
  assert.deepStrictEqual(release('/repo', 'P18-S01', { exec }),
    { released: true, ref: 'refs/claims/P18-S01', detail: '' });
  assert.deepStrictEqual(calls[0].args, ['push', 'origin', ':refs/claims/P18-S01']);

  const dead = fakeGit({ push: rejection('fatal: unable to access\n') });
  const r = release('/repo', 'P18-S01', { exec: dead.exec });
  assert.strictEqual(r.released, false, 'degrades to a stale claim (§4.3), never a throw');
});

test('holder names the driver, host and ts from the payload', () => {
  const { exec, calls } = fakeGit({
    'ls-remote': 'fee003ab9c\trefs/claims/P18-S01\n',
    fetch: '',
    'cat-file': 'tree 4b825dc\nauthor a <a@b> 1 +0000\n\nclaim P18-S01\ndriver: reno\nhost: renobox\nts: 2026-08-03T11:00:00Z\n',
  });
  assert.deepStrictEqual(holder('/repo', 'P18-S01', { exec }), {
    step: 'P18-S01', ref: 'refs/claims/P18-S01', sha: 'fee003ab9c',
    driver: 'reno', host: 'renobox', ts: '2026-08-03T11:00:00Z',
  });
  assert.deepStrictEqual(calls[0].args, ['ls-remote', 'origin', 'refs/claims/P18-S01'], 'no fetch to READ (§2.5)');
  assert.deepStrictEqual(calls[1].args,
    ['fetch', '--quiet', 'origin', '+refs/claims/P18-S01:refs/claims/P18-S01'],
    'claim refs are outside the default refspec, so the payload needs the explicit one');
});

test('holder is null when the claim vanished, and survives an unreadable payload', () => {
  const gone = fakeGit({ 'ls-remote': '\n' });
  assert.strictEqual(holder('/repo', 'P18-S01', { exec: gone.exec }), null);

  const dead = fakeGit({ 'ls-remote': Object.assign(new Error('offline'), { stderr: '' }) });
  assert.strictEqual(holder('/repo', 'P18-S01', { exec: dead.exec }), null);

  const partial = fakeGit({ 'ls-remote': 'fee003a\trefs/claims/P18-S01', fetch: new Error('no such ref') });
  assert.deepStrictEqual(holder('/repo', 'P18-S01', { exec: partial.exec }), {
    step: 'P18-S01', ref: 'refs/claims/P18-S01', sha: 'fee003a', driver: null, host: null, ts: null,
  }, 'the sha alone still identifies the claim');
});

// The two structural invariants of the module, asserted the way presence.test.js asserts the
// runner's: by reading the source, so a later step cannot quietly reintroduce either.
test('claims.js requires no vscode, reads nothing from presence, and never passes a bare --force', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'claims.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]vscode['"]\)/, 'pure module (A-P10-02 shape)');
  // Prose may CITE presence (the module header does); no code path may read it (INV-4, D-064).
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /presence/i, 'a claim is decided by git alone');
  for (const hit of code.match(/--force[\w-]*/g) || []) {
    assert.strictEqual(hit, '--force-with-lease', 'a bare --force overwrites another driver (§4.4)');
  }
  assert.strictEqual(claimRef(' P18-S01 '), 'refs/claims/P18-S01');
});

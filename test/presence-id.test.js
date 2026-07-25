// projectId/normalizeRemote give the same id for every spelling of one remote, and null when
// there is no remote — the first "stay dark" condition for presence. (P10-S02, CONTRACTS §Presence)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectId, normalizeRemote } = require('../src/presence-id');

test('SSH and HTTPS forms of the same remote yield the same id', () => {
  const id = 'github.com/illgandor/plan-runner';
  for (const url of [
    'git@github.com:illgandor/Plan-Runner.git',
    'https://github.com/illgandor/Plan-Runner',
    'https://github.com/illgandor/Plan-Runner.git/',
    'ssh://git@github.com:22/illgandor/Plan-Runner.git',
    'https://someone:token@github.com/illgandor/Plan-Runner.git',
  ]) assert.strictEqual(normalizeRemote(url), id, url);
});

test('unrelated repos never collide', () => {
  assert.notStrictEqual(
    normalizeRemote('git@github.com:illgandor/Plan-Runner.git'),
    normalizeRemote('git@gitlab.com:illgandor/Plan-Runner.git'));
  assert.notStrictEqual(
    normalizeRemote('git@github.com:illgandor/Plan-Runner.git'),
    normalizeRemote('git@github.com:someone/Plan-Runner.git'));
});

test('an empty or missing remote is null, not a bogus id', () => {
  for (const bad of ['', '   ', null, undefined]) assert.strictEqual(normalizeRemote(bad), null);
});

test('projectId returns null for a non-git dir and no throw escapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-id-'));
  assert.strictEqual(projectId(dir), null);
});

test('projectId returns null when git itself fails', () => {
  const boom = () => { throw new Error('git: command not found'); };
  assert.strictEqual(projectId(process.cwd(), { exec: boom }), null);
});

test('projectId normalizes what git prints, newline and all', () => {
  const exec = () => 'git@github.com:illgandor/Plan-Runner.git\n';
  assert.strictEqual(projectId('.', { exec }), 'github.com/illgandor/plan-runner');
});

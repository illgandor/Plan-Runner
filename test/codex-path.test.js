// findCodex resolves the codex binary from a hashed install dir, PATH, or override, and
// returns null when absent (so Codex defers, never crashes — D-008). Stdlib-only, spends
// no usage: everything runs against a fake temp dir. (P02-S02)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCodex, EXE } = require('../src/codex-path');

// Build a fake …/OpenAI/Codex install with the exe under one hashed bin subdir.
function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  const binHash = path.join(root, 'OpenAI', 'Codex', 'bin', 'a7c12ebff69fb123');
  fs.mkdirSync(binHash, { recursive: true });
  fs.writeFileSync(path.join(binHash, EXE), '');
  return { root, exe: path.join(binHash, EXE) };
}

test('findCodex resolves the exe under a hashed bin subdir', () => {
  const { root, exe } = fakeInstall();
  const got = findCodex({ env: { LOCALAPPDATA: root, PATH: '' } });
  assert.strictEqual(got, exe);
});

test('PATH takes precedence over the install dir', () => {
  const { root } = fakeInstall();
  const onPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpath-'));
  const exe = path.join(onPath, EXE);
  fs.writeFileSync(exe, '');
  const got = findCodex({ env: { LOCALAPPDATA: root, PATH: onPath } });
  assert.strictEqual(got, exe);
});

test('PLANRUNNER_CODEX override wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexov-'));
  const exe = path.join(dir, EXE);
  fs.writeFileSync(exe, '');
  const got = findCodex({ env: { PLANRUNNER_CODEX: exe, PATH: '' } });
  assert.strictEqual(got, exe);
});

test('returns null when codex is nowhere', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codexnone-'));
  assert.strictEqual(findCodex({ env: { LOCALAPPDATA: empty, PATH: '' } }), null);
});

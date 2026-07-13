// Resolve the `codex` executable. It ships with the OpenAI Codex app, which is NOT on
// PATH; the real binary lives at %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (the
// <hash> subdir is version-keyed, so we glob it). PATH + PLANRUNNER_CODEX override win
// first so a user install or a test fake takes precedence. Returns null if not found —
// callers defer Codex (D-008), never crash. (P02-S02; carryover for the S04 provider.)
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';

// A bin dir may hold the exe directly or under one hashed subdir. Return the first hit.
function findInBin(binDir) {
  const direct = path.join(binDir, EXE);
  if (fs.existsSync(direct)) return direct;
  let entries;
  try { entries = fs.readdirSync(binDir, { withFileTypes: true }); }
  catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = path.join(binDir, e.name, EXE);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function defaultRoots(env) {
  const roots = [];
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex'));
  return roots;
}

// findCodex({env, roots}) — env/roots injectable for tests. Order: override → PATH → install dirs.
function findCodex(opts = {}) {
  const env = opts.env || process.env;
  if (env.PLANRUNNER_CODEX && fs.existsSync(env.PLANRUNNER_CODEX)) return env.PLANRUNNER_CODEX;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, EXE);
    if (fs.existsSync(cand)) return cand;
  }
  for (const root of (opts.roots || defaultRoots(env))) {
    const hit = findInBin(path.join(root, 'bin'));
    if (hit) return hit;
  }
  return null;
}

module.exports = { findCodex, findInBin, EXE };

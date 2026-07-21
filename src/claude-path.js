// Resolve the `claude` executable — symmetric with codex-path.js (D-019). Order:
// PLANRUNNER_CLAUDE override → `claude(.exe)` on PATH → the SDK's bundled binary as a
// last-resort fallback. Returns null only when even the bundle is gone (post-S10 drop),
// so the caller can surface an "install Claude Code" notice instead of starting an
// unrunnable session. env/bundled are injectable so tests never touch the real install.
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
// On Windows an npm-global install is a claude.cmd shim (no claude.exe). Probe .exe across
// ALL PATH dirs first, then .cmd across all — a real .exe anywhere beats a shim anywhere.
const NAMES = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];

// The claude binary the SDK ships in its platform package. require.resolve keeps it correct
// through hoisting/nesting; returns null if the package was dropped from the .vsix (S10).
function bundledPath() {
  try { return require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'); }
  catch { return null; }
}

// findClaude({env, bundled}) — env/bundled injectable for tests. Order: override → PATH → bundled.
function findClaude(opts = {}) {
  const env = opts.env || process.env;
  if (env.PLANRUNNER_CLAUDE && fs.existsSync(env.PLANRUNNER_CLAUDE)) return env.PLANRUNNER_CLAUDE;
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of NAMES) {
    for (const dir of dirs) {
      const cand = path.join(dir, name);
      if (fs.existsSync(cand)) return cand;
    }
  }
  const bundled = opts.bundled !== undefined ? opts.bundled : bundledPath();
  if (bundled && fs.existsSync(bundled)) return bundled;
  return null;
}

module.exports = { findClaude, bundledPath, EXE, NAMES };

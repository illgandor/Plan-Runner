// Bundles the master-plan + next-step skills and installs them into ~/.claude/skills so
// the extension works for anyone — not just people who already set the skills up.
// Ported from the app's src/skill-installer.js; simpler here (no packaged/dev split —
// the .vsix always ships resources/ next to src/). Install-if-missing; never clobbers a
// customized copy unless force is passed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED = ['master-plan', 'next-step']; // next-step runs each step; master-plan sets up / closes out

function sourceDir() { return path.join(__dirname, '..', 'resources', 'skills'); }

// Honor CLAUDE_CONFIG_DIR (Claude Code's own ~/.claude override) so skills land where
// the user's claude actually reads them.
function targetRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'skills');
}

function status() {
  const src = sourceDir(), tgt = targetRoot();
  return REQUIRED.map((name) => ({
    name,
    installed: fs.existsSync(path.join(tgt, name, 'SKILL.md')),
    bundled: fs.existsSync(path.join(src, name, 'SKILL.md')),
  }));
}

// Copy each bundled skill into ~/.claude/skills. force=true overwrites (for updating);
// otherwise an existing skill is kept untouched.
function install({ force = false } = {}) {
  const src = sourceDir(), tgt = targetRoot();
  fs.mkdirSync(tgt, { recursive: true });
  const results = [];
  for (const name of REQUIRED) {
    const from = path.join(src, name), to = path.join(tgt, name);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) { results.push({ name, action: 'missing-source' }); continue; }
    if (fs.existsSync(path.join(to, 'SKILL.md')) && !force) { results.push({ name, action: 'kept' }); continue; }
    fs.cpSync(from, to, { recursive: true });
    results.push({ name, action: force ? 'updated' : 'installed' });
  }
  return results;
}

module.exports = { REQUIRED, status, install, targetRoot, sourceDir };

// Bundles the master-plan + next-step skills and installs them into BOTH engines'
// skill dirs so the extension works for anyone — not just people who already set the
// skills up. Claude reads ~/.claude/skills; Codex reads ~/.codex/skills, and each gets
// its own adapted twin (resources/skills vs resources/skills-codex). Ported from the
// app's src/skill-installer.js; the .vsix always ships resources/ next to src/.
// Install-if-missing; never clobbers a customized copy unless force is passed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED = ['master-plan', 'next-step']; // next-step runs each step; master-plan sets up / closes out

// One entry per engine. src = the bundled twin dir; root = where that engine reads skills.
// Honor each engine's own home override (CLAUDE_CONFIG_DIR / CODEX_HOME) so skills land
// where the user's CLI actually looks.
function platforms() {
  return [
    { engine: 'claude', src: resources('skills'),
      root: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills') },
    { engine: 'codex', src: resources('skills-codex'),
      root: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills') },
  ];
}

function resources(sub) { return path.join(__dirname, '..', 'resources', sub); }

function status() {
  const out = [];
  for (const p of platforms()) {
    for (const name of REQUIRED) {
      out.push({ engine: p.engine, name,
        installed: fs.existsSync(path.join(p.root, name, 'SKILL.md')),
        bundled: fs.existsSync(path.join(p.src, name, 'SKILL.md')) });
    }
  }
  return out;
}

// Copy each bundled skill into every engine's skill dir. force=true overwrites (for
// updating); otherwise an existing skill is kept untouched.
function install({ force = false } = {}) {
  const results = [];
  for (const p of platforms()) {
    fs.mkdirSync(p.root, { recursive: true });
    for (const name of REQUIRED) {
      const from = path.join(p.src, name), to = path.join(p.root, name);
      if (!fs.existsSync(path.join(from, 'SKILL.md'))) { results.push({ engine: p.engine, name, action: 'missing-source' }); continue; }
      if (fs.existsSync(path.join(to, 'SKILL.md')) && !force) { results.push({ engine: p.engine, name, action: 'kept' }); continue; }
      fs.cpSync(from, to, { recursive: true });
      results.push({ engine: p.engine, name, action: force ? 'updated' : 'installed' });
    }
  }
  return results;
}

module.exports = { REQUIRED, status, install, platforms };

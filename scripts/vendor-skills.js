// Vendor the owner's master-plan + next-step skills into the extension so a release
// always ships the current versions. ~/.claude/skills is the ONE master; ~/.codex is
// its adapted twin (kept current by the sync-skills skill). Everything here is a copy:
//   ~/.claude/skills/<name>            -> resources/skills/<name>
//   ~/.codex/skills/<name>             -> resources/skills-codex/<name>
//   master-plan/scripts/plan_check.py  -> planning/tools/plan_check.py   (D-018 copy)
// Wired to npm's `version` hook, so cutting a release cannot ship stale skills.
// Never edit resources/skills/** by hand — edit ~/.claude/skills and re-run this.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REQUIRED } = require('../src/skills');

const repo = path.join(__dirname, '..');
// Same home overrides src/skills.js honors, so this follows a relocated CLI config.
const claudeSkills = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills');
const codexSkills = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');

const jobs = [
  { engine: 'claude', from: claudeSkills, to: path.join(repo, 'resources', 'skills') },
  { engine: 'codex', from: codexSkills, to: path.join(repo, 'resources', 'skills-codex') },
];

let copied = 0;
for (const j of jobs) {
  for (const name of REQUIRED) {
    const src = path.join(j.from, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      console.error(`MISSING: ${j.engine} master ${src} — refusing to vendor a half-set.`);
      process.exit(1);
    }
    const dest = path.join(j.to, name);
    fs.rmSync(dest, { recursive: true, force: true }); // full replace: a deleted file must not survive
    // __pycache__ appears whenever plan_check.py is run from the skill dir — never ship it.
    fs.cpSync(src, dest, { recursive: true, filter: (s) => !s.includes('__pycache__') });
    console.log(`vendored ${j.engine}:${name}`);
    copied++;
  }
}

// planning/tools/ is this repo's own working copy of the checker (gitignored, local
// only) — kept byte-identical to the skill's copy per D-018.
const checker = path.join(claudeSkills, 'master-plan', 'scripts', 'plan_check.py');
const tools = path.join(repo, 'planning', 'tools');
if (fs.existsSync(tools)) {
  fs.copyFileSync(checker, path.join(tools, 'plan_check.py'));
  console.log('vendored planning/tools/plan_check.py');
}

console.log(`${copied} skill tree(s) vendored from the masters.`);

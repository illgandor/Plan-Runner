// P24-S08a — write the adaptive-effort smoke fixture: a two-step, fully tagged, plan_check-green
// master-plan project whose first step refuses to finish on the bottom tier (haiku / luna).
//   node scripts/adaptive-smoke.js <dir>
// Copies test/fixtures/adaptive-smoke/ to <dir>, adds the shipped plan_check.py, records the
// immutability hashes, then `git init` + one commit, and prints the path. <dir> must be empty or
// absent, and outside this repo — it never writes into this working tree.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.join(__dirname, '..');
const template = path.join(repo, 'test', 'fixtures', 'adaptive-smoke');
// The committed vendored copy, so a fresh clone works without ~/.claude (no sixth checker copy).
const checker = path.join(repo, 'resources', 'skills', 'master-plan', 'scripts', 'plan_check.py');

function make(dir) {
  if (!dir) throw new Error('usage: node scripts/adaptive-smoke.js <dir>');
  const out = path.resolve(dir);
  const rel = path.relative(repo, out);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`refusing to write inside this repo: ${out}`);
  }
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`not empty: ${out}`);

  fs.cpSync(template, out, { recursive: true });
  fs.mkdirSync(path.join(out, 'planning', 'tools'), { recursive: true });
  fs.copyFileSync(checker, path.join(out, 'planning', 'tools', 'plan_check.py'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: out, stdio: 'pipe' });
  run('python', ['planning/tools/plan_check.py', '--update-hashes']);
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['add', '-A']);
  // Identity passed inline so this works on a machine (or CI) with no git user configured.
  run('git', ['-c', 'user.name=Plan Runner smoke', '-c', 'user.email=smoke@plan-runner.invalid',
    'commit', '-q', '-m', 'P01: adaptive-effort smoke fixture (generated)']);
  return out;
}

if (require.main === module) {
  try {
    console.log(make(process.argv[2]));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { make };

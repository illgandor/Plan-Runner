// Skill install lands the bundled twins in BOTH engines' skill dirs (P01-S07). We redirect
// each engine's home via its own override (CLAUDE_CONFIG_DIR / CODEX_HOME) into temp dirs so
// the test touches no real ~/.claude or ~/.codex. Stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skills = require('../src/skills');
const { CODEX_CAPS } = require('../src/codex');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-skills-')); }
function withHomes(fn) {
  const claude = tmpHome(), codex = tmpHome();
  const save = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  try { return fn(claude, codex); }
  finally {
    if (save.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = save.c;
    if (save.x === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = save.x;
  }
}
const has = (root, name) => fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'));

test('install lands master-plan + next-step in BOTH ~/.claude and ~/.codex', () => {
  withHomes((claude, codex) => {
    const res = skills.install();
    for (const name of skills.REQUIRED) {
      assert.ok(has(claude, name), `claude missing ${name}`);
      assert.ok(has(codex, name), `codex missing ${name}`);
    }
    // every result is an install (fresh temp homes), tagged by engine
    assert.ok(res.every((r) => r.action === 'installed'), JSON.stringify(res));
    assert.deepStrictEqual([...new Set(res.map((r) => r.engine))].sort(), ['claude', 'codex']);
  });
});

test('the codex twin ships its references/ subtree, not just SKILL.md', () => {
  withHomes((claude, codex) => {
    skills.install();
    assert.ok(fs.existsSync(path.join(codex, 'skills', 'master-plan', 'references')),
      'codex master-plan twin should carry its references/ subtree');
  });
});

test('install-if-missing keeps an existing copy; force overwrites', () => {
  withHomes((claude) => {
    skills.install();
    const f = path.join(claude, 'skills', 'next-step', 'SKILL.md');
    fs.writeFileSync(f, 'CUSTOMIZED');
    skills.install();                       // no force → keep
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'CUSTOMIZED');
    skills.install({ force: true });        // force → overwrite from bundle
    assert.notStrictEqual(fs.readFileSync(f, 'utf8'), 'CUSTOMIZED');
  });
});

test('CODEX_MODELS is refreshed to the gpt-5.6 tier (sol/terra/luna) plus (default)', () => {
  assert.strictEqual(CODEX_CAPS.models[0], '(default)');
  for (const tier of ['sol', 'terra', 'luna']) {
    assert.ok(CODEX_CAPS.models.includes(`gpt-5.6-${tier}`), `missing gpt-5.6-${tier}`);
  }
  // the retired gpt-5 generation is gone from the picker
  assert.ok(!CODEX_CAPS.models.includes('gpt-5-codex') && !CODEX_CAPS.models.includes('gpt-5'));
});

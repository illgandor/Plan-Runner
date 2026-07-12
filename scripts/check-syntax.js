// Syntax gate: `node --check` every src/**/*.js. Exit non-zero on the first failure.
// The cheap per-step gate (planning/reference/GATES.md → `syntax`).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const files = walk(path.join(__dirname, '..', 'src'));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error('SYNTAX FAIL:', f, '\n', String((e.stderr || e.message)));
  }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);

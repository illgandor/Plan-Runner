// P23-S03 (D-099): CONTRACTS.md stopped describing the code in four separate ways and nothing went
// red for a year (PLAN-22's F-07..F-17). This is the guard. It cannot be a plan_check rule — D-068
// bars the checker from opening a source file — so it lives where source files are already read.
//
// It DERIVES the names from CONTRACTS.md and asserts each one exists in the source files that same
// section cites; nothing is hand-copied, because a copied list is just a second thing that drifts.
// A section's own `foo.js` mentions ARE its owning modules, so the mapping needs no table either.
// Four classes, exactly the four that drifted: `{kind:'…'}`/`{type:'…'}` message names, method
// names, the Codex permission tuples, and the `source` enum. Prose is deliberately NOT checked —
// a test asserting "Pause works on both engines" goes red for the wrong reason and gets deleted,
// taking the real assertions with it.
//
// CONTRACTS.md is gitignored (.gitignore:22), so it is ABSENT in a clean clone and in CI. That path
// SKIPS loudly — it must never pass silently and never turn a release red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CONTRACTS = path.join(__dirname, '..', 'planning', 'reference', 'CONTRACTS.md');
const SRC_DIR = path.join(__dirname, '..', 'src');

/** The contract text, or null when the file is absent (clean clone / CI). */
function loadContracts(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** basename -> text, for every .js under src/. */
function loadSrc(dir, into = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) loadSrc(p, into);
    else if (e.name.endsWith('.js')) into.set(e.name, fs.readFileSync(p, 'utf8'));
  }
  return into;
}

/** Split on `## §…` / `### §…`; a section's cited (and existing) .js files are its owning modules. */
function sectionsOf(md, src) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    if (/^#{2,3} §/.test(line)) out.push({ title: line.trim(), text: line });
    else if (out.length) out[out.length - 1].text += `\n${line}`;
  }
  for (const s of out) {
    s.files = [...new Set([...s.text.matchAll(/([A-Za-z0-9_-]+\.js)/g)].map((m) => m[1]))]
      .filter((f) => src.has(f));
  }
  return out;
}

const uniq = (a) => [...new Set(a)];
const codeSpans = (t) => [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const quotedIn = (t) => [...t.matchAll(/'([^']+)'/g)].map((m) => m[1]);

const CLASSES = {
  // {kind:'usage'} / {type:'setSetting'} — the envelope names both sides must agree on.
  message: (t) => uniq([...t.matchAll(/\{\s*(?:kind|type)\s*:\s*'([^']+)'/g)].map((m) => m[1])),
  // `snapshot()`, `runner.pauseManual()`, `preferLargeContext(rows)` — the identifier before the (.
  method: (t) => uniq(codeSpans(t).flatMap((s) => [...s.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))),
  // ['workspace-write', 'on-request', 'auto_review'] — the Codex permission tuples.
  permission: (t) => uniq([...t.matchAll(/\[((?:\s*'[^']+'\s*,)+\s*'[^']+'\s*)\]/g)].flatMap((m) => quotedIn(m[1]))),
  // 'poll'|'event'|null — enum unions.
  enum: (t) => uniq([...t.matchAll(/'[^']+'(?:\s*\|\s*(?:'[^']+'|null))+/g)].flatMap((m) => quotedIn(m[0]))),
};
// A method is a bare identifier in source; the other three are string literals there too.
const needle = (cls, name) => (cls === 'method' ? name : `'${name}'`);

const MD = loadContracts(CONTRACTS);
const SRC = loadSrc(SRC_DIR);
const skip = MD ? false : 'CONTRACTS.md is absent (gitignored — clean clone or CI), nothing to check';

// Always runs: the skip decision itself is asserted, so "absent" can never masquerade as "passed".
test('an absent CONTRACTS.md is detected, not silently treated as empty', () => {
  assert.strictEqual(loadContracts(path.join(SRC_DIR, 'no-such-contracts.md')), null);
  assert.ok(typeof loadContracts(CONTRACTS) === 'string' || skip, 'present → text, absent → a skip reason');
  assert.ok(SRC.size > 0, 'src/ must load — a test with no haystack asserts nothing');
});

test('every §section resolves to the source files it cites', { skip }, () => {
  const sections = sectionsOf(MD, SRC);
  assert.ok(sections.length >= 20, `expected the ~21 §sections, got ${sections.length}`);
  assert.ok(sections.filter((s) => s.files.length).length >= 15, 'most sections must name a module');
});

for (const cls of Object.keys(CLASSES)) {
  test(`CONTRACTS.md names no ${cls} that src/ does not contain`, { skip }, () => {
    const missing = [];
    let checked = 0;
    for (const s of sectionsOf(MD, SRC)) {
      if (!s.files.length) continue;              // no owning module cited → nothing to check against
      for (const name of CLASSES[cls](s.text)) {
        checked++;
        if (!s.files.some((f) => SRC.get(f).includes(needle(cls, name)))) {
          missing.push(`${name} — not in ${s.files.join('/')} (${s.title.split('(')[0].trim()})`);
        }
      }
    }
    assert.ok(checked > 0, `extracted no ${cls} names at all — the regex broke, not the contract`);
    assert.deepStrictEqual(missing, [], `CONTRACTS.md describes ${cls} names the code does not have:\n${missing.join('\n')}`);
  });
}

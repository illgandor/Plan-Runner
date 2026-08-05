// P23-S04 (F-05): PLAN-21 is entirely checker-side and this repo has no Python test harness, so its
// four parallel-lane FAIL rules (research 07 §4.1, F-a..F-d) were proven only by `--selftest`, whose
// row count is corpus-driven and cwd-dependent — a changed N is NOT a regression (PROGRESS.md Facts).
// So this asserts the rule NAMES, never a count.
//
// It reads the TRACKED vendored checker: that copy is the one that ships in the .vsix and the one CI
// runs. planning/tools/plan_check.py is gitignored, so asserting against it would prove nothing in a
// clean clone. A-P14-01: five copies must stay byte-identical, so pinning one pins all five.
//
// The names are sliced out of lane_rules()'s own body, not matched anywhere in the file — the
// --selftest table at the bottom names all four too, and matching that would let the rules be
// deleted while the test stayed green.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHECKER = path.join(
  __dirname, '..', 'resources', 'skills', 'master-plan', 'scripts', 'plan_check.py'
);

// F-a..F-d, in the order lane_rules() emits them.
const LANE_RULES = [
  'lane footprints are disjoint',              // F-a — two lanes touching one file
  "pointer lane is on the board's roster line", // F-b — a lane nobody declared
  'one step, one lane',                        // F-c — both drivers on one step
  'WAIT names a step in the plan',             // F-d — a lane that can never unblock
];

/** lane_rules()'s body: from its `def` to the next top-level `def`. */
function laneRulesBody(src) {
  const start = src.indexOf('def lane_rules(');
  assert.notStrictEqual(start, -1, 'lane_rules() is gone from the shipped checker');
  const end = src.indexOf('\ndef ', start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test('the shipped checker still carries all four parallel-lane FAIL rules', () => {
  const body = laneRulesBody(fs.readFileSync(CHECKER, 'utf8'));
  for (const name of LANE_RULES) {
    assert.ok(body.includes(name), `lane_rules() no longer emits the FAIL "${name}"`);
  }
});

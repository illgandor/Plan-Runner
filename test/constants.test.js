// P09-S11: the plan-boundary prompt must instruct an audit-then-close (D-031). This test
// locks the clause so an accidental edit can't silently drop the audit and go back to
// closing plans blind. Stdlib-only (node:test); constants.js is a pure module.
const test = require('node:test');
const assert = require('node:assert');
const { MASTER_PLAN_PROMPT } = require('../src/constants');

test('MASTER_PLAN_PROMPT audits completed steps before closing', () => {
  assert.match(MASTER_PLAN_PROMPT, /audit/i, 'prompt must tell the close-out to audit the plan');
  assert.match(MASTER_PLAN_PROMPT, /Completion criteria/i, 'audit must spot-check Completion criteria');
  assert.match(MASTER_PLAN_PROMPT, /gap step/i, 'an unmet criterion must file a gap step, not close');
});

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

// P10-S03: the three presence settings must be contributed (so they show in VS Code's Settings UI
// under Plan Runner) AND default to empty — presence ships dark. CONTRACTS §Config keys / §Presence.
test('package.json contributes the presence settings, all defaulting to off', () => {
  const props = require('../package.json').contributes.configuration.properties;
  for (const key of ['planRunner.presenceUrl', 'planRunner.presenceToken', 'planRunner.presenceName']) {
    assert.ok(props[key], `${key} must be contributed`);
    assert.strictEqual(props[key].type, 'string', `${key} is a string`);
    assert.strictEqual(props[key].default, '', `${key} defaults to empty (off)`);
    assert.strictEqual(props[key].scope, 'application', `${key} is global, not workspace-shadowable`);
    assert.ok(props[key].description, `${key} needs a description for the Settings UI`);
  }
});

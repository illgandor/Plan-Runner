// Shared constants — ported verbatim from Plan Runner's src/step-runner.js.
// The step prompt, the auto-allow tool list, and the PROGRESS.md pointer regex are the
// contract between the runner and a master-plan project; keep them identical to v2.

const STEP_PROMPT =
  'Use the next-step skill: execute exactly ONE step of this project\'s master plan ' +
  'end-to-end (verify the gate, implement it, commit, update PROGRESS.md, get ' +
  'plan_check.py to exit 0), then STOP. Do not roll into the following step.';

// Tools the runner may use unattended. Anything outside this ASKS you in the panel
// (see session.makeCanUseTool) instead of auto-denying — that's the "needs you" prompt.
const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(python:*)', 'Bash(python3:*)', 'Bash(py:*)',
  'Bash(cargo:*)', 'Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)',
  'Bash(node:*)', 'Bash(npx:*)', 'Bash(pytest:*)', 'Bash(go:*)',
  'Bash(codex:*)',  // Codex engine runs unattended (P02-S02); driven via `codex exec --json`.
  // Railway MCP auto-allowed so deploy/provision steps run hands-off. Stripe stays gated.
  'mcp__railway',
];

// PROGRESS.md's `NEXT: <step>` line. Advancing = the step is done (the next-step skill
// updates it at close-out). This is the completion signal — not the SDK result alone.
const POINTER_RE = /NEXT:\s*(.+)/;

// Permission modes the loop accepts. No bypassPermissions ever (Plan Runner rule D-013).
const ALLOWED_MODES = ['auto', 'acceptEdits', 'plan', 'manual'];
const DEFAULT_MODE = 'auto';

module.exports = { STEP_PROMPT, ALLOWED_TOOLS, POINTER_RE, ALLOWED_MODES, DEFAULT_MODE };

// Shared constants — ported verbatim from Plan Runner's src/step-runner.js.
// The step prompt, the auto-allow tool list, and the PROGRESS.md pointer regex are the
// contract between the runner and a master-plan project; keep them identical to v2.

const STEP_PROMPT =
  'Use the next-step skill: execute exactly ONE step of this project\'s master plan ' +
  'end-to-end (verify the gate, implement it, commit, update PROGRESS.md, get ' +
  'plan_check.py to exit 0), then STOP. Do not roll into the following step.';

// Codex runs headless (`codex exec`) and tends to end its turn early to "report progress",
// stalling the loop at needs-you before the step is closed out. This suffix makes it run the
// whole step to a pointer-advance in one turn and not bail on harmless sandbox warnings.
const CODEX_STEP_SUFFIX =
  ' Complete the ENTIRE step in THIS turn — implement, commit, and update PROGRESS.md so its ' +
  '`NEXT:` pointer advances, then get plan_check.py to exit 0. Do NOT end your turn until the ' +
  'pointer has advanced. Treat harmless sandbox warnings (e.g. git being unable to read the ' +
  'global ignore/config file) as non-blocking and keep going.';

// Plan-boundary prompt (P02-S08). When PROGRESS.md's pointer reads "PLAN COMPLETE" the
// runner runs this ONCE instead of stopping for the owner: master-plan closes the finished
// plan and, if one is QUEUED, activates it and re-points NEXT at its first step (else NEXT:
// none). The runner then re-reads the pointer and continues or finishes — no owner transition.
const MASTER_PLAN_PROMPT =
  'Use the master-plan skill to close out this completed plan. First audit it: spot-check each ' +
  'completed step\'s Completion criteria against the actual repo, and if any criterion is unmet, ' +
  'record an Amendment and add a gap step (or fix it in-session if trivial) instead of closing. ' +
  'If another plan is QUEUED, activate it as the new ACTIVE plan and point ▶ NEXT STEP at its ' +
  'first step; if no plan remains, set NEXT: none. Then STOP.';

// Tools the runner may use unattended. Anything outside this ASKS you in the panel
// (see session.makeCanUseTool) instead of auto-denying — that's the "needs you" prompt.
const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(python:*)', 'Bash(python3:*)', 'Bash(py:*)',
  'Bash(cargo:*)', 'Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)',
  'Bash(node:*)', 'Bash(npx:*)', 'Bash(pytest:*)', 'Bash(go:*)',
  'Bash(codex:*)',  // Codex engine runs unattended (P02-S02); driven via `codex exec --json`.
  // AskUserQuestion is deliberately NOT allowlisted: this SDK delivers it through canUseTool, and
  // our handler answers it by injecting the picks as updatedInput.answers + rendering the choice
  // card. Auto-allowing it would bypass that handler, so the tool returns with no answer (A-P09-02).
  // Railway MCP auto-allowed so deploy/provision steps run hands-off. Stripe stays gated.
  'mcp__railway',
];

// PROGRESS.md's `NEXT: <step>` line. Advancing = the step is done (the next-step skill
// updates it at close-out). This is the completion signal — not the SDK result alone.
const POINTER_RE = /NEXT:\s*(.+)/;

// Permission modes the loop accepts. No bypassPermissions ever (Plan Runner rule D-013).
const ALLOWED_MODES = ['auto', 'acceptEdits', 'plan', 'manual'];
const DEFAULT_MODE = 'auto';

module.exports = { STEP_PROMPT, CODEX_STEP_SUFFIX, MASTER_PLAN_PROMPT, ALLOWED_TOOLS, POINTER_RE, ALLOWED_MODES, DEFAULT_MODE };

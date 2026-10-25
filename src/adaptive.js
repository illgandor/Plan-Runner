// Adaptive effort (P24-S03) — see planning/reference/CONTRACTS.md §Adaptive effort.
// A step heading that carries BOTH `[model: x]` and `[effort: y]` runs on its own model/effort
// instead of the dropdown (D-103), and steps up one tier at a time before it stops (D-105).
// Pure and vscode-free, like presence-id.js: fs + path only. The runner calls it; it calls nothing.
'use strict';
const fs = require('fs');
const path = require('path');

const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const REASONS = ['errored', 'unfinished', 'stuck'];

// tier → the model id each provider takes (D-104). Codex has no fable, so opus is its top.
const MODELS = {
  claude: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus[1m]', fable: 'fable' },
  codex: { haiku: 'gpt-5.6-luna', sonnet: 'gpt-5.6-terra', opus: 'gpt-5.6-sol', fable: 'gpt-5.6-sol' },
};

const ESCALATE_PROMPT = 'A stronger model is taking over this step. Re-read the step and PROGRESS.md, '
  + 'check what the previous attempt already did (git status, git log), then finish the step and close '
  + 'it out exactly as the next-step skill requires. If it genuinely cannot finish without the owner '
  + '(an owner-only action, a missing credential, an unruled decision), end your turn with a line that '
  + 'starts NEEDS OWNER: and the reason.';

const tag = (line, name) => (new RegExp(`\\[${name}:\\s*([^\\]\\s]+)\\s*\\]`).exec(line) || [])[1];

// The step NEXT names → its heading's tags, or null (untagged, half-tagged, unknown value, no plan,
// two plans, no heading, any error). D-106: the heading line is the only thing it parses.
// `stepId` is the pointer as the runner read it — `P05-S03 — <title>` in a real PROGRESS.md — so
// only its leading id is used (A-P24-03).
function stepTags(cwd, stepId) {
  try {
    const nn = /^(P(\d+)-S\d+[a-z]?)(?![\w-])/.exec(String(stepId || ''));
    if (!nn) return null;
    const dir = path.join(cwd, 'planning', 'plans');
    const plans = fs.readdirSync(dir).filter((f) => f.startsWith(`PLAN-${nn[2]}-`) && f.endsWith('.md'));
    if (plans.length !== 1) return null;
    const head = `#### [${nn[1]}]`;
    const line = fs.readFileSync(path.join(dir, plans[0]), 'utf8').split(/\r?\n/).find((l) => l.startsWith(head));
    if (!line) return null;
    const model = tag(line, 'model');
    const effort = tag(line, 'effort');
    if (!TIERS.includes(model) || !EFFORTS.includes(effort)) return null;
    return { model, effort, ownerGate: tag(line, 'owner-gate') === 'yes' };
  } catch { return null; }
}

// tags → {model, effort} as the engine's provider takes them. Codex has no `max` effort.
function resolve(tags, engine) {
  const effort = engine === 'codex' && tags.effort === 'max' ? 'xhigh' : tags.effort;
  return { model: MODELS[engine === 'codex' ? 'codex' : 'claude'][tags.model], effort };
}

// The next tier whose model actually differs, effort raised to at least `high`; null at the top.
function stepUp(tags, engine) {
  const now = resolve(tags, engine).model;
  const next = TIERS.slice(TIERS.indexOf(tags.model) + 1).find((t) => resolve({ ...tags, model: t }, engine).model !== now);
  if (!next) return null;
  const effort = EFFORTS[Math.max(EFFORTS.indexOf(tags.effort), EFFORTS.indexOf('high'))];
  return { model: next, effort, ownerGate: tags.ownerGate };
}

function escalationRecord(stepId, from, to, reason, at) {
  if (!REASONS.includes(reason)) throw new Error(`unknown escalation reason: ${reason}`);
  return { kind: 'escalation', stepId, from, to, reason, at };
}

// The highest tier this step already escalated to (so a restart resumes there), or null.
function reachedTier(records, stepId) {
  let best = -1;
  for (const r of records || []) {
    if (r && r.kind === 'escalation' && r.stepId === stepId) best = Math.max(best, TIERS.indexOf(r.to));
  }
  return best < 0 ? null : TIERS[best];
}

module.exports = { TIERS, EFFORTS, ESCALATE_PROMPT, stepTags, resolve, stepUp, escalationRecord, reachedTier };

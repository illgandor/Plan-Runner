// Engine dispatcher — picks the provider (Claude or Codex) by engine id and exposes each
// engine's capabilities (CONTRACTS §Engine dispatch). Additive: the Claude provider IS
// today's session.js unchanged, so engine='claude' (the default) behaves byte-for-byte as
// before (D-012). Codex arrives in P02-S04 as src/codex.js, mirroring the same provider
// surface (start/send/interrupt/stop/currentSessionId) + sink events, so callers stay engine-agnostic.

// Claude's capability lists — verbatim from the pre-dispatcher extension.js MODELS/EFFORTS/
// MODES (no change, D-012). The SINGLE source of truth now; extension.js imports these.
// The alias models auto-resolve to the newest version of each family via the user's PATH
// `claude` (not bundled — P06-S10/D-019), so "opus" already means the latest opus without an
// app update. The explicit version ids come from the live CLI at runtime (see mergeClaudeModels).
const CLAUDE_ALIASES = ['(default)', 'fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_CAPS = {
  models: CLAUDE_ALIASES,
  efforts: ['(default)', 'low', 'medium', 'high', 'xhigh', 'max'],
  permissionModes: [
    { value: 'auto', label: 'auto' },
    { value: 'acceptEdits', label: 'acceptEdits' },
    { value: 'plan', label: 'plan' },
    { value: 'manual', label: 'manual' },
  ],
};

// ModelInfo[] (from Query.supportedModels(), reported by the user's own CLI) → a flat list of
// selectable model-id strings: each row's alias `value` AND its explicit `resolvedModel` (e.g.
// 'opus' + 'claude-opus-5-…'), so a new model is pickable/pinnable the moment the CLI knows it.
function claudeModelValues(infos) {
  const out = [];
  for (const m of infos || []) {
    if (!m || !m.value) continue; // a row with no usable id is malformed — skip it wholesale
    out.push(m.value);
    if (m.resolvedModel && m.resolvedModel !== m.value) out.push(m.resolvedModel);
  }
  return out;
}

// Union of the stable aliases with the CLI-discovered ids, deduped, aliases FIRST so the dropdown
// is never empty and today's default path is byte-for-byte preserved when `dynamic` is empty/absent
// (the fail-safe: a failed/old supportedModels() just falls back to the aliases). (P10 model discovery)
function mergeClaudeModels(dynamic) {
  const out = [];
  const seen = new Set();
  for (const v of [...CLAUDE_ALIASES, ...(dynamic || [])]) {
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// provider(id) → the module driving that engine. Lazy require of codex.js so engine.js
// loads before it exists (built in S04); unknown/absent ids default to Claude.
function provider(id) {
  if (id === 'codex') return require('./codex');
  return require('./session');
}

// capabilities(id, dynamicModels?) → { models, efforts, permissionModes:[{value,label}] } for the
// dropdowns. Claude's efforts/modes are the verbatim lists above; its model list is the aliases
// merged with any CLI-discovered ids (dynamicModels, cached by the host). Codex supplies its own (S05).
function capabilities(id, dynamicModels) {
  if (id === 'codex') return require('./codex').codexCaps(); // gated: no auto/acceptEdits on an old CLI (P03-S02)
  return { ...CLAUDE_CAPS, models: mergeClaudeModels(dynamicModels) };
}

module.exports = { provider, capabilities, claudeModelValues, mergeClaudeModels, CLAUDE_CAPS };

// Engine dispatcher — picks the provider (Claude or Codex) by engine id and exposes each
// engine's capabilities (CONTRACTS §Engine dispatch). Additive: the Claude provider IS
// today's session.js unchanged, so engine='claude' (the default) behaves byte-for-byte as
// before (D-012). Codex arrives in P02-S04 as src/codex.js, mirroring the same provider
// surface (start/send/interrupt/stop/currentSessionId) + sink events, so callers stay engine-agnostic.

// Claude's capability lists — verbatim from the pre-dispatcher extension.js MODELS/EFFORTS/
// MODES (no change, D-012). The SINGLE source of truth now; extension.js imports these.
const CLAUDE_CAPS = {
  models: ['(default)', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['(default)', 'low', 'medium', 'high', 'xhigh', 'max'],
  permissionModes: [
    { value: 'auto', label: 'auto' },
    { value: 'acceptEdits', label: 'acceptEdits' },
    { value: 'plan', label: 'plan' },
    { value: 'manual', label: 'manual' },
  ],
};

// provider(id) → the module driving that engine. Lazy require of codex.js so engine.js
// loads before it exists (built in S04); unknown/absent ids default to Claude.
function provider(id) {
  if (id === 'codex') return require('./codex');
  return require('./session');
}

// capabilities(id) → { models, efforts, permissionModes:[{value,label}] } for the dropdowns.
// Claude's are the verbatim lists above; Codex supplies its own (S05).
function capabilities(id) {
  if (id === 'codex') return require('./codex').CODEX_CAPS;
  return CLAUDE_CAPS;
}

module.exports = { provider, capabilities, CLAUDE_CAPS };

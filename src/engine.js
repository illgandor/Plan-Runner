// Engine dispatcher — picks the provider (Claude or Codex) by engine id and exposes each
// engine's capabilities (CONTRACTS §Engine dispatch). Additive: the Claude provider IS
// today's session.js unchanged, so engine='claude' (the default) behaves byte-for-byte as
// before (D-012). Codex arrives in P02-S04 as src/codex.js, mirroring the same provider
// surface (start/send/interrupt/stop/currentSessionId) + sink events, so callers stay engine-agnostic.

// Claude's capability lists — verbatim from the pre-dispatcher extension.js MODELS/EFFORTS/
// MODES (no change, D-012). The SINGLE source of truth now; extension.js imports these.
// The alias models auto-resolve to the newest version of each family via the user's PATH
// `claude` (not bundled — P06-S10/D-019), so "opus" already means the latest opus without an
// app update. Explicit versioned labels come from the live CLI at runtime (see claudeModels).
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

// ModelInfo[] (from Query.supportedModels(), reported by the user's own CLI) → the model dropdown
// items as {value,label} objects: value = the id the SDK accepts, label = the friendly name WITH
// the exact resolved version (e.g. "Opus · claude-opus-5"), so the picker shows the version and a
// newly-released model appears the moment the CLI knows it. `(default)` (omit → CLI picks) stays
// first; the CLI's own "default" row is dropped as redundant. Empty/absent rows → the stable alias
// strings (the fail-safe: a failed/old supportedModels() never empties the dropdown). (P10)
function claudeModels(rows) {
  if (!Array.isArray(rows) || !rows.length) return CLAUDE_ALIASES.slice();
  const out = [{ value: '(default)', label: '(default)' }];
  const seen = new Set(['(default)', 'default']);
  for (const r of rows) {
    if (!r || !r.value || seen.has(r.value)) continue;
    seen.add(r.value);
    const name = r.displayName || r.value;
    out.push({ value: r.value, label: r.resolvedModel ? `${name} · ${r.resolvedModel}` : name });
  }
  return out;
}

// Value strings from a model list that may hold plain-string aliases OR {value,label} objects —
// used host-side to validate/clamp the persisted selection against the current list.
function modelValues(models) {
  return (models || []).map((m) => (typeof m === 'string' ? m : m && m.value)).filter(Boolean);
}

// provider(id) → the module driving that engine. Lazy require of codex.js so engine.js
// loads before it exists (built in S04); unknown/absent ids default to Claude.
function provider(id) {
  if (id === 'codex') return require('./codex');
  return require('./session');
}

// capabilities(id, modelRows?) → { models, efforts, permissionModes:[{value,label}] } for the
// dropdowns. Claude's efforts/modes are the verbatim lists above; its model list is built from the
// CLI's cached supportedModels() rows (versioned labels), or the alias fallback. Codex's = its own (S05).
function capabilities(id, modelRows) {
  if (id === 'codex') return require('./codex').codexCaps(); // gated: no auto/acceptEdits on an old CLI (P03-S02)
  return { ...CLAUDE_CAPS, models: claudeModels(modelRows) };
}

module.exports = { provider, capabilities, claudeModels, modelValues, CLAUDE_CAPS };

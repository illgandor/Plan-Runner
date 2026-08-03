// codexFetch — the Codex half of the usage meter (P16-S07 · CONTRACTS §Usage sources).
//
// Codex exposes no active usage query at all: `/status` is interactive-TUI-only and
// `codex exec --json` carries token counts but no rate limits (openai/codex#15281 is open with no
// maintainer response). What it DOES do is write its limits to disk every turn, so a Codex reading
// is a FILE READ rather than a subprocess — which is also what makes the parse pure enough to test
// against real recorded payloads instead of a live CLI.
//
// The resolved shape is byte-for-byte the one `defaultFetch` resolves (§Usage snapshot), so this
// drops straight into `UsageService`'s existing `fetch` constructor seam at S08. NOTHING wires it
// yet — this step is deliberately inert. Every line here is Codex-only and no line of it can alter
// Claude's poll path (D-074).
const fs = require('fs');
const path = require('path');
const os = require('os');

// Trap 1 (§Usage sources): `primary`/`secondary` are POSITIONAL and swap roles between sessions —
// measured on this box, one file carries the weekly in `primary` and another in `secondary`. The
// meter is therefore chosen by `window_minutes` and NEVER by key position. A window that is neither
// value is ignored, never guessed into a meter. `__proto__: null` so an exotic window_minutes
// (`"constructor"`) can't resolve through the prototype into a truthy non-meter.
const WINDOW_METER = { __proto__: null, 300: 'session', 10080: 'week' };

// Every failure mode — no directory, no rollout file, unreadable file, unparseable lines, no
// `rate_limits`, no recognised window — yields the SAME "no reading" the poll's error path yields.
// UsageService treats `{ error }` as transient: last-good is kept, the meter never blanks, the gate
// never pauses on it. Never a zero (a zero is a claim), never a throw.
const noReading = (why) => ({ error: `codex usage: ${why}` });

// Trap 2 (§Usage sources): `resets_at` is unix SECONDS; the snapshot's clock is epoch ms.
function resetMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
}

// Pure: one rollout file's text → the poll's resolution shape. Scans BACKWARDS so the LAST record
// carrying `rate_limits` wins (a rollout accumulates one per turn; the first is the oldest reading
// in the file). A line that doesn't parse is skipped, not fatal — the final line of a live rollout
// is routinely torn mid-write, and one torn line must not cost the whole reading.
function parseRollout(text) {
  const lines = String(text || '').split('\n');
  let limits = null;
  for (let i = lines.length - 1; i >= 0 && !limits; i--) {
    const line = lines[i];
    if (!line.includes('rate_limits')) continue; // cheap reject; most lines are transcript content
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const r = j && j.payload && j.payload.rate_limits;
    if (r && typeof r === 'object') limits = r;
  }
  if (!limits) return noReading('no rate_limits recorded in the newest rollout');

  const out = { session: null, week: null, fable: null, sessionResetsAt: null, weekResetsAt: null };
  let got = false;
  for (const w of [limits.primary, limits.secondary]) {
    const meter = w && typeof w === 'object' ? WINDOW_METER[w.window_minutes] : null;
    if (!meter || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
    // `used_percent` is USED, not remaining (observed to 13.0) — the same sense as Claude's `%`, so
    // it maps straight across. Rounded only because Claude's readings are whole percents and both
    // engines feed one renderer and one `pct >= limit` comparison.
    out[meter] = Math.round(w.used_percent);
    out[meter === 'session' ? 'sessionResetsAt' : 'weekResetsAt'] = resetMs(w.resets_at);
    got = true;
  }
  // `fable` stays null and no `fableLabel` is returned: there is no per-model window on Codex at all
  // (D-075 — `limit_id` "codex", `limit_name` and `individual_limit` null in 223/223 records), and
  // returning no label leaves UsageService's own `fableLabel` untouched.
  return got ? out : noReading('no 5-hour or weekly window in the newest rollout');
}

// Codex files rollouts under `<y>/<m>/<d>/`, but a session opened yesterday keeps being appended to
// today — so "newest" is mtime, not the path's date. Returns null rather than throwing when the
// tree doesn't exist (a machine that has never run Codex is a normal state, not an error).
async function newestRollout(dir) {
  let names;
  try { names = await fs.promises.readdir(dir, { recursive: true }); } catch { return null; }
  let best = null, bestAt = -1;
  for (const n of names) {
    if (!/(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(n)) continue;
    const file = path.join(dir, n);
    let at;
    try { at = (await fs.promises.stat(file)).mtimeMs; } catch { continue; }
    if (at > bestAt) { bestAt = at; best = file; }
  }
  return best;
}

// The fetcher itself — same signature contract as `defaultFetch`: takes options, resolves a reading
// or an `{ error }`, and never rejects. `sessionsDir` is a test seam only.
// Ceiling: the whole newest file is read to reach its last record. Rollouts are turn logs (a few MB
// at worst) and this runs once per `pollSec`; a tail-read is the upgrade if that ever bites.
async function codexFetch({ home = os.homedir(), sessionsDir } = {}) {
  const dir = sessionsDir || path.join(home, '.codex', 'sessions');
  const file = await newestRollout(dir);
  if (!file) return noReading('no rollout file yet — run one Codex turn');
  try {
    return parseRollout(await fs.promises.readFile(file, 'utf8'));
  } catch (e) {
    return noReading(`cannot read ${path.basename(file)}: ${e.message}`);
  }
}

module.exports = { codexFetch, parseRollout, newestRollout, resetMs, WINDOW_METER };

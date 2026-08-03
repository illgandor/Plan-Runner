// UsageService — one poller for the whole extension. `claude -p "/usage" --output-format
// json` is a FREE local lookup ($0, no model turn), so polling it is cheap. Holds the
// account-wide session/week %, and the StepRunner consults it before starting a NEW step
// (proactive gate). Parsing ported verbatim from the standalone app's src/usage-service.js.
// Snapshot shape is frozen — CONTRACTS §Usage snapshot; do not rename fields.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findClaude } = require('./claude-path');

const SESSION_RE = /Current session:\s*(\d+)%/;
const WEEK_RE = /Current week \(all models\):\s*(\d+)%/;
// The per-model weekly line — today `Current week (Fable): 0% used`. Matched by SHAPE, not by
// the literal name: that line read `(Opus)` before and will read something else again, and a
// name-pinned regex would silently blank the bar the day it changes. `(all models)` is the
// line above, so it's the one alternative excluded.
const MODEL_WEEK_RE = /Current week \((?!all models\))([^)\n]+)\):\s*(\d+)%/;

// Pure parse of a `/usage` result string → percentages. session/week both null when the text
// carries no percentages (e.g. `claude -p` answered conversationally instead of running the
// slash command). `fable` is the per-model weekly and is null whenever that line is absent —
// not every account/plan reports one. Exported so tests can hit fixtures without spawning a
// real claude. NOTE: the poll itself (spawn/env/timeout) is untouched by the model limit —
// this reads one more line of the same answer, nothing more.
function parseUsageText(text) {
  const s = SESSION_RE.exec(text || '');
  const w = WEEK_RE.exec(text || '');
  const m = MODEL_WEEK_RE.exec(text || '');
  return { session: s ? +s[1] : null, week: w ? +w[1] : null,
    fable: m ? +m[2] : null, fableLabel: m ? m[1].trim() : null };
}

// ---- Reset times (P16-S02, CONTRACTS §Usage sources) ------------------------------------
// `/usage` prints the reset clock in the SAME line as the percentage — `Current session: 99%
// used · resets Aug 2, 4:30am` — and it was thrown away. That is how a 3.5 h-stale 99% held a
// run open long after the window had actually reset (S0124): the runner had the right answer
// and read the wrong half. These regexes are deliberately SEPARATE from the percentage ones
// above rather than an added group on them: the percentage parse must stay byte-identical
// (D-072), so a reset clause that fails to match can never disturb a reading that works today.
const SESSION_RESET_RE = /Current session:[^\n]*?resets\s+([^\n]+)/;
const WEEK_RESET_RE = /Current week \(all models\):[^\n]*?resets\s+([^\n]+)/;
const RESET_TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/;   // `4:30am` · `11pm`
const RESET_DATE_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// `Aug 2, 4:30am (America/New_York)` → epoch ms. The text is a LOCAL clock reading with no
// year, so it is built in local time (the zone the CLI names is the account's, which on this
// box is the box's) and the year is inferred as whichever one lands nearest `now` — the only
// thing that survives a Dec→Jan rollover. A shape this doesn't recognise returns null WITH the
// percentage untouched: per §Usage sources a wrong timestamp is worse than none. A time in the
// past is returned as-is — that is the S0124 signal, not an error to correct.
function parseResetAt(text, now = Date.now()) {
  const t = RESET_TIME_RE.exec(String(text || '').toLowerCase());
  if (!t || +t[1] > 12) return null;
  const min = t[2] ? +t[2] : 0;
  const hour = (+t[1] % 12) + (t[3] === 'pm' ? 12 : 0);
  if (min > 59) return null;
  const base = new Date(now);
  const d = RESET_DATE_RE.exec(String(text || '').toLowerCase());
  const mon = d ? MONTHS.indexOf(d[1]) : base.getMonth();
  const day = d ? +d[2] : base.getDate();
  const out = new Date(base.getFullYear(), mon, day, hour, min);
  // A date JS silently rolled over (Feb 31 → Mar 3) is a wrong timestamp, not a date.
  if (out.getMonth() !== mon || out.getDate() !== day) return null;
  const HALF_YEAR = 182 * 864e5;
  if (out.getTime() - now > HALF_YEAR) out.setFullYear(out.getFullYear() - 1);
  else if (now - out.getTime() > HALF_YEAR) out.setFullYear(out.getFullYear() + 1);
  return out.getTime();
}

// Pure parse of a `/usage` result string → the two reset clocks, both nullable. Kept apart from
// parseUsageText so the two halves of a line fail independently.
function parseResets(text, now = Date.now()) {
  const s = SESSION_RESET_RE.exec(text || '');
  const w = WEEK_RESET_RE.exec(text || '');
  return {
    sessionResetsAt: s ? parseResetAt(s[1], now) : null,
    weekResetsAt: w ? parseResetAt(w[1], now) : null,
  };
}

// The reset clock as the panel says it (P16-S03, D-076): "resets in 42m". Pure, so it is unit-
// tested without a webview, and engine-agnostic by construction — it reads only the snapshot's
// epoch ms, so Codex gets the same string free at S08. A null clock renders NOTHING (never
// "unknown", never a zero clock); a reset already in the past is the S0124 signal, said plainly.
function resetText(at, now = Date.now()) {
  if (at == null) return '';
  const ms = at - now;
  if (ms <= 0) return 'reset due';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'resets in <1m';
  if (min < 60) return `resets in ${min}m`;
  const hr = Math.round(min / 60);
  return hr < 48 ? `resets in ${hr}h` : `resets in ${Math.round(hr / 24)}d`;
}

// Each `claude -p /usage` spawns a throwaway Claude Code session that gets saved as a
// transcript — polling every minute floods ~/.claude/projects (and the VS Code session
// list) with hundreds of them. The JSON output carries the session_id, so delete that one
// transcript after the poll. Best-effort + precise (matches the exact UUID), so it can only
// ever remove the poll's own session, never a real one.
function cleanupUsageSession(sessionId) {
  if (!sessionId || !/^[0-9a-f-]{16,}$/i.test(sessionId)) return;
  try {
    const base = path.join(os.homedir(), '.claude', 'projects');
    for (const dir of fs.readdirSync(base)) {
      const f = path.join(base, dir, sessionId + '.jsonl');
      if (fs.existsSync(f)) { fs.unlinkSync(f); return; }
    }
  } catch { /* best-effort */ }
}

// Build the spawn form for the resolved claude path. A Windows npm-global install is a
// claude.cmd shim (P09-S06): a .cmd/.bat can't be exec'd directly, so route it through the
// shell (Node runs it via cmd.exe) with the path quoted for spaces. A real .exe/binary is
// spawned directly. Pure + exported so a unit test verifies the form without a live claude.
function spawnArgs(claude) {
  const args = ['-p', '/usage', '--output-format', 'json'];
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
  if (/\.(cmd|bat)$/i.test(claude)) return { command: `"${claude}"`, args, options: { ...opts, shell: true } };
  return { command: claude, args, options: opts };
}

const FETCH_TIMEOUT_MS = 45000; // a poll that outlives this is wedged, not slow — kill it (S0108)

// The extension host's environment is not a safe place to run an ACCOUNT-wide lookup from. The
// SDK mutates it (it sets CLAUDE_CODE_SESSION_ACCESS_TOKEN on session start), VS Code adds its
// own, and something in there makes `/usage` answer with `/cost` output ("Total cost: $0.0000 …")
// which carries no percentages at all — the meter then reads "unavailable" for the life of the
// window. Stripping single suspects chased that for a while and never caught it.
//
// So this is an ALLOWLIST, not a denylist: the poll runs in the environment a `/usage` lookup
// actually needs and nothing else. Verified — the same command under exactly this env returns the
// real subscription report, while the host's full env does not. Proxy and CA vars are kept
// because dropping them would break the lookup on a corporate network, and CLAUDE_CONFIG_DIR
// because that is where the account's own credentials live when it is relocated.
// Pure + exported so the shape of the child env is a unit test, not a claim.
const POLL_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CLAUDE_CONFIG_DIR',                                        // relocated ~/.claude
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', // corporate networks
];
function pollEnv(env = process.env) {
  const want = new Set(POLL_ENV_KEYS.map((k) => k.toLowerCase()));
  const out = {};
  // Windows env names are case-insensitive and Node preserves whatever case the host used, so
  // match on the lowercased name and pass the key through with its original spelling.
  for (const [k, v] of Object.entries(env)) if (want.has(k.toLowerCase())) out[k] = v;
  return out;
}

// One real /usage call. stdin is closed ('ignore') to avoid the "no stdin data
// received in 3s" stall the prototype hit calling claude non-interactively.
//
// Three things here are load-bearing for the meter and were each a way to lose it silently:
//   1. A hard timeout + kill. Without it a child that never exits leaves the promise unresolved
//      forever — _tick never re-arms and the meter is dead for the life of the window, with no
//      error to show for it.
//   2. stderr is DRAINED. It is piped, so an unread pipe fills and blocks the child mid-write —
//      the same permanent wedge, reachable whenever claude has anything chatty to say.
//   3. An explicit cwd. The extension host's cwd is whatever launched VS Code (often a system
//      dir); /usage is account-wide, so pin it to the home dir and remove the variable.
// `spawnFn` is a test seam only — the wedge/kill path must be provable without spawning a
// real claude (and CI has none installed).
function defaultFetch({ timeoutMs = FETCH_TIMEOUT_MS, spawnFn = spawn, claudePath } = {}) {
  return new Promise((resolve) => {
    const claude = claudePath !== undefined ? claudePath : findClaude(); // env → PATH → bundle (D-019)
    if (!claude) return resolve({ error: 'claude not found on PATH' }); // keeps last-good; never spawns null
    let out = '', err = '', timer = null, done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    let p;
    const { command, args, options } = spawnArgs(claude);
    try { p = spawnFn(command, args, { ...options, cwd: os.homedir(), env: pollEnv() }); }
    catch (e) { return finish({ error: e.message }); }
    timer = setTimeout(() => {
      try { p.kill(); } catch { /* already gone */ }
      finish({ error: `no answer from \`claude -p /usage\` in ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; }); // MUST read it — see (2) above
    p.on('error', (e) => finish({ error: e.message }));
    p.on('close', (code) => {
      try {
        const j = JSON.parse(out);
        cleanupUsageSession(j.session_id); // don't leave a transcript behind for a free poll
        const parsed = parseUsageText(j.result || '');
        Object.assign(parsed, parseResets(j.result || '')); // the other half of the same lines
        // The poll can succeed, parse, and still carry no percentages — `/usage` has been observed
        // answering with `/cost` output ("Total cost: $0.0000 …") instead of the subscription
        // report. That used to surface as a bare "unavailable this check", which says nothing and
        // cost a long diagnosis. Carry the first line so the panel names what actually came back.
        if (parsed.session == null && parsed.week == null) {
          parsed.raw = String(j.result || '').trim().split('\n').map((l) => l.trim())
            .filter(Boolean)[0]?.slice(0, 120) || '';
        }
        finish(parsed);
      } catch (e) {
        // Name what actually happened — exit code and the first line of stderr — so a broken
        // meter is diagnosable from the panel instead of just showing a dash.
        const why = err.trim().split('\n')[0] || (out.trim() ? e.message : 'no output');
        finish({ error: `claude -p /usage failed (exit ${code}): ${why.slice(0, 160)}` });
      }
    });
  });
}

// The per-model weekly limit binds only a run that USES that model: a Fable week at 100% is no
// reason to hold an Opus run. `model` is the run's EFFECTIVE model — an alias ('fable') or a
// versioned id ('claude-fable-5[1m]') — and `label` is whatever /usage named ('Fable'), so a
// substring match covers both spellings without a name list to keep up to date.
function usesModel(model, label) {
  if (!model || !label) return false;
  return String(model).toLowerCase().includes(String(label).toLowerCase());
}

class UsageService extends EventEmitter {
  constructor({ threshold = 90, weekThreshold = 90, fableThreshold = 90, pollSec = 60, fetch = defaultFetch } = {}) {
    super();
    this.threshold = threshold;           // session limit %
    this.weekThreshold = weekThreshold;   // weekly (all models) limit %
    this.fableThreshold = fableThreshold; // per-model weekly limit % (model-scoped, see usesModel)
    this.pollSec = pollSec;
    this.fetch = fetch;
    this.session = null;
    this.week = null;
    this.sessionResetsAt = null; // epoch ms; travels with its percentage, never last-good on its own
    this.weekResetsAt = null;
    this.fable = null;
    this.fableLabel = 'Fable'; // replaced by whatever /usage names on the first reading
    this.max = null;
    this.checked = null;
    this.error = null;
    this._timer = null;
    this._inFlight = false; // a poll is awaiting fetch() right now
    this.stopped = false;   // stop() ran — an in-flight poll must not emit or re-arm
  }

  // Guarded against a leaked/double poller on engine-switch: don't start a second loop if one
  // is already armed or in flight, and don't let a poll that resolves after stop() re-arm.
  start() { this.stopped = false; if (this._timer == null && !this._inFlight) this._tick(); }
  stop() { this.stopped = true; clearTimeout(this._timer); this._timer = null; }

  async _tick() {
    this.stopped = false; // a fresh tick (start or self-reschedule) is live until stop() says otherwise
    this._inFlight = true;
    // A fetch() that REJECTS would otherwise escape here, leaving _inFlight stuck true — start()
    // then refuses to re-arm and the poller is dead until the window reloads. Never let it throw.
    let r;
    try { r = await this.fetch(); } catch (e) { r = { error: String((e && e.message) || e) }; }
    this._inFlight = false;
    if (this.stopped) return; // stop() ran while this poll was in flight — don't emit or re-arm
    if (r.error) {
      this.error = r.error; // transient spawn/parse error — keep last-known session/week
    } else if (r.session == null && r.week == null) {
      // `/usage` returned no percentages this poll (claude -p sometimes doesn't run
      // the slash command). KEEP the last-known-good values instead of blanking the
      // bar — this is the fix for the meter flickering to empty and back.
      this.error = r.raw ? `usage unavailable this check — /usage answered: ${r.raw}`
        : 'usage unavailable this check';
    } else {
      // A reset clock is bound to the reading that carried it: a good percentage whose line has
      // no `resets …` clause clears it to null ("not known", which changes nothing) rather than
      // keeping a clock from the PREVIOUS window, which would be a confidently wrong timestamp.
      if (r.session != null) { this.session = r.session; this.sessionResetsAt = r.sessionResetsAt ?? null; }
      if (r.week != null) { this.week = r.week; this.weekResetsAt = r.weekResetsAt ?? null; }
      // Same last-good rule for the model week. A poll is judged empty on session/week ONLY
      // (above) — an account that reports no per-model line is not a broken reading.
      if (r.fable != null) this.fable = r.fable;
      if (r.fableLabel) this.fableLabel = r.fableLabel;
      const vals = [this.session, this.week].filter((v) => v != null);
      this.max = vals.length ? Math.max(...vals) : null;
      this.checked = Date.now();
      this.error = null;
    }
    this.emit('update', this.snapshot());
    this._timer = setTimeout(() => this._tick(), Math.max(10, this.pollSec) * 1000);
  }

  // `max` stays session/week only (§Usage snapshot): the model week is gated per-run, so folding
  // it in here would make one account-wide number mean different things in different windows.
  snapshot() {
    return { session: this.session, week: this.week, fable: this.fable, fableLabel: this.fableLabel,
      sessionResetsAt: this.sessionResetsAt, weekResetsAt: this.weekResetsAt, // P16-S02: carried, read by nobody yet
      max: this.max, checked: this.checked, error: this.error, threshold: this.threshold,
      weekThreshold: this.weekThreshold, fableThreshold: this.fableThreshold, pollSec: this.pollSec };
  }

  setConfig({ threshold, weekThreshold, fableThreshold, pollSec }) {
    if (threshold != null) this.threshold = threshold;
    if (weekThreshold != null) this.weekThreshold = weekThreshold;
    if (fableThreshold != null) this.fableThreshold = fableThreshold;
    const changed = pollSec != null && pollSec !== this.pollSec;
    if (pollSec != null) this.pollSec = pollSec;
    // Re-arm a pending timer on the NEW cadence — otherwise dropping the poll to 10s to watch a
    // broken meter still waits out the old hour-long delay before anything happens.
    if (changed && this._timer != null) {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._tick(), Math.max(10, this.pollSec) * 1000);
    }
    this.emit('update', this.snapshot());
  }

  // Every meter that is at/over ITS OWN limit, for the run's model. Each limit pauses the same
  // way, so being over is "any of them" — and being clear is therefore "all of them", which is
  // what makes a session reset NOT release a weekly hold. A null reading is never over (§Usage
  // snapshot null-safe rule): the gate pauses on a number, never on a missing one.
  breaches(model) {
    const rows = [
      { name: 'session', pct: this.session, limit: this.threshold },
      { name: 'weekly', pct: this.week, limit: this.weekThreshold },
    ];
    if (usesModel(model, this.fableLabel))
      rows.push({ name: `weekly ${this.fableLabel}`, pct: this.fable, limit: this.fableThreshold });
    return rows.filter((r) => r.pct != null && r.limit != null && r.pct >= r.limit);
  }

  // The gate StepRunner consults before starting a step and on every poll. `model` is the run's
  // effective model — omit it and the model-scoped limit simply doesn't apply.
  isOverThreshold(model) { return this.breaches(model).length > 0; }
  describe(model) { return this.breaches(model).map((r) => `${r.name} usage ${r.pct}% ≥ ${r.limit}%`).join(' · '); }
}

module.exports = {
  UsageService, defaultFetch, cleanupUsageSession, parseUsageText, parseResets, parseResetAt, resetText,
  spawnArgs, pollEnv, usesModel, FETCH_TIMEOUT_MS,
};

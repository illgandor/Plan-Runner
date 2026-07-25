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

// Pure parse of a `/usage` result string → percentages. Both null when the text carries
// no percentages (e.g. `claude -p` answered conversationally instead of running the slash
// command). Exported so tests can hit fixtures without spawning a real claude.
function parseUsageText(text) {
  const s = SESSION_RE.exec(text || '');
  const w = WEEK_RE.exec(text || '');
  return { session: s ? +s[1] : null, week: w ? +w[1] : null };
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
    try { p = spawnFn(command, args, { ...options, cwd: os.homedir() }); }
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
        finish(parseUsageText(j.result || ''));
      } catch (e) {
        // Name what actually happened — exit code and the first line of stderr — so a broken
        // meter is diagnosable from the panel instead of just showing a dash.
        const why = err.trim().split('\n')[0] || (out.trim() ? e.message : 'no output');
        finish({ error: `claude -p /usage failed (exit ${code}): ${why.slice(0, 160)}` });
      }
    });
  });
}

class UsageService extends EventEmitter {
  constructor({ threshold = 90, pollSec = 60, fetch = defaultFetch } = {}) {
    super();
    this.threshold = threshold;
    this.pollSec = pollSec;
    this.fetch = fetch;
    this.session = null;
    this.week = null;
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
      this.error = 'usage unavailable this check';
    } else {
      if (r.session != null) this.session = r.session;
      if (r.week != null) this.week = r.week;
      const vals = [this.session, this.week].filter((v) => v != null);
      this.max = vals.length ? Math.max(...vals) : null;
      this.checked = Date.now();
      this.error = null;
    }
    this.emit('update', this.snapshot());
    this._timer = setTimeout(() => this._tick(), Math.max(10, this.pollSec) * 1000);
  }

  snapshot() {
    return { session: this.session, week: this.week, max: this.max, checked: this.checked, error: this.error, threshold: this.threshold, pollSec: this.pollSec };
  }

  setConfig({ threshold, pollSec }) {
    if (threshold != null) this.threshold = threshold;
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

  // The proactive gate StepRunner consults before starting a step.
  isOverThreshold() { return this.max != null && this.max >= this.threshold; }
  describe() { return `Paused: account usage ${this.max}% ≥ ${this.threshold}% — waiting for it to drop`; }
}

module.exports = { UsageService, defaultFetch, cleanupUsageSession, parseUsageText, spawnArgs, FETCH_TIMEOUT_MS };

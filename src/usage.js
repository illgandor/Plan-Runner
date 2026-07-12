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

const CLAUDE = process.env.PLANRUNNER_CLAUDE || (process.platform === 'win32' ? 'claude.exe' : 'claude');
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

// One real /usage call. stdin is closed ('ignore') to avoid the "no stdin data
// received in 3s" stall the prototype hit calling claude non-interactively.
function defaultFetch() {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(CLAUDE, ['-p', '/usage', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: e.message }); }
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        cleanupUsageSession(j.session_id); // don't leave a transcript behind for a free poll
        resolve(parseUsageText(j.result || ''));
      } catch (e) { resolve({ error: 'usage parse failed: ' + e.message }); }
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
  }

  start() { if (!this._timer) this._tick(); }
  stop() { clearTimeout(this._timer); this._timer = null; }

  async _tick() {
    const r = await this.fetch();
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
    if (pollSec != null) this.pollSec = pollSec;
    this.emit('update', this.snapshot());
  }

  // The proactive gate StepRunner consults before starting a step.
  isOverThreshold() { return this.max != null && this.max >= this.threshold; }
  describe() { return `Paused: account usage ${this.max}% ≥ ${this.threshold}% — waiting for it to drop`; }
}

module.exports = { UsageService, defaultFetch, cleanupUsageSession, parseUsageText };

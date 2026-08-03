// Runner — the autonomous loop, distilled from Plan Runner's src/step-runner.js.
// One loop per workspace. Runs one FRESH SDK session per step until the plan completes
// or a step needs you. The pty-era finalize/idle machinery is intentionally dropped:
// with the SDK, a `result` message means the turn (incl. close-out) is fully done, so the
// only signals we need are (1) result/error = turn ended, (2) PROGRESS.md's NEXT pointer.
//
//   turn ended + pointer ADVANCED   -> step done  -> teardown -> fresh session, next step
//   turn ended + pointer UNCHANGED  -> needs you   -> keep session ALIVE, wait for answer
//
// Usage gate (P01-S08): account usage crossing the threshold pauses WITHIN a step —
// between steps we don't START one (proactive gate, ported from the app); mid-turn we
// interrupt the live turn, remember its session id, and resume the SAME step when usage
// drops back under. The gate is driven by UsageService 'update' events (onUsageUpdate).
//
// A generation counter invalidates stale callbacks from a torn-down step.
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { STEP_PROMPT, CODEX_STEP_SUFFIX, MASTER_PLAN_PROMPT } = require('./constants');
const { readPointer } = require('./progress');
const session = require('./session');
const engine = require('./engine');

// Handoff guard between steps: a step is only closed out if its work is COMMITTED and (when
// there's an upstream) PUSHED — the next-step skill does both at close-out. If the tree is
// dirty or the branch is ahead, the session skipped/failed close-out; we must NOT advance
// past stranded work (that's how P02-S05 got lost). Returns { clean, pushed }; a non-git repo
// or no-upstream never blocks. Injected on the Runner so tests can stub it.
function gitState(cwd, { fetch = true } = {}) {
  const git = (args, opts) => execFileSync('git', args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  try {
    const clean = git(['status', '--porcelain']) === '';
    // Refresh the remote-tracking ref so `behind` reflects the remote NOW, not whenever someone
    // last fetched. Never prompt for credentials (an unattended run must not block on a password
    // dialog) and never hang the extension host on a dead network — a failed fetch just falls
    // through to the last-known upstream ref, which can only make us MISS staleness, never invent it.
    if (fetch) {
      try {
        git(['fetch', '--quiet'],
          { timeout: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      } catch { /* offline / no remote / auth needed → don't block the loop */ }
    }
    let pushed = true, behind = false;
    try {
      pushed = git(['rev-list', '--count', '@{u}..HEAD']) === '0';
      behind = git(['rev-list', '--count', 'HEAD..@{u}']) !== '0';
    } catch { pushed = true; behind = false; } // no upstream → n/a
    return { clean, pushed, behind };
  } catch { return { clean: true, pushed: true, behind: false }; } // not a git repo → don't block
}

const FETCH_TIMEOUT_MS = 20000; // a freshness fetch may not stall the loop on a bad network

// Per-step run ledger (P05-S07, D-017): append one JSON line per completed step to
// <cwd>/.plan-runner/runs.jsonl so "what did it do while I slept?" survives session teardown.
// Best-effort — a write failure is swallowed and never blocks or delays the loop. Exported
// for the runner method + tests. The dir self-ignores (see below), so it never dirties the tree.
function appendLedger(cwd, record) {
  try {
    const dir = path.join(cwd, '.plan-runner');
    fs.mkdirSync(dir, { recursive: true });
    // Self-ignoring dir: keeps the ledger out of `git status` without editing the
    // project's own .gitignore. A dirty tree at step start now stops next-step's
    // crash-recovery guard, so scratch logs must never be what dirties it.
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify(record) + '\n');
  } catch { /* best-effort: a ledger write never affects the run */ }
}

// Read the run ledger back (best-effort inverse of appendLedger). Returns parsed records in append
// order; a torn/garbled line is skipped and any read failure (missing file, unreadable) yields []
// — the ledger is best-effort (D-017), so a caller can never be errored by it. Feeds buildDigest.
function readLedger(cwd) {
  try {
    const out = [];
    for (const line of fs.readFileSync(path.join(cwd, '.plan-runner', 'runs.jsonl'), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip one torn line, keep the rest */ }
    }
    return out;
  } catch { return []; }
}

// Morning digest (P09-S16): roll a finished run's ledger records into one line — "what did it do
// while I slept?" — without opening runs.jsonl. Keeps only records whose step started at/after the
// run's start (sinceMs, append order is already chronological). Pure + exported for tests; no
// in-window records → null so the caller posts nothing.
function buildDigest(records, sinceMs) {
  const rows = (records || []).filter((r) =>
    r && !Number.isNaN(Date.parse(r.startedAt)) && Date.parse(r.startedAt) >= sinceMs);
  if (!rows.length) return null;
  const tokens = rows.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
  const first = rows[0].stepId, last = rows[rows.length - 1].stepId;
  const span = first === last ? `${first}` : `${first} → ${last}`;
  const endMs = Math.max(...rows.map((r) => Date.parse(r.endedAt) || Date.parse(r.startedAt)));
  const mins = Math.max(0, Math.round((endMs - Date.parse(rows[0].startedAt)) / 60000));
  const wall = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return `Run digest: ${rows.length} step${rows.length === 1 ? '' : 's'} (${span}) · ` +
    `${tokens} tokens · ${wall} wall`;
}

// Optional wall-clock ceiling (planRunner.stopAtTime, "HH:MM"). Pure so it's testable with an
// injected clock. The reference is the RUN's start time: the target is today's HH:MM, or the next
// day's if that's already at/before the run started (so an overnight "stop at 06:00" works). Empty
// or malformed → never stops. (D-016: default OFF.)
function stopTimeReached(startedAtMs, nowMs, hhmm) {
  if (!hhmm) return false;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm).trim());
  if (!m) return false;
  const t = new Date(startedAtMs);
  t.setHours(+m[1], +m[2], 0, 0);
  let target = t.getTime();
  if (target <= startedAtMs) target += 86400000; // already past at run start → next occurrence
  return nowMs >= target;
}

const MAX_STEPS = 200; // hard safety cap per ON run
// P05-S05: an error turn-end tears down the session (session.js deletes it), so it's not the
// same "Claude is waiting on you" as a clean result that didn't advance the pointer. A transient
// error (network blip, SDK crash) retries the SAME step in a FRESH session up to MAX_RETRIES with
// a short linear backoff; only after that do we drop to a needs-you flagged "errored".
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 3000; // per-attempt backoff base (× attempt#); overridable in tests
// After a step's turn ends AND the NEXT pointer advanced, the session may still be closing
// out (commit → push → the "what I did" summary). Wait for this long of NO further activity
// before teardown+advance, so an in-flight close-out isn't cut off and the summary stays on
// screen for you. Any session message resets the timer; 0 disables (advance immediately).
// Restored from the standalone's pty FINALIZE_IDLE_MS (2 min) for the SDK loop.
const FINALIZE_MS = 120000;
// Resume prompt: must NOT re-run finished work (Carryover) — resume re-enters the same
// SDK session (options.resume), so its full history is already loaded.
const RESUME_PROMPT =
  'Usage has reset — continue the current step exactly where you left off. Do NOT restart or ' +
  'redo work already completed; pick up from your last action.';

class Runner extends EventEmitter {
  // project: { id, path, name, model, effort, mode }
  constructor(project) {
    super();
    this.project = project;
    this.running = false;
    this.stopRequested = false;
    this.needsYou = false;
    this.currentStep = null;
    this.stepsRun = 0;
    this._gen = 0;
    this.usageGate = null;   // { isOverThreshold() } — set by the extension (UsageService)
    this.paused = false;     // held on the usage gate (between-steps OR mid-turn)
    this.manualPause = false; // owner-set hold (either engine, D-077) — usage gate won't auto-resume it
    this.gating = false;     // true = between-steps hold (no live session yet)
    this._turnLive = false;  // true only while a step's turn is actively streaming
    this._resumeId = null;   // session id captured at pause, replayed on resume
    this.finalizeMs = FINALIZE_MS; // settle window before advancing to the next step (0 = off)
    this.finalizing = false; // true during the post-advance quiet window (session kept alive)
    this._finalizeTimer = null;
    this.stallMs = 0;        // live-turn silence watchdog (planRunner.stallNotifySeconds×1000); 0 = off
    this._stallTimer = null; // notify-only (D-030): never kills/alters the turn
    this._planSession = false; // true while the master-plan (PLAN COMPLETE) session is live (P02-S08)
    this._advancedPlan = false; // guards master-plan to once per PLAN COMPLETE (a 2nd unchanged → finish)
    this.gitCheck = gitState;  // handoff guard; overridable in tests
    this.now = () => Date.now(); // wall clock for the stop-at-time ceiling; overridable in tests
    this._startedAtMs = 0;       // run start; reference for stopAtTime (set in start())
    this._retries = 0;           // error-retry attempts spent on the current step (reset per step)
    this.retryBackoffMs = RETRY_BACKOFF_MS; // per-attempt backoff base; overridable in tests
    this._retryTimer = null;
    this._stepStartedAtMs = 0;   // wall-clock the current step first started (survives retries)
    this._lastResult = null;     // last `result` msg of the current step → ledger tokens/turns/cost
    this.appendLedger = appendLedger; // per-step run ledger writer; overridable in tests
  }
  get id() { return this.project.id; }
  // The provider for the project's engine (default 'claude'); lifecycle calls route here
  // so selecting Codex (S06) drives it instead, with no other runner change (§Engine dispatch).
  get _provider() { return engine.provider(this.project.engine || 'claude'); }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.stepsRun = 0;
    this._startedAtMs = this.now();
    this._runNext();
  }

  // Graceful stop (D-022): finish the current step, THEN halt at the boundary — restores the
  // standalone/PLAN.md behavior a hard-abort port regressed. Set the flag and KEEP the live
  // session; the stopRequested checks in _runNext/_advance halt before the next step. If nothing
  // is mid-step (idle, gating on the usage gate, or paused with no live turn), there's no step to
  // finish, so halt now — this also cancels a pending resume (running=false stops onUsageUpdate).
  //
  // A SECOND stop escalates to the hard teardown (D-057). The graceful branch can only end at a
  // turn end, so a turn that never ends — a permission card nobody answered, a wedged stream, a
  // provider child killed out from under the loop — left every further Stop click re-entering
  // this same branch and doing nothing, with no way out but killing the window. Clicking Stop
  // again is what anyone tries next, so that is now the escape hatch.
  stop() {
    if (!this.running && !session.sessions.has(this.id)) return;
    if (this.stopRequested) return this.abort('idle', 'Stopped now');
    this.stopRequested = true;
    if (!this._turnLive && !this.finalizing) return this.abort('idle', 'Stopped');
    this.emit('status', { state: 'running', step: this.currentStep,
      detail: `Will stop after ${this.currentStep} — finishing this step. Stop again to halt now.` });
  }

  // Interrupt the LIVE turn without ending the run — the panel's ✋ Interrupt during a run.
  // Routed through the manual-pause path on purpose: a raw provider.interrupt() is INVISIBLE to
  // the runner, and the turn-end it produces is then read as a completed turn (on Claude the loop
  // advances past the step or retries it; on Codex the child dies emitting nothing at all and the
  // loop hangs with _turnLive stuck true). _pause() does the bookkeeping BEFORE the interrupt, so
  // _onTurnEnd's `paused` guard drops the turn-end and Resume re-enters the same step.
  // Returns false when there's nothing safe to interrupt (no live turn). Both engines: the
  // Codex refusal was retired in P16-S09 (D-077) — _pause() does the bookkeeping first, so the
  // dead child is expected rather than read as a turn-end.
  interruptTurn() {
    if (!this.running || this.paused || !this._turnLive) return false;
    this.pauseManual();
    return this.paused;
  }

  // Hard abort (D-022): immediate teardown — kill the live session and finish NOW, mid-step. This
  // is the pre-PLAN-07 stop() behavior, kept as a separate "stop now" control.
  abort(state = 'idle', detail = 'Aborted') {
    if (!this.running && !session.sessions.has(this.id)) return;
    this.stopRequested = true;
    this._provider.stop(this.id);
    this._finish(state, detail);
  }

  _finish(state, detail) {
    this._gen++; // invalidate any in-flight step callbacks
    clearTimeout(this._finalizeTimer);
    clearTimeout(this._retryTimer);
    clearTimeout(this._stallTimer);
    this.finalizing = false;
    this.running = false;
    this.needsYou = false;
    this.paused = false;
    this.manualPause = false;
    this.gating = false;
    this._turnLive = false;
    this._planSession = false;
    this._advancedPlan = false;
    this.currentStep = null;
    this.emit('status', { state, detail });
    this.emit('done', { state, detail, startedAtMs: this._startedAtMs }); // sinceMs for the run digest (P09-S16)
  }

  // The usage gate now speaks for whichever engine the poller is reading (P16-S08): the gate used
  // to be skipped outright on Codex because no Codex source existed, and a Codex run would happily
  // burn straight through its weekly limit into hard server rejections. It reads one snapshot, so
  // there is nothing engine-shaped left here to branch on.
  // The model goes to the gate because one of its limits is per-model: a Fable weekly at its
  // limit must not hold a run on another model. (Codex has no per-model window at all — D-075 —
  // so that limit simply never matches there.)
  // Codex's ONLY release from a hold is the reset clock (S04): there is no active query to fall
  // back on, so if that regresses Codex deadlocks where Claude would not.
  _over() { return !!(this.usageGate && this.usageGate.isOverThreshold(this.project.model)); }

  // Which limit is holding the run, named. A weekly hold can last days where a session hold lasts
  // hours, so "usage at/above threshold" alone doesn't say what you're waiting on. Optional on the
  // gate: an older/stub gate without describe() falls back to the generic line.
  _gateWhy() {
    const d = this.usageGate && this.usageGate.describe && this.usageGate.describe(this.project.model);
    return d || 'account usage at/above threshold';
  }

  _runNext() {
    if (this.stopRequested) return this._finish('idle', 'Stopped');
    if (this.stepsRun >= MAX_STEPS) return this._finish('idle', 'Hit step cap — restart to continue');
    // Owner ceilings (D-016, default OFF): bound the run by step count or wall-clock, independent of
    // the usage gate. Checked here (between steps) so a step already in flight always finishes first.
    const max = this.project.maxStepsPerRun;
    if (max > 0 && this.stepsRun >= max)
      return this._finish('idle', `Reached max steps per run (${max}) — restart to continue`);
    if (stopTimeReached(this._startedAtMs, this.now(), this.project.stopAtTime))
      return this._finish('idle', `Reached stop-at time (${this.project.stopAtTime}) — restart to continue`);
    // Freshness guard: never start a step on a checkout that's behind its remote. On a project
    // more than one person drives, the commits you're missing include their PROGRESS.md close-out,
    // so the NEXT pointer below would be stale too — you'd redo a finished step or collide with it.
    // Checked BEFORE readPointer for exactly that reason. No upstream / no remote / offline never
    // blocks (gitState reports behind:false), so solo projects pay nothing.
    // Behind AND unpushed = diverged: `--ff-only` REFUSES on a diverged branch, so advising it sends
    // the owner to a command that cannot work. What blocks is unchanged (P14-S05) — only the advice.
    const fresh = this.gitCheck(this.project.path);
    if (fresh.behind) {
      return this._finish('idle', 'Behind the remote — someone else pushed work this clone does not have. '
        + (fresh.pushed
          ? 'Run `git pull --ff-only`, then Start again.'
          : 'This branch has also diverged (it has local commits that are not pushed), so '
            + '`git pull --ff-only` cannot succeed — rebase or merge them yourself, then Start again.'));
    }
    const next = readPointer(this.project.path, this.project.lane);
    if (!next) return this._finish('error', 'No NEXT pointer / PROGRESS.md — not a master-plan project');
    if (/^none/i.test(next)) return this._finish('done', `Project complete (${next})`);
    // Plan boundary: run master-plan ONCE to close/advance the plan (P02-S08), then re-read the
    // pointer. If master-plan already ran and the pointer is still PLAN COMPLETE (unchanged),
    // finish rather than loop. A pointer that names a step resets the guard (see _runStep).
    if (/^PLAN COMPLETE/i.test(next)) {
      if (this._advancedPlan) return this._finish('done', `Plan complete (${next})`);
      this._advancedPlan = true;
      this._retries = 0; // fresh close-out → fresh error-retry budget (retries re-enter _runMasterPlan directly)
      return this._runMasterPlan();
    }
    // Proactive gate: don't START a step while account usage is at/above threshold (port app gate).
    if (this._over()) {
      this.currentStep = next;
      this.gating = true;
      this.paused = true;
      return this.emit('paused', { reason: `Usage — ${this._gateWhy()}; waiting to start ${next}` });
    }
    this.gating = false;
    this._runStep(next);
  }

  _runStep(stepId) {
    this.needsYou = false;
    this.paused = false;
    this._advancedPlan = false; // a real step to run → reset the master-plan-once guard
    this._retries = 0;          // fresh step off the loop → fresh error-retry budget
    this._stepStartedAtMs = this.now(); // true step start (retries reuse it, so the ledger spans them)
    this._lastResult = null;
    this.emit('status', { state: 'running', step: stepId, detail: `Running ${stepId}` });
    this.emit('step-started', { step: stepId });
    this._startSession(stepId, this._stepPrompt(), null);
  }

  // Codex ends turns early — nudge it to run the whole step to a pointer-advance (Fix P0.1.10).
  _stepPrompt() {
    return STEP_PROMPT + ((this.project.engine || 'claude') === 'codex' ? CODEX_STEP_SUFFIX : '');
  }

  // Plan boundary (P02-S08): one FRESH session running the master-plan skill to close the
  // finished plan and activate the queued one (or set NEXT: none). No settle window or git
  // guard — those close out a STEP; on turn end we tear down and re-read the pointer (loop).
  _runMasterPlan() {
    this.needsYou = false;
    this.paused = false;
    this._planSession = true;
    this.emit('status', { state: 'running', step: 'PLAN COMPLETE',
      detail: 'Plan complete — running master-plan to close out and advance to the next plan' });
    this._startSession('PLAN COMPLETE', MASTER_PLAN_PROMPT, null);
  }

  // Start (or resume) the SDK session for a step. resumeId → SDK options.resume, re-entering
  // the SAME session after a pause; null → a fresh context (the normal per-step case).
  _startSession(stepId, prompt, resumeId) {
    const gen = ++this._gen;
    this.currentStep = stepId;
    this._turnLive = true;
    const options = { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode, maxTurns: this.project.maxTurns };
    if (resumeId) options.resume = resumeId;
    this._provider.start({ id: this.id, cwd: this.project.path, prompt, options }, { send: this._wrapSend(stepId, gen) });
  }

  // The turn-end-watching send wrapper: renders to the panel, then (for the current generation)
  // routes result/error to _onTurnEnd. Shared by _startSession AND answer() so a follow-up turn
  // (Codex, or Claude after an errored turn — both start a fresh process) still fires turn-end
  // instead of stalling forever (P05-S01). A live Claude session ignores this and reuses its own.
  _wrapSend(stepId, gen) {
    return (channel, payload) => {
      session.defaultSend(channel, payload); // → panel (render), same as v2's sdkDriver
      if (gen !== this._gen || channel !== 'session:message') return;
      const t = payload.msg.type;
      // A rate-limit event is a usage READING, not step progress: record it and stop there, so it
      // can never re-arm the stall watchdog and mask a genuinely silent turn (P16-S05).
      if (t === 'rate-limit') return this._recordUsageEvent(payload.msg);
      if (t === 'result') this._lastResult = payload.msg; // keep for the run ledger at step-done
      if (t === 'result' || t === 'error') return this._onTurnEnd(stepId, gen, t === 'error');
      if (this.finalizing) this._armFinalize(stepId, gen); // late close-out output → keep waiting
      if (this._turnLive) this._armStall(stepId, gen);     // live-turn activity → (re)arm the stall watchdog
    };
  }

  // P16-S05: the SDK's rate-limit event → the UsageService as a source-tagged reading, plus ONE
  // ledger line per event so P16-S06 promotes on measured evidence instead of theory. Agreements
  // are written too, not just divergences (`diverged` flags them) — "the event was reliable" is
  // exactly as much evidence as "it wasn't", and it costs the same one line. Observe only: nothing
  // here can move the gate, which still decides on the poll's numbers alone (D-072). The record
  // carries no `startedAt`, so buildDigest skips it and the morning digest is unchanged.
  _recordUsageEvent(msg) {
    const rec = this.usageGate && this.usageGate.recordEvent && this.usageGate.recordEvent(msg);
    if (rec) this.appendLedger(this.project.path, { kind: 'usage-event', ...rec, at: new Date(rec.at).toISOString() });
  }

  // Mid-turn stall watchdog (P09-S05, D-030): if a live turn goes stallMs with no session
  // message, emit `stall` ONCE — notify-only, the turn itself is never touched. Re-armed by the
  // next message (in _wrapSend), so each fresh silent window past the threshold notifies once.
  // Cleared on turn end / teardown / pause. 0 (default) disables.
  _armStall(stepId, gen) {
    clearTimeout(this._stallTimer);
    if (this.stallMs <= 0) return;
    this._stallTimer = setTimeout(() => {
      if (gen !== this._gen || !this._turnLive || this.paused) return;
      this.emit('stall', { step: stepId, seconds: Math.round(this.stallMs / 1000) });
    }, this.stallMs);
  }

  // A turn ended. If NEXT advanced, the step's work is done → fresh session, next step.
  // If not, Claude is waiting on you (it asked a question) — keep the session ALIVE and
  // flag needs-you; your answer() continues it. (A genuine stall looks the same: you
  // just tell it what to do, or Stop.) A pause-driven turn end is ignored (this.paused).
  _onTurnEnd(stepId, gen, isError) {
    if (gen !== this._gen || this.paused) return; // paused = interrupt ended the turn; keep the id to resume
    this._turnLive = false;
    clearTimeout(this._stallTimer); // turn ended → the watchdog no longer applies
    // Master-plan (PLAN COMPLETE) session ended: tear down for a fresh context, then re-read
    // the pointer via _runNext — it names a new step (continue), 'none' (finish), or still
    // PLAN COMPLETE with _advancedPlan set (finish, no re-run). No settle/git guard here.
    if (this._planSession) {
      this._planSession = false;
      this._provider.stop(this.id);
      // An errored close-out must NOT be read as "Plan complete" — retry the master-plan session
      // once in a fresh context, then flag needs-you (P09-S03). A clean end continues.
      if (isError) {
        if (this._retries < 1) return this._retryPlan();
        this.needsYou = true;
        return this.emit('status', { state: 'needs-you', step: 'PLAN COMPLETE',
          detail: `errored during plan close-out (retried ${this._retries}×) — answer in the panel, or Stop` });
      }
      return setImmediate(() => this._runNext());
    }
    const after = readPointer(this.project.path, this.project.lane);
    if (after && after !== stepId) { // pointer advanced = the step's work is done
      this._recordStep(stepId);
      return this._beginFinalize(stepId, gen); // settle, then advance
    }
    // Pointer unchanged. A clean result = Claude is waiting on you. An error tore the session
    // down — retry the step in a fresh session up to the bound before dropping to needs-you.
    if (isError && this._retries < MAX_RETRIES) return this._retryStep(stepId);
    this.needsYou = true;
    const detail = isError
      ? `${stepId}: errored (retried ${this._retries}×) — answer in the panel to continue, or Stop`
      : `${stepId}: waiting on you — answer in the panel`;
    this.emit('status', { state: 'needs-you', step: stepId, detail });
  }

  // Append one run-ledger record for a completed step (§Result event + run ledger, D-017).
  // Best-effort: appendLedger swallows any failure, so this never blocks or delays the loop.
  _recordStep(stepId) {
    const r = this._lastResult || {};
    const tokens = r.turnTokens != null ? r.turnTokens : (r.contextTokens != null ? r.contextTokens : null);
    this.appendLedger(this.project.path, {
      stepId,
      engine: this.project.engine || 'claude',
      model: this.project.model,
      effort: this.project.effort,
      startedAt: new Date(this._stepStartedAtMs || this.now()).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      numTurns: r.numTurns != null ? r.numTurns : null,
      tokens,
      costUsd: r.costUsd != null ? r.costUsd : null,
      outcome: 'done',
    });
  }

  // Error retry (P05-S05): the errored session is already gone, so a bounded fresh session
  // reattempts the same step after a linear backoff. Stop or a usage-pause during the wait
  // cancels it (_finish clears the timer; the guard drops a stale fire).
  _retryStep(stepId) {
    this._retries++;
    const wait = this.retryBackoffMs * this._retries;
    this.emit('status', { state: 'running', step: stepId,
      detail: `${stepId} errored — retry ${this._retries}/${MAX_RETRIES} in ${Math.round(wait / 1000)}s` });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      if (this.stopRequested || this.paused) return;
      this._startSession(stepId, this._stepPrompt(), null);
    }, wait);
  }

  // Plan-boundary retry (P09-S03): a master-plan close-out that errored is re-run ONCE in a fresh
  // session after a backoff. _runMasterPlan re-sets _planSession; _retries is preserved (reset once
  // at the boundary in _runNext, never here) so the second error drops straight to needs-you.
  _retryPlan() {
    this._retries++;
    const wait = this.retryBackoffMs * this._retries;
    this.emit('status', { state: 'running', step: 'PLAN COMPLETE',
      detail: `plan close-out errored — retry ${this._retries}/1 in ${Math.round(wait / 1000)}s` });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      if (this.stopRequested || this.paused) return;
      this._runMasterPlan();
    }, wait);
  }

  // Pointer advanced = the step's work is done, but close-out (commit/push/summary) may still
  // be finishing. Hold the session ALIVE and wait finalizeMs of quiet before teardown, so the
  // close-out can't be cut off and the summary stays readable. Stop or an answer cancels it.
  // Codex `exec` is synchronous — the turn already ran to completion, so the settle window is
  // pure idle; skip it (0). Claude may still be closing out → keep the configured window. The
  // git-handoff guard in _advance stays the safety net for both engines. (P05-S08)
  get _finalizeWindowMs() { return (this.project.engine === 'codex') ? 0 : this.finalizeMs; }
  _beginFinalize(stepId, gen) {
    if (this._finalizeWindowMs <= 0) return this._advance(stepId, gen);
    this.finalizing = true;
    const secs = Math.round(this._finalizeWindowMs / 1000);
    this.emit('status', { state: 'finalizing', step: stepId,
      detail: `${stepId} done — settling ${secs}s for close-out (commit/push). Stop to hold here.` });
    this._armFinalize(stepId, gen);
  }
  // (Re)arm the quiet timer; each session message calls this so the timer only fires once
  // NOTHING has run for the full window (matches the standalone's byte-resets-the-timer rule).
  _armFinalize(stepId, gen) {
    clearTimeout(this._finalizeTimer);
    this._finalizeTimer = setTimeout(() => this._advance(stepId, gen), this._finalizeWindowMs);
  }
  // Quiet window elapsed (or disabled): teardown for a fresh context, then run the next step.
  _advance(stepId, gen) {
    if (gen !== this._gen) return; // torn down / stopped mid-window
    this.finalizing = false;
    // Handoff guard: never advance past a step whose work isn't committed + pushed. The
    // session is kept ALIVE so you (or a reply) can tell it to finish close-out, after which
    // the turn ends, the pointer is still advanced, and we settle → re-check → advance.
    // fetch:false — `clean` and `pushed` are both LOCAL questions, and gitState's fetch is a
    // synchronous network call that would freeze the extension host for up to 20s at every step
    // boundary for nothing. Staleness is checked in _runNext, where it actually matters.
    const g = this.gitCheck(this.project.path, { fetch: false });
    if (!g.clean || !g.pushed) {
      this.needsYou = true;
      const why = !g.clean ? 'uncommitted changes — the step never committed its work'
                           : 'commits not pushed to the remote';
      this.emit('status', { state: 'needs-you', step: stepId,
        detail: `${stepId} ended but close-out is incomplete (${why}). Tell it to finish the commit/push, or Stop.` });
      return;
    }
    this.stepsRun++;
    const after = readPointer(this.project.path, this.project.lane);
    this._provider.stop(this.id); // teardown -> guarantees a fresh context next step
    this.emit('step-done', { from: stepId, to: after });
    if (this.stopRequested) return this._finish('idle', `Stopped after ${stepId}`);
    return setImmediate(() => this._runNext());
  }

  // Driven by every UsageService 'update'. Threshold crossings pause/resume the loop:
  //   between steps (gating) → start the step once usage drops
  //   mid-turn (paused)      → resume the same step once usage drops
  //   live turn + over       → interrupt now, remember the session id, wait
  onUsageUpdate() {
    if (!this.running || this.stopRequested) return;
    const over = this._over();
    if (this.gating) { if (!over) { this.gating = false; this.paused = false; this._runNext(); } return; }
    // A manual hold never auto-resumes on a usage drop — only resumeManual() clears it (D-023).
    if (this.paused) { if (!over && !this.manualPause) this._resume(); return; }
    if (over && this._turnLive) this._pause();
  }

  // Owner-driven Pause/Resume — BOTH engines since P16-S09 (D-077 retires D-023's Claude-only
  // half). Reuses the usage-gate pause machinery but flags it so a usage drop won't auto-resume a
  // hold the owner set. That machinery already runs on Codex (P16-S08 dropped _over()'s engine
  // exclusion): interrupt kills the child with `aborted` set — so it emits nothing and _pause()'s
  // own bookkeeping, not a turn-end, is what the loop acts on — and the thread id survives, so
  // _resume() re-enters the same step via `codex exec resume <thread>`.
  // No live turn (idle/gating/already paused) → nothing to pause.
  pauseManual() {
    if (!this.running || this.paused || !this._turnLive) return;
    this.manualPause = true;
    this._pause();
  }
  resumeManual() {
    if (!this.manualPause) return;
    this.manualPause = false;
    this._resume();
  }

  // Over threshold mid-turn: interrupt (stops the TURN, session id stays valid — D-005),
  // capturing the id BEFORE the interrupt so resume re-enters this exact session.
  _pause() {
    this._resumeId = this._provider.currentSessionId(this.id);
    this.paused = true;
    this._turnLive = false;
    clearTimeout(this._stallTimer); // no live turn to watch while paused
    this._provider.interrupt(this.id);
    this.emit('paused', { reason: this.manualPause
      ? `Paused ${this.currentStep} — click Resume to continue`
      : `Paused ${this.currentStep} — ${this._gateWhy()}; resuming when every limit is back under` });
  }

  // Usage dropped back under while paused: re-enter the SAME step's session.
  _resume() {
    this.paused = false;
    this.emit('resumed', {});
    this.emit('status', { state: 'running', step: this.currentStep, detail: `Resuming ${this.currentStep}…` });
    this._startSession(this.currentStep, RESUME_PROMPT, this._resumeId);
  }

  // Your reply from the panel. A live session takes it as a new turn (continues the step);
  // if none is live (Codex has no process between turns; Claude tears down on an errored turn),
  // chat() starts a fresh one — RESUMED onto the persisted thread/session id and driven by the
  // same turn-end wrapper, so the follow-up turn advances the loop instead of stalling (P05-S01).
  // Reuse the current generation (no bump): the step's session is still valid, so a live Claude
  // turn-end (its own wrapper) stays matched too.
  answer(text) {
    this.needsYou = false;
    clearTimeout(this._finalizeTimer); // typing during the settle window holds it & continues the session
    this.finalizing = false;
    // A composer send while paused is an explicit resume (D-027): clear the holds so the follow-up
    // turn's result is processed — otherwise _onTurnEnd's `this.paused` guard drops it and the loop
    // desyncs (pointer advances, runner never notices). Only the usage gate auto-resumes an unmanual
    // pause; a human reply resumes either kind.
    if (this.paused || this.manualPause || this.gating) {
      this.paused = false;
      this.manualPause = false;
      this.gating = false;
      this.emit('resumed', {});
    }
    this._turnLive = true;
    const stepId = this.currentStep;
    this.emit('status', { state: 'running', step: stepId, detail: `Continuing ${stepId}…` });
    const options = { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode,
      maxTurns: this.project.maxTurns, resume: this._provider.currentSessionId(this.id) || undefined };
    this._provider.chat({ id: this.id, cwd: this.project.path, prompt: text, options }, { send: this._wrapSend(stepId, this._gen) });
  }
}

module.exports = { Runner, MAX_STEPS, MAX_RETRIES, RESUME_PROMPT, gitState, stopTimeReached,
  appendLedger, readLedger, buildDigest };

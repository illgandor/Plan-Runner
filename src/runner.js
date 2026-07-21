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
function gitState(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const clean = git(['status', '--porcelain']) === '';
    let pushed = true;
    try { pushed = git(['rev-list', '--count', '@{u}..HEAD']) === '0'; } catch { pushed = true; } // no upstream → n/a
    return { clean, pushed };
  } catch { return { clean: true, pushed: true }; } // not a git repo → don't block
}

// Per-step run ledger (P05-S07, D-017): append one JSON line per completed step to
// <cwd>/.plan-runner/runs.jsonl so "what did it do while I slept?" survives session teardown.
// Best-effort — a write failure is swallowed and never blocks or delays the loop. Exported
// for the runner method + tests. `.plan-runner/` is git-ignored.
function appendLedger(cwd, record) {
  try {
    const dir = path.join(cwd, '.plan-runner');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify(record) + '\n');
  } catch { /* best-effort: a ledger write never affects the run */ }
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
    this.manualPause = false; // owner-set hold (Claude only, D-023) — usage gate won't auto-resume it
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
    // Discard-step seams (P06-S06), overridable in tests: SDK file-checkpoint rewind + its anchor,
    // and the `git checkout` fallback when no checkpoint is available.
    this.rewindFiles = session.rewindFiles;
    this.stepStartMsgId = () => session.stepStartMessageId(this.id);
    this.gitCheckout = (cwd) => execFileSync('git', ['checkout', '--', '.'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
  stop() {
    if (!this.running && !session.sessions.has(this.id)) return;
    this.stopRequested = true;
    if (!this._turnLive && !this.finalizing) return this.abort('idle', 'Stopped');
    this.emit('status', { state: 'running', step: this.currentStep,
      detail: `Will stop after ${this.currentStep} — finishing this step, then halting.` });
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
    this.emit('done', { state, detail });
  }

  // The usage gate polls CLAUDE account usage; it's meaningless for a Codex run (different
  // account, no source), so never pause a Codex step on it. (Codex usage % is N/A — see the panel.)
  _over() { return (this.project.engine || 'claude') !== 'codex' && !!(this.usageGate && this.usageGate.isOverThreshold()); }

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
    const next = readPointer(this.project.path);
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
      return this.emit('paused', { reason: `Usage at/above threshold — waiting to start ${next}` });
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
      if (t === 'result') this._lastResult = payload.msg; // keep for the run ledger at step-done
      if (t === 'result' || t === 'error') return this._onTurnEnd(stepId, gen, t === 'error');
      if (this.finalizing) this._armFinalize(stepId, gen); // late close-out output → keep waiting
      if (this._turnLive) this._armStall(stepId, gen);     // live-turn activity → (re)arm the stall watchdog
    };
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
    const after = readPointer(this.project.path);
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
    const g = this.gitCheck(this.project.path);
    if (!g.clean || !g.pushed) {
      this.needsYou = true;
      const why = !g.clean ? 'uncommitted changes — the step never committed its work'
                           : 'commits not pushed to the remote';
      this.emit('status', { state: 'needs-you', step: stepId,
        detail: `${stepId} ended but close-out is incomplete (${why}). Tell it to finish the commit/push, or Stop.` });
      return;
    }
    this.stepsRun++;
    const after = readPointer(this.project.path);
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

  // Owner-driven Pause/Resume (D-023) — Claude only (Codex has no mid-turn interrupt). Reuses the
  // usage-gate pause machinery but flags it so a usage drop won't auto-resume a hold the owner set.
  // No live turn (idle/gating/already paused) → nothing to pause. The webview hides the button on
  // Codex; this refusal is the host-side backstop.
  pauseManual() {
    if ((this.project.engine || 'claude') === 'codex') return;
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
      : `Usage at/above threshold — paused ${this.currentStep}, resuming when it drops` });
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

  // Discard the current step's file edits (P06-S06). Prefer SDK file checkpointing — rewind the
  // live session's tracked files to the step-start user message; fall back to `git checkout -- .`
  // when no checkpoint is available (no live session, Codex, or an SDK too old to rewind).
  // Returns { method, filesChanged? }. Untracked files the step created are not removed (matches
  // `git checkout` semantics); the checkpoint rewind only reverts what it snapshotted.
  async discardStepChanges() {
    if ((this.project.engine || 'claude') !== 'codex') {
      try {
        const res = await this.rewindFiles(this.id, this.stepStartMsgId());
        if (res && res.canRewind) return { method: 'checkpoint', filesChanged: res.filesChanged || [] };
      } catch { /* checkpoint unavailable/failed → git fallback below */ }
    }
    this.gitCheckout(this.project.path);
    return { method: 'git' };
  }
}

module.exports = { Runner, MAX_STEPS, MAX_RETRIES, RESUME_PROMPT, gitState, stopTimeReached, appendLedger };

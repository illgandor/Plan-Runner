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
const { STEP_PROMPT, MASTER_PLAN_PROMPT } = require('./constants');
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

const MAX_STEPS = 200; // hard safety cap per ON run
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
    this.gating = false;     // true = between-steps hold (no live session yet)
    this._turnLive = false;  // true only while a step's turn is actively streaming
    this._resumeId = null;   // session id captured at pause, replayed on resume
    this.finalizeMs = FINALIZE_MS; // settle window before advancing to the next step (0 = off)
    this.finalizing = false; // true during the post-advance quiet window (session kept alive)
    this._finalizeTimer = null;
    this._planSession = false; // true while the master-plan (PLAN COMPLETE) session is live (P02-S08)
    this._advancedPlan = false; // guards master-plan to once per PLAN COMPLETE (a 2nd unchanged → finish)
    this.gitCheck = gitState;  // handoff guard; overridable in tests
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
    this._runNext();
  }

  // Graceful stop: aborts the live session and halts the loop. Also cancels a pending
  // resume — running=false stops onUsageUpdate from ever firing _resume().
  stop() {
    if (!this.running && !session.sessions.has(this.id)) return;
    this.stopRequested = true;
    this._provider.stop(this.id);
    this._finish('idle', 'Stopped');
  }

  _finish(state, detail) {
    this._gen++; // invalidate any in-flight step callbacks
    clearTimeout(this._finalizeTimer);
    this.finalizing = false;
    this.running = false;
    this.needsYou = false;
    this.paused = false;
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
    const next = readPointer(this.project.path);
    if (!next) return this._finish('error', 'No NEXT pointer / PROGRESS.md — not a master-plan project');
    if (/^none/i.test(next)) return this._finish('done', `Project complete (${next})`);
    // Plan boundary: run master-plan ONCE to close/advance the plan (P02-S08), then re-read the
    // pointer. If master-plan already ran and the pointer is still PLAN COMPLETE (unchanged),
    // finish rather than loop. A pointer that names a step resets the guard (see _runStep).
    if (/^PLAN COMPLETE/i.test(next)) {
      if (this._advancedPlan) return this._finish('done', `Plan complete (${next})`);
      this._advancedPlan = true;
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
    this.emit('status', { state: 'running', step: stepId, detail: `Running ${stepId}` });
    this.emit('step-started', { step: stepId });
    this._startSession(stepId, STEP_PROMPT, null);
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
    const options = { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode };
    if (resumeId) options.resume = resumeId;
    this._provider.start(
      { id: this.id, cwd: this.project.path, prompt, options },
      { send: (channel, payload) => {
          session.defaultSend(channel, payload); // → panel (render), same as v2's sdkDriver
          if (gen !== this._gen || channel !== 'session:message') return;
          const t = payload.msg.type;
          if (t === 'result' || t === 'error') this._onTurnEnd(stepId, gen);
          else if (this.finalizing) this._armFinalize(stepId, gen); // late close-out output → keep waiting
        } }
    );
  }

  // A turn ended. If NEXT advanced, the step's work is done → fresh session, next step.
  // If not, Claude is waiting on you (it asked a question) — keep the session ALIVE and
  // flag needs-you; your answer() continues it. (A genuine stall looks the same: you
  // just tell it what to do, or Stop.) A pause-driven turn end is ignored (this.paused).
  _onTurnEnd(stepId, gen) {
    if (gen !== this._gen || this.paused) return; // paused = interrupt ended the turn; keep the id to resume
    this._turnLive = false;
    // Master-plan (PLAN COMPLETE) session ended: tear down for a fresh context, then re-read
    // the pointer via _runNext — it names a new step (continue), 'none' (finish), or still
    // PLAN COMPLETE with _advancedPlan set (finish, no re-run). No settle/git guard here.
    if (this._planSession) {
      this._planSession = false;
      this._provider.stop(this.id);
      return setImmediate(() => this._runNext());
    }
    const after = readPointer(this.project.path);
    if (after && after !== stepId) return this._beginFinalize(stepId, gen); // work done → settle, then advance
    this.needsYou = true;
    this.emit('status', { state: 'needs-you', step: stepId, detail: `${stepId}: waiting on you — answer in the panel` });
  }

  // Pointer advanced = the step's work is done, but close-out (commit/push/summary) may still
  // be finishing. Hold the session ALIVE and wait finalizeMs of quiet before teardown, so the
  // close-out can't be cut off and the summary stays readable. Stop or an answer cancels it.
  _beginFinalize(stepId, gen) {
    if (this.finalizeMs <= 0) return this._advance(stepId, gen);
    this.finalizing = true;
    const secs = Math.round(this.finalizeMs / 1000);
    this.emit('status', { state: 'finalizing', step: stepId,
      detail: `${stepId} done — settling ${secs}s for close-out (commit/push). Stop to hold here.` });
    this._armFinalize(stepId, gen);
  }
  // (Re)arm the quiet timer; each session message calls this so the timer only fires once
  // NOTHING has run for the full window (matches the standalone's byte-resets-the-timer rule).
  _armFinalize(stepId, gen) {
    clearTimeout(this._finalizeTimer);
    this._finalizeTimer = setTimeout(() => this._advance(stepId, gen), this.finalizeMs);
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
    if (this.paused) { if (!over) this._resume(); return; }
    if (over && this._turnLive) this._pause();
  }

  // Over threshold mid-turn: interrupt (stops the TURN, session id stays valid — D-005),
  // capturing the id BEFORE the interrupt so resume re-enters this exact session.
  _pause() {
    this._resumeId = this._provider.currentSessionId(this.id);
    this.paused = true;
    this._turnLive = false;
    this._provider.interrupt(this.id);
    this.emit('paused', { reason: `Usage at/above threshold — paused ${this.currentStep}, resuming when it drops` });
  }

  // Usage dropped back under while paused: re-enter the SAME step's session.
  _resume() {
    this.paused = false;
    this.emit('resumed', {});
    this.emit('status', { state: 'running', step: this.currentStep, detail: `Resuming ${this.currentStep}…` });
    this._startSession(this.currentStep, RESUME_PROMPT, this._resumeId);
  }

  // Your reply from the panel. A live session takes it as a new turn (continues the step);
  // if none is live, chat() starts one so the answer isn't lost.
  answer(text) {
    this.needsYou = false;
    clearTimeout(this._finalizeTimer); // typing during the settle window holds it & continues the session
    this.finalizing = false;
    this._turnLive = true;
    this.emit('status', { state: 'running', step: this.currentStep, detail: `Continuing ${this.currentStep}…` });
    this._provider.chat({ id: this.id, cwd: this.project.path, prompt: text,
      options: { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode } });
  }
}

module.exports = { Runner, MAX_STEPS, RESUME_PROMPT, gitState };

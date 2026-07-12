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
const { STEP_PROMPT } = require('./constants');
const { readPointer } = require('./progress');
const session = require('./session');

const MAX_STEPS = 200; // hard safety cap per ON run
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
  }
  get id() { return this.project.id; }

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
    session.stop(this.id);
    this._finish('idle', 'Stopped');
  }

  _finish(state, detail) {
    this._gen++; // invalidate any in-flight step callbacks
    this.running = false;
    this.needsYou = false;
    this.paused = false;
    this.gating = false;
    this._turnLive = false;
    this.currentStep = null;
    this.emit('status', { state, detail });
    this.emit('done', { state, detail });
  }

  _over() { return !!(this.usageGate && this.usageGate.isOverThreshold()); }

  _runNext() {
    if (this.stopRequested) return this._finish('idle', 'Stopped');
    if (this.stepsRun >= MAX_STEPS) return this._finish('idle', 'Hit step cap — restart to continue');
    const next = readPointer(this.project.path);
    if (!next) return this._finish('error', 'No NEXT pointer / PROGRESS.md — not a master-plan project');
    if (/^(PLAN COMPLETE|none)/i.test(next)) return this._finish('done', `Plan complete (${next})`);
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
    this.emit('status', { state: 'running', step: stepId, detail: `Running ${stepId}` });
    this.emit('step-started', { step: stepId });
    this._startSession(stepId, STEP_PROMPT, null);
  }

  // Start (or resume) the SDK session for a step. resumeId → SDK options.resume, re-entering
  // the SAME session after a pause; null → a fresh context (the normal per-step case).
  _startSession(stepId, prompt, resumeId) {
    const gen = ++this._gen;
    this.currentStep = stepId;
    this._turnLive = true;
    const options = { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode };
    if (resumeId) options.resume = resumeId;
    session.start(
      { id: this.id, cwd: this.project.path, prompt, options },
      { send: (channel, payload) => {
          session.defaultSend(channel, payload); // → panel (render), same as v2's sdkDriver
          if (gen !== this._gen || channel !== 'session:message') return;
          const t = payload.msg.type;
          if (t === 'result' || t === 'error') this._onTurnEnd(stepId, gen);
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
    const after = readPointer(this.project.path);
    if (after && after !== stepId) {
      this.stepsRun++;
      session.stop(this.id); // teardown -> guarantees a fresh context next step
      this.emit('step-done', { from: stepId, to: after });
      if (this.stopRequested) return this._finish('idle', `Stopped after ${stepId}`);
      return setImmediate(() => this._runNext());
    }
    this.needsYou = true;
    this.emit('status', { state: 'needs-you', step: stepId, detail: `${stepId}: waiting on you — answer in the panel` });
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
    this._resumeId = session.currentSessionId(this.id);
    this.paused = true;
    this._turnLive = false;
    session.interrupt(this.id);
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
    this._turnLive = true;
    this.emit('status', { state: 'running', step: this.currentStep, detail: `Continuing ${this.currentStep}…` });
    session.chat({ id: this.id, cwd: this.project.path, prompt: text,
      options: { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode } });
  }
}

module.exports = { Runner, MAX_STEPS, RESUME_PROMPT };

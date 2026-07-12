// Runner — the autonomous loop, distilled from Plan Runner's src/step-runner.js.
// One loop per workspace. Runs one FRESH SDK session per step until the plan completes
// or a step needs you. The pty-era finalize/idle machinery is intentionally dropped:
// with the SDK, a `result` message means the turn (incl. close-out) is fully done, so the
// only signals we need are (1) result/error = turn ended, (2) PROGRESS.md's NEXT pointer.
//
//   turn ended + pointer ADVANCED   -> step done  -> teardown -> fresh session, next step
//   turn ended + pointer UNCHANGED  -> needs you   -> keep session ALIVE, wait for answer
//
// A generation counter invalidates stale callbacks from a torn-down step.
const { EventEmitter } = require('events');
const { STEP_PROMPT } = require('./constants');
const { readPointer } = require('./progress');
const session = require('./session');

const MAX_STEPS = 200; // hard safety cap per ON run

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
  }
  get id() { return this.project.id; }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.stepsRun = 0;
    this._runNext();
  }

  // Graceful stop: aborts the live session and halts the loop.
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
    this.currentStep = null;
    this.emit('status', { state, detail });
    this.emit('done', { state, detail });
  }

  _runNext() {
    if (this.stopRequested) return this._finish('idle', 'Stopped');
    if (this.stepsRun >= MAX_STEPS) return this._finish('idle', 'Hit step cap — restart to continue');
    const next = readPointer(this.project.path);
    if (!next) return this._finish('error', 'No NEXT pointer / PROGRESS.md — not a master-plan project');
    if (/^(PLAN COMPLETE|none)/i.test(next)) return this._finish('done', `Plan complete (${next})`);
    this._runStep(next);
  }

  _runStep(stepId) {
    const gen = ++this._gen;
    this.currentStep = stepId;
    this.needsYou = false;
    this.emit('status', { state: 'running', step: stepId, detail: `Running ${stepId}` });
    this.emit('step-started', { step: stepId });
    session.start(
      { id: this.id, cwd: this.project.path, prompt: STEP_PROMPT,
        options: { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode } },
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
  // just tell it what to do, or Stop.)
  _onTurnEnd(stepId, gen) {
    if (gen !== this._gen) return;
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

  // Your reply from the panel. A live session takes it as a new turn (continues the step);
  // if none is live, chat() starts one so the answer isn't lost.
  answer(text) {
    this.needsYou = false;
    this.emit('status', { state: 'running', step: this.currentStep, detail: `Continuing ${this.currentStep}…` });
    session.chat({ id: this.id, cwd: this.project.path, prompt: text,
      options: { model: this.project.model, effort: this.project.effort, permissionMode: this.project.mode } });
  }
}

module.exports = { Runner, MAX_STEPS };

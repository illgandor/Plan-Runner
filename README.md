# Plan Runner (VS Code extension)

An agent chat panel that **autonomously drives a master-plan project** — one fresh
context window per step — right inside VS Code. It's the useful core of the standalone
Plan Runner app, minus Electron.

You use the **official** Claude panel (or Codex) for hands-on coding. You switch to
**this** panel when you want the plan to run itself: it runs a step, and when the step's
work is done it tears the session down and starts the next step in a **fresh context
window** — the thing you'd otherwise do by hand with the ＋ new-session button. If a step
needs you (a question, or a command outside the auto-allow list), it asks **in the panel**;
your answer continues the **same** session.

## Spec-Driven Development

Plan Runner is the **autonomous execution layer for spec-driven development**: you write the
spec, it drives the build to completion. Point the `master-plan` skill at your spec —
a [Spec Kit](https://github.com/github/spec-kit) or [Kiro](https://kiro.dev) spec, a plan
doc, or any structured intent — and it decomposes it into stepped, window-sized plans; Plan
Runner then executes those steps one fresh context window at a time until the plan is done.

## How it works

- Detects step completion the same way the app does: `PROGRESS.md`'s `NEXT:` pointer
  advancing (the `next-step` skill updates it at close-out).
- Runs on your existing **subscription — no API key**: the Claude **Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`, same as the standalone app) or the **Codex** CLI.
- **Per-workspace toggle** in the status bar: `Plan Runner: On/Off`. On in one project ≠
  on in another. Off means the loop can't start — no surprise autonomous runs.

## Two engines

Pick the engine in the panel; the rest of the UI stays the same.

- **Claude** (default) — the Agent SDK on your subscription; full model / permission-mode
  selection.
- **Codex** — drives the `codex exec --json` CLI with its own models and reasoning efforts
  (including xhigh), agents, and MCP servers preserved.

The Claude code path is unchanged when Codex isn't selected; the webview and loop are
engine-agnostic, so streaming, run controls, and the usage gate work the same either way
(with the few Claude-only exceptions noted below).

## Panel features

Basics: engine + model + permission-mode selector, attach-a-file (hands the agent a path to
read), live context-token meter, and streamed thinking + tool calls. Assistant output and
tool results render as **sanitized markdown** — code blocks and **diffs** are colorized with
the editor's own diff theme; long tool output collapses behind a **show more**.

### Run controls

- **Stop** — graceful: finishes the current step, then halts the loop cleanly.
- **Abort** ("⏹ Stop now") — hard teardown of the running session immediately.
- **Pause / Resume** — Claude-only mid-turn hold: interrupts the current turn (session kept)
  and resumes the same step on demand. Hidden when Codex is selected.

### Leaving it running unattended

- **Usage meter** — live Session and Week account-usage bars, read from `claude /usage`;
  keeps the last good reading rather than blanking on a missing sample.
- **Global pause threshold** — `Pause @ N%` applies to *every* window/project (VS Code
  application-scoped setting), so one number governs all your autonomous runs.
- **Auto pause + resume** — when usage crosses the threshold the current turn is interrupted
  (session kept) and resumes automatically once usage drops back under. (This is separate
  from a manual Pause, which won't auto-resume.)
- **Run caps** — optional, off by default: `maxTurns`, `maxStepsPerRun`, and a `stopAtTime`
  (`HH:MM`) wall-clock cutoff, so a run can bound itself.
- **Needs-you notification** — when a step blocks on a question or a non-allowed command,
  you get an OS notification so you don't have to watch the panel.
- **Run ledger** — one append-only JSON line per completed step at
  `.plan-runner/runs.jsonl` (step id, engine, model, effort, timings). Best-effort: a failed
  write never stalls the loop.
- **MCP button** — lists the servers in your `~/.claude` config with their last-init status;
  authorize, add, remove, or reconnect them via `claude mcp`.
- **Discard step** — roll the workspace back to a step's starting checkpoint (SDK file
  checkpointing, with a git-checkout fallback) when a run went sideways.
- **Self-update** — polls GitHub Releases and side-loads a newer `.vsix` in place, then
  prompts a reload (stock VS Code won't auto-update a side-loaded extension).

## Run it (development)

```
cd "Plan Runner Extension"
npm install
```

Then open this folder in VS Code and press **F5** — that launches an Extension
Development Host. Open a master-plan project folder in it, click the Plan Runner icon in
the activity bar, toggle it **On** (status bar), and hit **Start**.

Requires the `claude` CLI logged in (same as the standalone app) and the `next-step` /
`master-plan` skills in `~/.claude/skills`. For the Codex engine, the `codex` CLI logged in.

## Install as a real extension (no F5)

Build a `.vsix` and side-load it, so it loads in every VS Code window automatically:

```
npx vsce package                                        # -> plan-runner-<version>.vsix (~84 MB)
code --install-extension plan-runner-<version>.vsix --force
```

Then **Reload Window**. After that: open any project, click the Plan Runner icon, and
**drag it to the right-hand secondary side bar once** — VS Code remembers the spot. (VS
Code won't let a shipped extension default there; that's reserved for built-in chat
extensions. See PLAN.md.)

**Update after code edits:** re-run the two commands (`--force` overwrites), Reload Window.
For released builds the panel **self-updates** — it polls GitHub Releases and offers to
side-load the newer `.vsix`. It's a **Windows-only** build right now (the `claude` binary is
bundled as `win32-x64`); cross-platform is a non-goal.

## License

[Apache-2.0](LICENSE) — repo source only. The bundled third-party `claude` binary is not
relicensed. See [NOTICE](NOTICE).

See [PLAN.md](PLAN.md) for architecture, the reuse map, decisions log, and the remaining
work.

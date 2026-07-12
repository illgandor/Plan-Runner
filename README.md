# Plan Runner (VS Code extension)

An SDK chat panel that **autonomously drives a master-plan project** — one fresh Claude
context window per step — right inside VS Code. It's the useful core of the standalone
Plan Runner app, minus Electron.

You use the **official** Claude panel for hands-on coding. You switch to **this** panel
when you want the plan to run itself: it runs a step, and when the step's work is done it
tears the session down and starts the next step in a **fresh context window** — the thing
you'd otherwise do by hand with the ＋ new-session button. If a step needs you (a question,
or a command outside the auto-allow list), it asks **in the panel**; your answer continues
the **same** session.

## How it works

- Detects step completion the same way the app does: `PROGRESS.md`'s `NEXT:` pointer
  advancing (the `next-step` skill updates it at close-out).
- Runs the Claude **Agent SDK** on your existing subscription (no API key) — same
  `@anthropic-ai/claude-agent-sdk` the standalone app shipped.
- **Per-workspace toggle** in the status bar: `Plan Runner: On/Off`. On in one project ≠
  on in another. Off means the loop can't start — no surprise autonomous runs.

## Panel features

Basics: model + permission-mode selector, attach-a-file (hands Claude the path to read),
stop/interrupt, live context-token meter, streamed thinking + tool calls (long tool output
collapses behind a **show more**).

Five features that make the loop safe to leave running:

- **Usage meter** — live Session and Week account-usage bars, read from `claude /usage`;
  keeps the last good reading rather than blanking on a missing sample.
- **Global pause threshold** — `Pause @ N%` applies to *every* window/project (VS Code
  application-scoped setting), so one number governs all your autonomous runs.
- **Mid-turn pause + auto-resume** — when usage crosses the threshold the current turn is
  interrupted (session kept) and resumes automatically once usage drops back under.
- **MCP button** — lists the servers in your `~/.claude` config with their last-init
  status; authorize, add, remove, or reconnect them via `claude mcp`.
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
`master-plan` skills in `~/.claude/skills`.

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
side-load the newer `.vsix`. It's a **Windows-only** build right now (the bundled `claude`
binary is `win32-x64`).

See [PLAN.md](PLAN.md) for architecture, the reuse map, decisions log, and the remaining
work (chiefly: exercise the autonomous loop end-to-end on a live master-plan project).

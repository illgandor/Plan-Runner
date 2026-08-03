# Plan Runner (VS Code extension)

<img src="media/logo.png" alt="Plan Runner" width="128" />

An agent chat panel that **autonomously drives a master-plan project** — one fresh
context window per step — right inside VS Code. It's the useful core of the standalone
Plan Runner app, minus Electron.

You use the **official** Claude panel (or Codex) for hands-on coding. You switch to
**this** panel when you want the plan to run itself: it runs a step, and when the step's
work is done it tears the session down and starts the next step in a **fresh context
window** — the thing you'd otherwise do by hand with the ＋ new-session button. If a step
needs you (a question, or a command outside the auto-allow list), it asks **in the panel**;
your answer continues the **same** session.

## Where it docks

The panel opens in the activity bar. **Drag the Plan Runner icon to the right-hand secondary
side bar once** and VS Code remembers the spot — so the plan runs alongside your editor
instead of covering it. (VS Code reserves the default secondary-sidebar slot for built-in
chat extensions, so this one-time drag is how a shipped extension gets there.)

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
- **Never advances past stranded work**: a step closes only when its work is committed (and
  pushed, when there's an upstream), and a step won't *start* on a checkout that is **behind
  its remote** — so it can't build on top of someone else's unpulled commits.
- At a **plan boundary** the close-out session first audits the finished plan — spot-checking
  each step against the repo and filing a gap step for anything marked done but unmet.
- **Bundles the skills it needs.** The `master-plan` + `next-step` skills are shipped in the
  extension and installed into `~/.claude/skills` (and `~/.codex/skills`) on activation, then
  refreshed once per version. An existing copy is backed up, never clobbered silently; the
  command `Plan Runner: Reinstall master-plan + next-step Skills` forces a refresh.

## Two engines

Pick the engine in the panel; the rest of the UI stays the same.

- **Claude** (default) — the Agent SDK on your subscription; full model / permission-mode
  selection.
- **Codex** — drives the `codex exec --json` CLI with its own models and reasoning efforts
  (including xhigh), agents, and MCP servers preserved.

The Claude code path is unchanged when Codex isn't selected; the webview and loop are
engine-agnostic, so streaming and the run controls work the same either way. The account
usage meter and its pause gates work on **both** engines — Claude from `claude /usage`, Codex
from the limits it writes to its own session files. Codex has no per-model weekly window, so
that third bar is hidden there and a plain token counter is shown alongside instead.

## Panel features

Basics: engine + model + permission-mode selector, attach-a-file (hands the agent a path to
read), live context-token meter, and streamed thinking + tool calls. Assistant output and
tool results render as **sanitized markdown** — code blocks and **diffs** are colorized with
the editor's own diff theme; long tool output collapses behind a **show more**.

### Run controls

- **Stop after step** — the run toggle, graceful: finishes the current step, then halts cleanly.
  Click it **again** and it becomes **⏹ Stop now** — the escape hatch for a turn that can't
  finish on its own (an unanswered permission card, a wedged stream).
- **Stop now** — halts the whole run immediately, mid-step, without waiting for close-out.
- **Interrupt** — interrupts the turn in progress. Chat only; during a run use **Pause**, which
  is the same interrupt done while holding the step.
- **Pause / Resume** — mid-turn hold on either engine: interrupts the current turn (the session
  or Codex thread is kept) and resumes the same step on demand.

### Leaving it running unattended

- **Usage meter** — live Session, Week (all models) and per-model week account-usage bars, read
  from `claude /usage`; keeps the last good reading rather than blanking on a missing sample.
  The third bar is labelled by whatever model `/usage` names (Fable today), matched by shape so
  a rename can't silently blank it. When a poll fails the bars **dim** and a ⚠ line says why and
  how old the reading is — a frozen meter never passes itself off as a live one.
- **Global pause thresholds** — each bar has its own pause % in ⚙ Settings, and all three apply
  to *every* window/project (VS Code application-scoped settings). The per-model limit is scoped
  to the model you picked — it never holds a run on a different model.
- **Auto pause + resume** — whichever limit crosses first interrupts the current turn (session
  kept) and holds the loop. It resumes only once *every* limit is back under, so a session
  reset doesn't release a weekly hold. (Separate from a manual Pause, which won't auto-resume.)
- **Run caps** — optional, off by default: `maxTurns`, `maxStepsPerRun`, and a `stopAtTime`
  (`HH:MM`) wall-clock cutoff, so a run can bound itself.
- **Needs-you notification** — when a step blocks on a question or a non-allowed command,
  you get an OS notification so you don't have to watch the panel.
- **Stall watchdog** — optional, off by default: a live turn that goes silent for
  `stallNotifySeconds` fires one notification + panel line, so a hung stream is visible before
  morning. Notify-only — the turn is never killed or altered.
- **Auto-skip a question** — optional, off by default: `autoSkipQuestionSeconds` gives an
  unattended question card a countdown and Skips it at zero, so an overnight run doesn't
  strand on one. Questions only, **never** a permission prompt; any interaction cancels it.
- **Run ledger** — one append-only JSON line per completed step at
  `.plan-runner/runs.jsonl` (step id, engine, model, effort, timings). Best-effort: a failed
  write never stalls the loop.
- **MCP button** — lists the servers in your `~/.claude` config with their last-init status;
  authorize, add, remove, or reconnect them via `claude mcp`.
- **Self-update** — polls GitHub Releases and side-loads a newer `.vsix` in place, then
  prompts a reload (stock VS Code won't auto-update a side-loaded extension).

## Presence — who else is on this project (optional, off by default)

An advisory light under the status line: `● sam · P03-S04 · 2m ago`, or "only you on this
project". It talks to a **presence server you host yourself** — a small Node-stdlib service
(no deps, no database) that lives in [presence-server/](presence-server/) and is never bundled
into the `.vsix`.

- **Off unless *you* configure it.** There is no default server and no default token. With
  `planRunner.presenceUrl` / `planRunner.presenceToken` empty — how it ships — presence opens no
  socket at all. Nothing in this repo points at anyone's server.
- **Nothing about it is load-bearing.** Every call has a 5s timeout and every failure is
  swallowed: a dead, slow, or misconfigured server can't block, delay, or fail a step. The worst
  case is a light that shows nothing.
- **Identity is your git remote**, normalized to `github.com/owner/repo`, so two clones on two
  machines agree which project they're on. No remote → `local/<folder-name>`; not a repo → no
  presence.
- **It heartbeats only while the panel is visible** (60s during a live run, 300s otherwise), so
  last-seen always under-reports. An empty row means "no evidence here", never "nobody worked
  on it".
- **"Running" means a turn is actually in flight.** A step that stops to ask you something reads
  *waiting*, and one held on the usage gate reads *paused* — so a run that stalled overnight never
  looks like one still working.
- **Dashboard**: open the server's own URL in a browser for every project it has heard about,
  plus an **Account usage** row per person — session and week %, their pause limit, and how old
  the reading is. Useful when two people share one plan.
- **The shared token is the whole boundary.** Anyone who has it sees every repo name and every
  usage row on that server. Keep the port on a private network (Tailscale or WireGuard);
  exposing it to the public internet is unsupported.

Setup, the systemd unit, the state file, and the wire protocol:
[presence-server/README.md](presence-server/README.md).

## Run it (development)

```
cd "Plan Runner Extension"
npm install
```

Then open this folder in VS Code and press **F5** — that launches an Extension
Development Host. Open a master-plan project folder in it, click the Plan Runner icon in
the activity bar, toggle it **On** (status bar), and hit **Start**.

Requires the `claude` CLI logged in (same as the standalone app); the `master-plan` /
`next-step` skills are bundled and installed for you on activation. For the Codex engine, the
`codex` CLI logged in.

Gates before you ship anything: `npm test` (unit — never bare `node --test`),
`npm run check:syntax`, `npm test --prefix presence-server` (the server is its own package),
and `npx vsce package`.

## Install as a real extension (no F5)

Build a `.vsix` and side-load it, so it loads in every VS Code window automatically:

```
npx vsce package                                        # -> plan-runner-<version>.vsix (~7 MB)
code --install-extension plan-runner-<version>.vsix --force
```

Then **Reload Window**, open any project, and click the Plan Runner icon (see
[Where it docks](#where-it-docks) to move it to the secondary side bar).

**Update after code edits:** re-run the two commands (`--force` overwrites), Reload Window.
For released builds the panel **self-updates** — it polls GitHub Releases and offers to
side-load the newer `.vsix`. It's a **Windows-only** build right now (the `claude` binary is
resolved from your PATH install, not bundled); cross-platform is a non-goal.

## License

[Apache-2.0](LICENSE) — repo source only. The `claude` binary is external (resolved from your
PATH install, not bundled or redistributed). See [NOTICE](NOTICE).

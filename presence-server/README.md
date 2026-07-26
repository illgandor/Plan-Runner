# Plan Runner presence server

A tiny advisory service that answers one question: **who else is working on this project right
now?** Plan Runner panels heartbeat to it while they are open, and each panel shows the other
people it sees. Opening the server's own URL in a browser gives you a dashboard of every
project it has heard about. Node stdlib only — no dependencies, no database, no build step.

It is a separate package from the extension. It is never bundled into the `.vsix`, and Plan
Runner does not need it: with no server configured, presence is simply dark.

## What it deliberately does NOT do

- **No locking.** It will not stop two people running the same step. It tells you someone is
  there; deciding what to do about that is yours.
- **No accounts.** One shared token for everybody. There is no per-person login to revoke.
- **No live persistence.** *Who is on right now* lives in memory. A restart forgets everyone,
  and everyone re-appears on their next heartbeat (within ~5 minutes). Only the last-seen
  history and the usage rows are written to disk, and neither is consulted to decide who is live.
- **No identity guarantees.** Anyone holding the token can claim any display name.

## Requirements

Node 18 or newer. That's it.

## Install and run

```sh
git clone https://github.com/illgandor/Plan-Runner
cd Plan-Runner/presence-server
cp .env.example .env
```

Generate a token and put it in `.env`:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
PRESENCE_TOKEN=<the value you just generated>
PORT=8787
```

Run it:

```sh
PRESENCE_TOKEN=... node server.js          # foreground, for a quick try
```

The server **refuses to start with no `PRESENCE_TOKEN`** and exits non-zero saying so. That is
on purpose — an unauthenticated presence server is an open write endpoint.

## The dashboard

Open the server's base URL in a browser — `http://your-host:8787/` — and you get a page listing
every project the server has heard about, who is on it right now, and when everyone else was
last seen. It asks for the token once, keeps it in `localStorage`, and refreshes every 30
seconds. It defaults to the last 30 days with a **Show all** toggle, and puts projects more than
one person reports at the top. "Forget token" clears it from the browser.

Above the project list there is an **Account usage** section: one row per person with their Claude
session and week percentages, their pause threshold, and when the reading was taken. That is the
whole feature — two people on one plan being able to see who is about to trip the pause gate.

A few things it deliberately does not pretend:

- **Usage is account-wide, not per project.** `claude /usage` reports one number for the whole
  plan, so a row is that person's entire account, never their spend on the project above it.
  Attributing it per repo would be inventing data.
- **A row goes stale, it never disappears.** If someone closes their panel — or their meter starts
  failing while their window stays open — the row keeps its last good numbers and is dimmed and
  labelled with the reading's age. A blank where a percentage used to be reads as headroom, and
  that is exactly the wrong thing to show someone deciding whether to start a run.
- **Codex windows report nothing.** The Codex CLI exposes no usage percentage at all, so a machine
  running Codex simply lets its row go stale.
- A dash means "not known". It never means zero.

Two things to be clear-eyed about before you hand anyone that URL:

- **The token is the whole boundary.** Anyone who has it sees *every* repo name anyone has ever
  reported to this server, plus who worked on what and when — not just the projects they share
  with you. It now also shows **each person's account usage percentages and their pause
  threshold**: how much of their plan they have burned this session and this week. That is the
  point of the feature, and it is worth saying out loud before you share the token. If any of that
  is sensitive, run a second server rather than sharing this one.
- **Last-seen always under-reports.** Panels heartbeat only while the Plan Runner panel is
  *visible*. Work done with the panel closed, in another editor, or on a machine with presence
  unconfigured leaves no trace at all. An empty or stale row means "no evidence here", never
  "nobody worked on it" — do not use this page to check up on anyone.

## The state file

Last-seen history and the usage rows are the things that survive a restart. They are written to
`PRESENCE_STATE`, defaulting to `presence-state.json` beside `server.js`:

- Point it somewhere the service user can write. The systemd unit sets it to
  `%S/plan-runner/presence-state.json` — `/var/lib/plan-runner/` for a system unit,
  `~/.local/state/plan-runner/` for a `--user` one — and systemd creates the directory.
- **Don't bother backing it up.** It is advisory, it rebuilds itself as people work, and losing
  it costs you nothing but old rows. A missing, unreadable, or corrupt file starts empty and
  never stops the server from booting.
- It is capped at 500 history rows and 50 usage rows, oldest evicted first. Nothing is ever deleted
  by age, so a long-idle project stays listed until the cap pushes it out.
- An older state file written before usage existed upgrades in place: the file gains a
  `{projects, users}` envelope on the first write and no history is lost.
- Writes are debounced and atomic (temp file + rename), so a power cut can't truncate it.
- Delete the file to wipe history. The live "who is on now" map isn't in there at all.

### Run it as a service (Linux / Raspberry Pi)

```sh
sudo cp plan-runner-presence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plan-runner-presence
systemctl status plan-runner-presence
```

Edit `User=`, `WorkingDirectory=`, and `EnvironmentFile=` in the unit first if you did not
clone to `/home/pi/Plan-Runner`. The unit restarts on failure, loads `.env` for you, and
declares its own `StateDirectory=`, so there is no directory to create by hand.

If `node` comes from nvm, a system unit won't find it — run it as a **`--user`** unit instead:
drop the `User=` line, copy the file to `~/.config/systemd/user/`, then
`systemctl --user enable --now plan-runner-presence` and `sudo loginctl enable-linger $USER`
so it starts at boot without you logging in. `%S` follows you: state lands in
`~/.local/state/plan-runner/`.

## Point Plan Runner at it

In VS Code settings (or the panel's ⚙ settings), on **every** machine that should participate:

| Setting | Value |
|---|---|
| `planRunner.presenceUrl` | `http://your-host:8787` — base URL, **no trailing slash** |
| `planRunner.presenceToken` | the same token from `.env` |
| `planRunner.presenceName` | your display name (optional; defaults to `git config user.name`) |

Presence stays dark until *both* the URL and the token are set, and the folder must be a git repo.
The project identity is the normalized `origin` remote (`github.com/owner/repo`), so two clones on
different machines agree about which project they are on. A repo with **no remote** reports as
`local/<folder-name>` instead of going dark — it can never be a shared id, so two remote-less repos
that share a folder name merge into one row. Give one of them a remote if that ever matters.
No git repo at all, no presence.

## Reaching it from outside the LAN

Put it on a private network, not the public internet. **Tailscale** (easiest) or WireGuard:
install Tailscale on the server and on each machine, then set `presenceUrl` to the server's
Tailscale address, e.g. `http://100.x.y.z:8787`. Nothing else changes.

Exposing this server directly to the internet — port forwarding, a public IP — is
**unsupported**. It speaks plain HTTP, so the bearer token crosses the wire in the clear, and
its only defense is that one shared token. If you insist, terminate TLS at a reverse proxy in
front of it and accept that you are on your own.

The dashboard makes this worse, not better. A URL that renders a readable page in any browser
is far more tempting to "just put behind a domain" than two JSON endpoints ever were, and `GET
/` is deliberately unauthenticated (a browser cannot send a bearer header for its own document
load). Anyone who reaches the port gets the page; the data behind it is one guessed or leaked
token away. Keep the port on the private network.

## Troubleshooting

**The light never appears in the panel.** Presence is dark unless it is fully configured. Check,
in this order: both `presenceUrl` and `presenceToken` are set; `git rev-parse --show-toplevel`
returns something in the folder you have open; the panel is visible (hidden panels stop polling).

**A project I worked on is missing from the dashboard.** It reports only while the Plan Runner
panel is *visible* in that window, and only from a git repo. Before v0.2.13 a repo with no `origin`
remote was silently dark — that was the usual cause, and it now reports as `local/<folder-name>`.

**It says "unavailable".** The client reached nothing. `curl -s -o /dev/null -w '%{http_code}'
-H "Authorization: Bearer $PRESENCE_TOKEN" http://your-host:8787/presence/x` should print `200`.
Get `401` → the tokens differ. Nothing at all → wrong host/port, or a firewall.
Check `presenceUrl` has no trailing slash and no path.

**It says "alone" but someone else is running.** They must have the *same* normalized origin
remote, the same token, and a visible panel. Also note the cadence: heartbeats are 60s during a
live run and 300s when idle, so a peer can take a few minutes to show up or drop off.

**Nothing is ever load-bearing.** Every presence call has a hard timeout and every failure is
swallowed. A dead, slow, or misconfigured server can never block, delay, or fail a step — the
worst case is that the light shows nothing.

## Tests

```sh
npm test --prefix presence-server
```

Runs the server on an ephemeral port and exercises the real HTTP surface.

## Protocol

Frozen in `planning/reference/CONTRACTS.md` §Presence, §Dashboard and §Account usage (local to the
maintainer's checkout). Every DATA route requires `Authorization: Bearer <token>`:

- `POST /heartbeat` — `{project, user, step, state, ts}` → `204`. Malformed → `400`.
- `GET /presence/:project` → `200 {peers:[{user, step, state, ts}]}`. Unknown project is `[]`,
  never a `404`. Peers unseen for 900s are dropped. Callers filter themselves out by `user`.
- `POST /usage` — `{user, session, week, threshold, checkedAgeMs}` → `204`. Percentages are
  `0–100` or `null`; both null is a `400`. `checkedAgeMs` is **elapsed milliseconds since that
  client's last good reading**, not a timestamp, so the server can place the reading in its own
  clock without trusting anyone else's.
- `GET /projects` → `200 {projects:[{project, reporters, peers:[…], people:[…]}], users:[…]}`.
  `peers` is live under the same 900s rule; `people` is the history rows. `users` is TOP-LEVEL —
  usage is account-wide, not per project — and each row is
  `{user, session, week, threshold, ts, checkedAt, stale}`. `stale` is set from the age of the
  READING, so a live window with a broken meter is stale too. Nothing known is `{projects: [],
  users: []}`.
- `GET /` — the dashboard page, `text/html`, **unauthenticated**, the one exemption. It carries
  no data of its own; everything on it is fetched from `/projects` with the token.

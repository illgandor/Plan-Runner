# Plan Runner presence server

A tiny advisory service that answers one question: **who else is working on this project right
now?** Plan Runner panels heartbeat to it while they are open, and each panel shows the other
people it sees. Node stdlib only — no dependencies, no database, no build step.

It is a separate package from the extension. It is never bundled into the `.vsix`, and Plan
Runner does not need it: with no server configured, presence is simply dark.

## What it deliberately does NOT do

- **No locking.** It will not stop two people running the same step. It tells you someone is
  there; deciding what to do about that is yours.
- **No dashboard, no history, no accounts.** Two endpoints, one shared token, no UI.
- **No persistence.** State lives in memory. A restart forgets everyone, and everyone
  re-appears on their next heartbeat (within ~5 minutes).
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

### Run it as a service (Linux / Raspberry Pi)

```sh
sudo cp plan-runner-presence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plan-runner-presence
systemctl status plan-runner-presence
```

Edit `User=`, `WorkingDirectory=`, and `EnvironmentFile=` in the unit first if you did not
clone to `/home/pi/Plan-Runner`. The unit restarts on failure and loads `.env` for you.

## Point Plan Runner at it

In VS Code settings (or the panel's ⚙ settings), on **every** machine that should participate:

| Setting | Value |
|---|---|
| `planRunner.presenceUrl` | `http://your-host:8787` — base URL, **no trailing slash** |
| `planRunner.presenceToken` | the same token from `.env` |
| `planRunner.presenceName` | your display name (optional; defaults to `git config user.name`) |

Presence stays dark until *both* the URL and the token are set, and the project must have a git
`origin` remote — the project identity is the normalized remote URL, so two clones on different
machines agree about which project they are on. No remote, no presence.

## Reaching it from outside the LAN

Put it on a private network, not the public internet. **Tailscale** (easiest) or WireGuard:
install Tailscale on the server and on each machine, then set `presenceUrl` to the server's
Tailscale address, e.g. `http://100.x.y.z:8787`. Nothing else changes.

Exposing this server directly to the internet — port forwarding, a public IP — is
**unsupported**. It speaks plain HTTP, so the bearer token crosses the wire in the clear, and
its only defense is that one shared token. If you insist, terminate TLS at a reverse proxy in
front of it and accept that you are on your own.

## Troubleshooting

**The light never appears in the panel.** Presence is dark unless it is fully configured. Check,
in this order: both `presenceUrl` and `presenceToken` are set; `git remote get-url origin`
returns something in the repo you have open; the panel is visible (hidden panels stop polling).

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

Frozen in `planning/reference/CONTRACTS.md` §Presence (local to the maintainer's checkout).
Two routes, both requiring `Authorization: Bearer <token>`:

- `POST /heartbeat` — `{project, user, step, state, ts}` → `204`. Malformed → `400`.
- `GET /presence/:project` → `200 {peers:[{user, step, state, ts}]}`. Unknown project is `[]`,
  never a `404`. Peers unseen for 900s are dropped. Callers filter themselves out by `user`.

# Website preview gate — canonical implementation

The baseline password wall that hides an in-progress public website until launch.
Documented from the DMGoblin (ai-dungeon-master) implementation, which is the
reference. **Reproduce this MECHANISM, never its branding** — every string a
visitor sees (`<SITE_NAME>`, logo, tagline, copy) is filled from the project being
built. A gate that says "DMGoblin" on someone else's site is a bug.

Baseline stack: Node + Express + a server-side session (`express-session`) + a
togglable config store. Adapt the code to the project's actual stack, but preserve
the five properties marked **[MUST]** below — they are the security/safety contract.

## Config

Store the gate in whatever config the project already has (a `site.json`, env vars,
or a settings row) — **togglable at runtime without a redeploy**:

```json
"previewGate": { "enabled": false, "password": "" }
```

Ships `enabled:false` so nothing is locked until the owner sets a password and flips
it on (from the admin panel if the project has one).

## Middleware — runs before all routes, AFTER static assets are served

So the holding page can load its own CSS/logo while everything else is blocked.

```js
app.use((req, res, next) => {
  const gate = getSite().previewGate || {};
  if (!gate.enabled || !gate.password) return next();          // [MUST] fail OPEN — misconfig never locks the site
  if (req.session && req.session.previewUnlocked) return next(); // already in
  if (req.path === '/preview-access') return next();            // [MUST] never block the gate's own submit…
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next(); // …or the admin panel (has own auth) → can't lock yourself out of the toggle
  return res.status(200).render('gate', {                       // [MUST] 200, NOT 401 — so uptime/healthchecks on "/" stay green
    title: '<SITE_NAME> — Coming Soon', error: null,
    noindex: true,                                              // [MUST] noindex — search engines must not index the preview
    nextPath: req.originalUrl,                                  // remember where they were headed
  });
});
```

## Submit handler — verify the password

```js
const previewLimiter = rateLimit({ windowMs: 15*60*1000, max: 30 });  // [MUST] rate-limit — it's a password field

app.post('/preview-access', previewLimiter, (req, res) => {
  const gate     = getSite().previewGate || {};
  const supplied = String(req.body?.password || '');
  const expected = String(gate.password || '');
  let ok = false;
  if (gate.enabled && expected.length > 0 && supplied.length === expected.length) {
    ok = crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); // [MUST] timing-safe compare (length-guard first — timingSafeEqual throws on length mismatch)
  }
  if (!ok) return res.status(401).render('gate', {
    title: '<SITE_NAME> — Coming Soon', error: 'Incorrect password. Please try again.',
    noindex: true, nextPath: '/',
  });
  req.session.previewUnlocked = true;                           // flips ONLY the preview flag — never touches real login/session-user
  const next = req.body?.next;
  const dest = (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) ? next : '/'; // open-redirect guard: same-origin paths only, reject protocol-relative //evil
  req.session.save(() => res.redirect(dest));
});
```

## Holding page (the `gate` view)

Minimal, on-brand "coming soon" card + password form. Uses the PROJECT's name, logo,
and voice — placeholders below:

- Badge: "Preview Mode · Coming Soon"
- `<SITE_NAME>` logo/wordmark
- One line of copy, e.g. "`<SITE_NAME>` isn't open to the public yet. If you were
  given a preview password, enter it below to take a look around." (rewrite in the
  project's tone)
- Error slot (shows the failed-attempt message)
- Form: `POST /preview-access`, a `type="password"` field named `password`, and a
  hidden `next` = `nextPath`, submit button.

## Separation & teardown — [MUST]

The gate is **independent of real account auth**: it only sets/reads
`req.session.previewUnlocked` and never reads or writes login/session-user data.
Turning `enabled` off makes the site behave exactly as if the gate never existed —
that toggle IS the launch. So **opening to the public = flip `previewGate.enabled`
off**, which the plan schedules as its own explicit, owner-gated launch step at the
END (never bundled into feature work).

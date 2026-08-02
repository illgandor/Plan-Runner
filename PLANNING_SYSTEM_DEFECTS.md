# Planning-system defects — found in the field, not yet fixed

**Date:** 2026-07-31 · **Found on:** the Recipes project (`illgandor/Recipes`), during a
master-plan NEW-PLAN run · **Status:** for owner review, then feed to `master-plan`

> Nothing here is fixed. This document exists so the fixes can be made deliberately later
> instead of being rediscovered. Status for this work lives in PROGRESS.md once it becomes
> plan steps — never in this file.

These are defects in the **planning system itself** — `plan_check.py` and the `master-plan`
skill — not in Plan Runner's code. They land here because Plan Runner is what drives those
projects unattended, so it is the thing that suffers when the planning system's guarantees
turn out to be conditional.

Verified 2026-07-31: `~/.claude/skills/master-plan/scripts/plan_check.py` and the Recipes
project's `planning/tools/plan_check.py` are **byte-identical**. So the canonical fix is
one file, and every project's copy is refreshed from it by a CHECK & REPAIR run.

---

## D-1 — `plan_check.py` never checks that the ACTIVE plan is LOCKED

### What happened

The Recipes project's PLAN-02 was built over 16 sessions while its frontmatter still said
`status: DRAFT`. Its whole status history is two commits:

```
4aaa396  status: DRAFT     locked: null   <- planning: PLAN-02 drafted
a6b1fe7  status: COMPLETE  locked: null   <- P02-S16, the closing commit
```

It went DRAFT → COMPLETE and was never LOCKED. `plan-hashes.json` confirms it: PLAN-02's
hash first appears in `a6b1fe7`, the closing commit. For all 16 steps there was no recorded
hash, so the plan file could have been edited mid-flight and nothing would have detected it.

### Why nothing caught it

Every immutability rule in `plan_check.py` gates on status:

| Line | Rule | Gate |
|---|---|---|
| 388 | LOCKED plan must have a Dashboard row / active board / park file | `if status == "LOCKED"` |
| 413 | must have a recorded hash | `if status in ("LOCKED", "COMPLETE")` |
| 424 | hash mismatch is a FAIL | inside the same branch |

There is **no rule asserting that the plan owning the active board is LOCKED.** A DRAFT plan
can own `## Board — PLAN-NN (active)` and be built step by step, and the checker exits 0 every
single time. The safety net is not weakened — it is never switched on.

Note the shape of the bug: line 396 already computes `if pid in active_boards:` — but only
*inside* the `status == "LOCKED"` branch. The inverse question is never asked.

### Why Plan Runner specifically cares

Plan Runner runs one step per fresh context window with nobody watching. A human running
sessions by hand might eventually notice `status: DRAFT` at the top of a plan they keep
opening. An unattended run never will, and the `docs` gate — which is in every step's
Completion criteria — stays green the whole way. The guarantee Plan Runner is implicitly
selling ("the spec is immutable, so a fresh window can trust it") is unenforced whenever a
plan is left DRAFT.

This is live right now on Recipes: PLAN-03 is LOCKED and hashed, but PLAN-04 is DRAFT and is
locked *by a step* (P03-S25). If that step is skipped, partially completed, or the chain
resumes oddly, PLAN-04 runs all 14 of its steps unhashed — exactly the PLAN-02 failure — and
the checker will not say a word.

### The fix

Roughly four lines, in `check_plans()`, outside the existing `status == "LOCKED"` branch:

```python
        # An ACTIVE plan must be LOCKED. Without this, a DRAFT plan can own the active
        # board and be built step by step with no hash recorded and no immutability
        # guarantee, and every hash rule below silently declines to fire. Recipes PLAN-02
        # ran 16 steps this way (DRAFT -> COMPLETE, hashed only at close, 2026-07-31).
        if f"PLAN-{nn}" in active_boards and status != "LOCKED":
            add("FAIL", f"PLAN-{nn} active plan is LOCKED",
                f"owns the active board with status '{status}' — lock it and run "
                "--update-hashes, or its spec is not immutable and nothing will notice")
```

`active_boards` is already in scope (defined at line 314).

### Before adopting it — the migration hazard

This rule will immediately FAIL the `docs` gate on any project whose active plan is DRAFT.
Sweep every master-plan project before landing it, or a green repo goes red on next run.

Checked 2026-07-31:
- **Plan Runner** — safe. PLAN-12 (active) is `LOCKED`; PLAN-10 (parked) is `LOCKED`; every
  other plan is `COMPLETE`.
- **Recipes** — safe. PLAN-03 (active) is `LOCKED` as of commit `4a28de5`.
- Every other master-plan project on this machine is **unchecked**. Do that sweep first.

---

## D-2 — Plan hashes are byte-based, so line endings decide them

### What happened

`plan_check.py` line 97:

```python
def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
```

Raw bytes. So a CRLF/LF difference is a different hash for identical content.

Recipes had `core.autocrlf=true` and no `.gitattributes`. That made every recorded hash
**machine-dependent**: PLAN-01 and PLAN-02 were hashed as LF and would fail on a Windows
clone; PLAN-03 was hashed as CRLF and would fail on a Unix clone. Nothing had broken yet
only because those files were created in place and never round-tripped through a checkout.

A LOCKED plan whose hash does not match is a FAIL that reads like tampering. On a first
clone to another machine, an unattended run would have halted on it.

### The trap that produced the mismatch

Python's text mode on Windows silently rewrites `\n` to `\r\n`. Measured:

```
open(p, 'w', encoding='utf-8').write('a\nb\n')              -> b'a\r\nb\r\n'
open(p, 'w', encoding='utf-8', newline='').write('a\nb\n')  -> b'a\nb\n'
```

So **any agent that edits a planning doc with a Python one-liner converts the entire file to
CRLF**, silently, including files it only meant to change one line of. On Recipes the split
was exact: every file rewritten by a Python script came out CRLF; every file touched only by
an editor tool or a shell heredoc stayed LF. This is an agent-behaviour hazard, not a
one-off — it will recur on any Windows project any time an agent reaches for Python to patch
a planning doc.

### Two candidate fixes — pick one

1. **Pin line endings per project.** The master-plan INIT template writes a `.gitattributes`
   containing `*.md text eol=lf`. This is what was applied to Recipes (commit `311f764`) and
   it is verified working: working copy == git index for all four hashed files. Cheap and
   obvious, but it is per-project, so every existing project needs the file added.
2. **Normalise before hashing.** `sha256()` reads bytes, replaces `\r\n` with `\n`, then
   hashes. One change in one file, fixes every project at once including ones nobody
   remembers, and needs no per-project artifact. Costs a one-time re-hash of every LOCKED
   and COMPLETE plan everywhere, and it means the recorded hash no longer matches a plain
   `sha256sum` of the file, which is worth a comment at the function.

Recommendation: **do both** — (2) is the real fix because it cannot be forgotten on a new
project, and (1) is still worth having so diffs and greps behave. If only one, take (2).

---

## D-3 — Self-chaining plans (informational — this one changes Plan Runner's behaviour)

Not a defect. Recorded here because it is a deliberate divergence from the shipped skill and
Plan Runner is the thing that benefits.

The `master-plan` skill and its CONVENTIONS template say a finishing plan parks:

> The build session sets `NEXT: PLAN COMPLETE — run the master-plan skill` plus an
> OWNER_TODO item; the closeout ritual is run by the master-plan skill, never the build
> session.

Plan Runner detects progress by watching `NEXT:` advance. `PLAN COMPLETE` is not a step ID,
so an unattended run **stops at every plan boundary** and waits for a human to run the skill.
On a ten-plan roadmap that is nine mandatory stops.

Recipes now does it differently, by owner ruling on 2026-07-31. Every plan's LAST step is a
close-and-convert step: it closes its own plan, converts the next scope draft from
`planning/reference/ROADMAP.md` into a locked plan file, activates it, and sets `NEXT` to
that plan's first step. `NEXT` therefore always names a real step ID and never parks. See
`planning/reference/CONVENTIONS.md` "Plan close and chaining" in the Recipes repo for the
ritual, and `P03-S25` / `P04-S14` for two worked examples — one that activates an
already-authored plan, one that converts a scope draft from scratch.

Two brakes are built in deliberately, and they are the reason this is safe to run unattended:

- **An open decision halts the chain.** A converting step may not rule on anything its scope
  draft leaves genuinely undecided. It writes the question into the new plan's §8 Open
  decisions — which blocks the steps that depend on it — and posts an OWNER_TODO item. This
  is what stops an unattended run from inventing an owner's answer.
- **A red gate halts it.** Never hand off red, never close a plan over one.

An owner-gated row deliberately does **not** halt the chain: it becomes OWNER_TODO debt and
the build continues past it, rather than deadlocking on a person who is not at the keyboard.

**The decision to make:** whether this becomes the skill's default (every plan gets a
close-and-convert final step at conversion time, and the CONVENTIONS template ships the
chaining ritual), or stays a per-project opt-in that Recipes happens to use. If it becomes
the default, the skill's `conversion-rules.md` §Plan-close ritual and the CONVENTIONS
template in `references/templates.md` both need rewriting, and SKILL.md STEP 2 needs to say
that the last step of every plan is the chaining step.

---

## Where the fixes have to land

`~/.claude/skills/master-plan/` is canonical. A CHECK & REPAIR run refreshes each project's
`planning/tools/plan_check.py` from `scripts/plan_check.py`, so a project-only edit gets
clobbered. Fix the skill first, then let CHECK & REPAIR propagate — or re-copy by hand into
any project that will not get a repair run soon.

| Defect | File to change | Then |
|---|---|---|
| D-1 | `scripts/plan_check.py` — `check_plans` | sweep every project's active plan for DRAFT first |
| D-2 | `scripts/plan_check.py` — `sha256`, plus the INIT `.gitattributes` | re-hash every LOCKED/COMPLETE plan |
| D-3 | `SKILL.md` STEP 2 · `conversion-rules.md` · `templates.md` | owner decision required before any edit |

D-1 and D-2 are both small and independent. D-3 is a design decision, not a bug, and should
not be bundled with them.

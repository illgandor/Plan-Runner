---
name: master-plan
description: >
  Convert a rough project plan into a hyper-detailed, stepped MASTER PLAN and
  standardize every planning/progress/session doc in the project — each step
  sized to one fresh Claude Code context window, a bounded PROGRESS.md
  dashboard, an immutable copy-paste SESSION_PROMPT.md, and a machine-enforced
  size/drift checker. Use when the user says "turn this plan into a master
  plan," "set up the planning system," "make this a stepped/detailed build
  plan," "organize the plans / progress docs," "add an expansion plan," "plan
  the next phase," "make a session prompt," "check/repair the planning docs,"
  or "migrate this project to the standard planning layout." Runs after Claude
  drafts an initial rough plan; re-run any time to verify, repair, and rotate.
  Distilled from what worked (TowDefender, Lantern Lock) and what collapsed
  (CutClean's 1.7MB PROGRESS.md) across the Not A Cult LLC portfolio.
---

# Master Plan — standardized planning system

Turns a rough plan into an executable, multi-session build system with four
sources of truth and no overlap: immutable **plans** (spec), a bounded
**PROGRESS.md** (state), a static **SESSION_PROMPT.md** (protocol), and
**OWNER_TODO.md** (human actions). Every structural rule is a number enforced
by `planning/tools/plan_check.py` — prose rules decay; linted rules hold.

> **Assessment-only mode:** if the user wants a review of the planning docs
> without changes ("just check it"), run STEP 1 + the checker and report only.

## STEP 0 — Detect mode

Look at the project root (the repo the user is planning, not this skill):

| Found | Mode |
|---|---|
| No `planning/` dir and no standard docs | **INIT** — first run (needs a rough draft plan) |
| Standard layout exists + a new rough draft/scope is supplied | **NEW-PLAN** — expansion |
| Standard layout exists, no new draft | **CHECK & REPAIR** — verify, rotate, fix drift |
| Legacy planning docs exist (BUILD_PLAN*.md, PROJECT_STATE.md, scattered *_PLAN.md) but no `planning/` | **ADOPT** — migrate to the standard layout |

State the detected mode before acting. All modes end with STEP 4.

## STEP 1 — Gather ground truth

1. Read the rough draft (conversation text or the file the user names).
2. Inspect the repo: what exists, what the real test/build/lint commands are —
   **run them** and record observed output (never assume green). If the project
   is not a git repo, ask the owner to approve `git init` first — step-ID
   commits are the progress spine. If declined: header slots read
   `Branch: none · HEAD: no-git` (never invent placeholder SHAs), SESSION_PROMPT
   step 6a becomes "record the step ID + a one-line summary in the session
   entry", and Facts gets a "No git: board + session log are the only
   completion evidence" bullet.
3. Ask the owner only what the repo can't answer: verbatim gate command(s),
   rulings on either/or choices found in the draft (resolve → Locked decision,
   park → Open decision that blocks its steps), and which actions are
   owner-only (accounts, payments, physical/device checks).

## STEP 2 — Decompose (INIT and NEW-PLAN)

Follow `references/conversion-rules.md` exactly. The short version:

- Draft phases → milestones → flat steps `P<NN>-S<KK>`, each sized `[S]` or
  `[M]` = one fresh Opus 4.8 (1M-token) context window. Nothing larger is a
  legal step — split it.
- Every step: 7 labeled fields (Objective / Context / Files / Approach /
  Completion criteria / Verify / Carryover), ≤40 lines, DoD decidable from the
  plan alone (no either/or), ending in a named gate + a Verify command with
  expected output.
- Freeze interfaces shared by 2+ steps in `planning/reference/CONTRACTS.md`
  **before** writing the steps that depend on them.
- Owner-only work: pre-split into `a` (agent) / `b` (owner-gated) steps or
  route to OWNER_TODO — never a DoD box an agent can't check.
- Public-facing website: P01-S01 is a password **preview gate** (full site built
  behind it; public sees a holding page). Opening it to the public is its own
  owner-gated launch step at the end. Details: `conversion-rules.md` §Website
  preview gate.

## STEP 3 — Write the standard layout

Generate every file from `references/templates.md` (exact templates there):

```
<root>/PROGRESS.md          # THE dashboard — bounded, the only status doc
<root>/SESSION_PROMPT.md    # static copy-paste bootstrap — the ONLY copy
<root>/OWNER_TODO.md        # human actions: ## Open / ## Done audit trail
<root>/CLAUDE.md            # gains one sentinel-delimited pointer block
<root>/planning/plans/PLAN-NN-<slug>.md      # immutable plans (hash-tracked)
<root>/planning/reference/  # GATES.md, CONVENTIONS.md, CONTRACTS.md, runbooks
<root>/planning/archive/    # session shards + plan closeouts (never required reading)
<root>/planning/tools/plan_check.py          # copy of scripts/plan_check.py
```

Mode specifics:
- **INIT:** write the whole tree; seed the board all-⬜; `NEXT: P01-S01`; stamp
  the source draft's header `> CONVERTED (date) → planning/plans/PLAN-01-….md
  — do not execute from this file.`; record hashes
  (`python planning/tools/plan_check.py --update-hashes`).
- **NEW-PLAN:** run CHECK & REPAIR first — never extend a drifted system. Then
  next NN, same grammar. Predecessor COMPLETE (every board row ✅/❌-with-
  amendment): closeout ritual (`references/conversion-rules.md`), swap the
  active board, Dashboard row 🔵 ACTIVE, `NEXT: P<NN>-S01`. Predecessor
  INCOMPLETE: lock the new plan but do NOT activate it — Dashboard row
  ⏳ QUEUED, predecessor's board and ▶ NEXT STEP untouched (it activates when
  the predecessor closes). Swapping early requires an explicit owner ruling to
  park the predecessor first (park procedure in `references/conversion-rules.md`).
- **CHECK & REPAIR:** run the checker; mechanically fix what it flags (rotate
  overflow to archive, rebuild missing board rows from plan headings, collapse
  lingering closed-plan boards, delete duplicate prompt copies, regenerate
  missing reference scaffolding). **Escalate, never auto-fix:** hash mismatch
  on a locked plan, board status contradicting git evidence, pointer↔log
  contradictions.
- **ADOPT:** follow the migration procedure in `references/conversion-rules.md`
  §Adopt (inventory legacy docs → map roles → archive history verbatim →
  rebuild current state into the standard files → stamp legacy docs superseded).

## STEP 4 — Verify & report

1. Run `python planning/tools/plan_check.py` from the project root — it must
   exit 0. Fix failures now; warnings go in the report.
2. Report: mode run, files written, checker result, total steps + estimated
   sessions, and print the `▶ NEXT STEP` block plus the Dashboard as the
   receipt. For INIT/NEW-PLAN also show the boot read-set size (PROGRESS.md +
   one step block — should be well under 40KB).
3. Remind the owner: start every build session by pasting SESSION_PROMPT.md.

## Reference
- `references/templates.md` — exact templates for every generated file.
- `references/conversion-rules.md` — step grammar, sizing, decomposition rules,
  plan-close ritual, ADOPT migration, budgets rationale.
- `references/preview-gate.md` — canonical password preview-gate implementation for
  public-facing websites; copied into the project as `planning/reference/preview-gate.md`
  and built as P01-S01 (see conversion-rules §Website preview gate).
- `scripts/plan_check.py` — canonical checker; copy into each project's
  `planning/tools/` (refresh the copy on CHECK & REPAIR if the skill's is newer).

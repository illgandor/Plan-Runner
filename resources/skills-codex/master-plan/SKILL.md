---
name: master-plan
description: >
  Convert a rough project plan into a hyper-detailed, stepped MASTER PLAN and
  standardize every planning/progress/session doc in the project — each step
  sized to one fresh Codex context window, a bounded PROGRESS.md
  dashboard, an immutable copy-paste SESSION_PROMPT.md, and a machine-enforced
  size/drift checker. Use when the user says "turn this plan into a master
  plan," "set up the planning system," "make this a stepped/detailed build
  plan," "organize the plans / progress docs," "add an expansion plan," "plan
  the next phase," "make a session prompt," "check/repair the planning docs,"
  or "migrate this project to the standard planning layout." Runs after Codex
  drafts an initial rough plan; re-run any time to verify, repair, and rotate.
  Distilled from what worked (TowDefender, Lantern Lock) and what collapsed
  (CutClean's 1.7MB PROGRESS.md) across the Not A Cult LLC portfolio.
metadata:
  origin: claude
  mirrored_from: master-plan
  source_sha: 7c932bd889bde65913ad9cbe0b0d45b9457211bb9837f5276080c7b06b8b2971
  twin_sha: b38557850671e27b312676dd713566e74b802e8caf02fb2cefc9b43791c52b53
  synced: 2026-07-24
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
4. **Ask: will one person drive this project, or more than one?** (INIT only —
   NEW-PLAN asks the one-line version below instead.) Verbatim:

   > Will one person drive this project, or more than one? **One** is the default
   > and costs nothing — say one and nothing changes anywhere. More than one has
   > two shapes: **relay**, where you take turns and the tool tells the other
   > person when the baton is theirs, or **parallel**, where you both run steps
   > at the same time in separate lanes. Relay works on every plan; parallel only
   > pays off on plans that actually split, which is about two thirds of them.
   > Relay first is the safe answer — moving to parallel later costs one line.
   > Which?

   One → say so in Facts; the §Shared-repo rules section is omitted, the board
   gets no roster line, and nothing changes anywhere. Relay or parallel → record
   the mode as a Locked decision in the plan being converted, and write the
   §Shared-repo rules block of CONVENTIONS.md with its mode-and-drivers line plus
   the board's roster line (`references/templates.md` §1 and §6). It changes no
   step spec — it sets the close-out discipline that keeps two drivers from
   colliding.

   **In NEW-PLAN ask this instead, and only in a non-solo project** — one line,
   because the mode is already recorded and the answer is almost always "same".
   A paragraph every plan is how an opt-in becomes noise the owner declines
   reflexively. Fill in the recorded drivers, mode and plan id:

   > This project is set up for two drivers (tyler, reno) in **relay** mode. Same
   > for PLAN-05, or does this one change?

   **Ask the driver's own lane name** only when the mode is not solo AND
   `planRunner.presenceName` is unset. Verbatim:

   > What is your lane name? It has to match `planRunner.presenceName` in your VS
   > Code settings — the same string is the lane, the claim's driver, and the
   > name on the presence dashboard.

   Never ask for that name again under a different label — two labels make two
   names for one identity, and display names that differ are invisible to each
   other on the presence dashboard. Write the answer into §Shared-repo rules.

   A **chained** conversion (item 5) re-asks none of these three: it carries the
   recorded mode and drivers forward unchanged, or it does not chain.
5. **Ask: should each plan hand off to the next one by itself?** (INIT, after the
   roadmap scope is known.) **Ask only when something is queued after this plan** —
   no ROADMAP, no plan named after this one, or a one-plan project all mean there is
   nothing to chain to, and a project with nothing following must not be prompted.
   Never retro-fit it on ADOPT: a LOCKED plan is never edited, so the chaining step
   lands in the next plan authored. Verbatim:

   > Should each plan hand off to the next one by itself? The last step of every plan
   > would close that plan — auditing each step against the repo — then convert the
   > next scope draft from your ROADMAP into a locked plan and point at its first
   > step, so an unattended run never stops at a plan boundary. It stops for the
   > things that need you: any decision the draft leaves genuinely open blocks its own
   > steps and lands in OWNER_TODO. **Yes** is the answer if your ROADMAP names more
   > than one plan; say no and each boundary waits for you instead.

   Yes → record it as a Locked decision, author the close-and-convert final step
   (`references/conversion-rules.md` §Close-and-convert), and include the
   §Plan close and chaining block of CONVENTIONS.md (`references/templates.md` §6).
   No → omit that block and nothing else changes. Nothing machine-readable stores the
   answer: the presence of the step IS the declaration, and a project that changes its
   mind edits the next plan it authors.

## STEP 2 — Decompose (INIT and NEW-PLAN)

Follow `references/conversion-rules.md` exactly. The short version:

- Draft phases → milestones → flat steps `P<NN>-S<KK>`, each sized `[S]` or
  `[M]` = one fresh Codex context window. Nothing larger is a
  legal step — split it.
- Every step: 7 labeled fields (Objective / Context / Files / Approach /
  Completion criteria / Verify / Carryover), ≤40 lines, DoD decidable from the
  plan alone (no either/or), ending in a named gate + a Verify command with
  expected output.
- Freeze interfaces shared by 2+ steps in `planning/reference/CONTRACTS.md`
  **before** writing the steps that depend on them.
- Owner-only work: pre-split into `a` (agent) / `b` (owner-gated) steps or
  route to OWNER_TODO — never a DoD box an agent can't check.
- Chained project (the STEP 1 chaining question answered yes): the plan's LAST step
  is the close-and-convert chaining step — it closes this plan, converts the next
  ROADMAP scope draft in relay shape, and points `NEXT` at that plan's first step.
  See `conversion-rules.md` §Close-and-convert. The final plan on the roadmap has
  nothing to chain to and ends with the ordinary parking close.
- Parallel project (the STEP 1 mode question answered parallel): after
  decomposition, derive the split with `plan_check.py --lanes PLAN-NN` and put it
  to the owner verbatim, both refusals included — they end in a serial plan, never
  in a question. The override is re-derivation with the named steps pinned; a
  hand-edited roster is a defect. Solo, relay, and EVERY chained conversion emit
  none of it (a chained plan starts serial). Wording: `conversion-rules.md`
  §Lane proposal.
- Public-facing website: P01-S01 is a password **preview gate** (full site built
  behind it; public sees a holding page). Opening it to the public is its own
  owner-gated launch step at the end. Details: `conversion-rules.md` §Website
  preview gate.

## STEP 3 — Write the standard layout

Generate every file from `references/templates.md` (exact templates there).

**Every path you write is repo-root-relative** — no drive letters, no `~`, no
home/vault/user folders, no machine names. Write "the repo root", never the
absolute path of the folder you are sitting in. SESSION_PROMPT.md and LOCKED
plans are hash-locked, so a machine path in one of them can never be fixed in a
clone without breaking everyone else's hash.

```
<root>/PROGRESS.md          # THE dashboard — bounded, the only status doc
<root>/SESSION_PROMPT.md    # static copy-paste bootstrap — the ONLY copy
<root>/OWNER_TODO.md        # human actions: ## Open / ## Done audit trail
<root>/AGENTS.md            # gains one sentinel-delimited pointer block
<root>/.gitattributes      # `*.md text eol=lf` — keeps hashed docs byte-stable
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

## Self-improvement closer — intentionally omitted
<!-- closer: intentionally-omitted -->
This skill deliberately ships without the improvement-retrospective closer the
authoring guide otherwise mandates. master-plan is the planning system's own
machinery; it must stay stable, not rewrite itself mid-run. Changes to it are
deliberate owner edits, never a per-invocation retrospective. The catalog honors
this marker and does not flag the omission.

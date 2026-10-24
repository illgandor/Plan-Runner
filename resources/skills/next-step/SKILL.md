---
name: next-step
description: >
  Execute exactly ONE step of a project on the master-plan planning system,
  end-to-end: read PROGRESS.md's ▶ NEXT STEP, load only that step's spec, verify
  the gate is green, implement it, then close out (commit, update PROGRESS.md,
  run plan_check.py to exit 0, push). The execution counterpart to the master-plan
  skill — it automates the SESSION_PROMPT.md protocol so you never hand-paste it.
  Use when the user says "next step," "do/run/work the next step," "continue the
  build," "execute the next planning step," "what's next on this project," or
  "build the next step." Only for repos with PROGRESS.md + a planning/ directory
  (a master-plan project); if that layout is absent, tell the owner to run the
  master-plan skill first. Runs one step per invocation and then stops — it never
  chains into the following step.
---

# Next Step — execute one master-plan step

Advances a master-plan project by exactly one step and leaves it green,
committed, and doc-clean. This is the running counterpart to the planning
`master-plan` skill: `master-plan` writes the plan; `next-step` executes it, one
bounded step at a time.

> **Fresh context is the whole point.** Each step is sized for one fresh Opus 4.8
> (1M-token) window. Run this in a NEW session (or `/clear` first) — a session
> already full of unrelated work defeats the bounded-read design. If the owner
> says "assessment only," do STEP 0–2 and report the step; don't implement.

## STEP 0 — Confirm it's a master-plan project
Require at the repo root: `PROGRESS.md`, `SESSION_PROMPT.md`, and a `planning/`
directory. If any is missing, STOP and tell the owner to run the **master-plan**
skill to set up (or ADOPT) the planning system first. Do not improvise a plan.

## STEP 1 — Read PROGRESS.md, find the one step
Read all of PROGRESS.md (it is size-capped, so this is cheap). Find `## ▶ NEXT
STEP`; it names one step ID and one plan file.
- `NEXT: PLAN COMPLETE` or `NEXT: none` → STOP: there is no step to run. Tell the
  owner to run **master-plan** (to close out the plan / start the next one).
  Do not invent work.
- Otherwise note the step ID, its plan file, and the ▶ NEXT STEP orientation.

## STEP 2 — Load ONLY that step
In the named plan file, read just that step's block (search `[<step-id>]`), plus
whatever its **Context** field cites (reference §, CONTRACTS.md §, prior step
IDs) and the previous step's **Carryover**. Do NOT read whole plan files or
`planning/archive/` — that boot tax is exactly what the system exists to avoid.
State the step ID and its Objective verbatim before touching code.

## STEP 3 — Verify green FIRST
Run the gate named in the step's last Completion box (commands in
`planning/reference/GATES.md`). If it is already red, fixing it is the first part
of your job — you may not build on a red base.
Also run `git status`; if the tree is dirty from a crashed session, finish-and-commit
or reset that leftover work before implementing — never build on top of it.
If CONVENTIONS.md has a §Shared-repo rules section, this repo has more than one
driver: `git fetch` and STOP if the branch is behind its upstream. The commits you
are missing include someone else's close-out, so STEP 1's pointer was stale and the
step you just loaded may already be done. Tell the owner to `git pull --ff-only`.

## STEP 4 — Implement exactly that one step
Satisfy every Completion-criteria box and the Verify command — no more, no less.
- **Plan files are immutable.** Any deviation from spec is a dated ≤3-line
  Amendment in PROGRESS.md (`- A-P<NN>-<##> (date, affects <steps>): …`), never
  an edit to a plan file.
- **Owner-gated work** (`[owner-gate: yes]`, or anything only the owner can do —
  accounts, real payments, DNS, physical/device checks): do the agent-doable
  slice, then STOP at the gate. Add an OWNER_TODO `## Open` item tagged with the
  step ID. Never tick a DoD box only the owner can verify.

## STEP 5 — Close out (same invocation, in this order)
1. **Commit** as `"<step-id>: <title>"`; narrative detail goes in the commit
   body, nowhere else. Deploy steps: set any new env vars FIRST, then verify the
   deploy before continuing. (No-git project: record the step ID + a
   one-line summary in the session entry instead of committing.)
2. **Update PROGRESS.md in one pass:** refresh the header `Updated:` line (date ·
   session · branch · HEAD — record HEAD as the **step's code commit** from 5.1,
   the substantive artifact, not the later doc-closeout commit); flip the board
   row (glyph + Done cell); update the
   Dashboard count; advance `▶ NEXT STEP` (pointer only — after a plan's last
   step write `NEXT: PLAN COMPLETE — run the master-plan skill`); refresh
   Blockers/Environment; prepend ONE 6-field session entry (`Did / Verified /
   Decisions / Handoff / Next / Notes`); rotate the oldest entry past 3 into
   `planning/archive/` (shard rules: `planning/reference/CONVENTIONS.md`).
3. **OWNER_TODO.md:** add any human-only work to `## Open`, tagged with the
   step ID.
4. **Run `python planning/tools/plan_check.py` — it must exit 0** before you
   stop. Fix any FAIL and re-run. Never hand off a red build or a failing check.
5. **Commit the doc closeout** as a separate `planning: close out <step-id>`
   commit (keeps 5.1's step commit clean; matches the repo's `planning:`-prefixed
   convention). Do this after plan_check is green so the committed docs are the
   verified ones. Leave the working tree clean at handoff.
6. **Push to the remote** if the repo has an upstream: `git push` the current
   branch, **fast-forward only — never force**. This is a backup/sync so a step's
   work can't strand on one machine and progress stays visible on the host; it is
   NOT a deploy (going live stays gated to deploy steps, 5.1). No remote or no
   upstream set → skip, and say so in the session entry's Handoff so the owner
   can publish the branch deliberately.

## Close-out review — two axes, never merged
Close-out reviews the step's own code on TWO axes, run separately and reported
side by side under their own headings in the close-out summary:
- **Spec** — does it do what the step said? Every Completion-criteria box and the
  Verify command; nothing invented, nothing quietly dropped.
- **Standards** — does it follow THIS repo's standards, whatever the spec said?

**Never merge the two, and never rerank one against the other.** They answer
different questions and either can be clean while the other is wrecked: code can
follow every convention and implement the wrong thing, or match the spec exactly
and trash the conventions. Merged into one ranked list, the healthy axis dilutes
the sick one and the reader learns to skim both. Report both even when one is
empty — "Standards: nothing" is a result, not a blank.

**The Standards axis is MANDATORY when the step is risky.** Risk is DERIVED from
the fields the step already has — it is never declared, and it adds no new step
field. A step is risky when its `**Files:**` touch any of:
- **release or packaging** — CI workflows, `package.json`/lockfile, version or
  tag, publish scripts, vendored copies;
- **auth, secrets or tokens**;
- **payments or money**;
- **schema or data migrations**;
- **destructive paths** — delete, reset, force-push, overwrite, `rm -rf`;
or when the step is `[owner-gate: yes]` — a human is being asked to trust it.
On any other step the axis is optional: run it when it is cheap, skip it when it
is not. Mandatory means mandatory; optional means genuinely optional.

**Skip anything tooling already enforces.** If lint, the formatter, the type
checker or `plan_check.py` would have caught it, it is not a review finding. A
review that re-reports lint output trains the reader to ignore it.

Findings that are real but outside this step go to OWNER_TODO or the next plan —
never silently into the code, which would make the step exceed its own spec.

### What "this repo's standards" means
Two rules bind, and they bind in this order:
1. **A documented repo standard overrides the baseline below.** `CLAUDE.md`,
   `planning/reference/CONVENTIONS.md`, `CONTRACTS.md`, and the pattern the
   surrounding code already uses ARE the standard. The baseline is the floor for a
   repo that documents nothing — never a stick to beat a documented choice with.
2. **Every smell is a labelled judgement call, never a hard violation.** Name the
   smell, say why it bites *here*, name the fix, and say whether it is worth doing
   now. "Present, and fine in context" is a complete finding.

The baseline is Fowler's first twelve smells, each with the refactoring that
answers it:

| # | Smell | The fix |
|---|---|---|
| 1 | Mysterious Name | Rename it — function, variable, field, whatever is lying. |
| 2 | Duplicated Code | Extract Function over the copies (Pull Up Method if siblings). |
| 3 | Long Function | Extract Function; Replace Temp with Query; Decompose Conditional. |
| 4 | Long Parameter List | Preserve Whole Object; Introduce Parameter Object. |
| 5 | Global Data | Encapsulate Variable — one owner, one mutation site. |
| 6 | Mutable Data | Encapsulate Variable; Split Variable; Remove Setting Method. |
| 7 | Divergent Change | Split Phase / Extract Class — one module, one reason to change. |
| 8 | Shotgun Surgery | Move Function/Field until one change lands in one place. |
| 9 | Feature Envy | Move Function to the data it keeps reaching across for. |
| 10 | Data Clumps | Extract Class; Introduce Parameter Object for the recurring group. |
| 11 | Primitive Obsession | Replace Primitive with Object; Replace Type Code with Subclasses. |
| 12 | Repeated Switches | Replace Conditional with Polymorphism. |

## If the step overflows the window
Reach a green sub-state, commit it, split the step in PROGRESS.md (`<id>a` ✅ +
new row `<id>b` ⬜ + `NEXT: <id>b`), log a one-line Amendment. Never end red.

## If the runner says `diagnosing` — Phase 1 before any hypothesis
The runner detects "stuck" from the ledger, never from your own read of how it is
going, and opens `.plan-runner/diagnostics/<step-id>.md`. It writes the reason and
the empty headings; you fill them. Diagnosing does not restart or abandon the step —
it changes the method, not the run.

**The refusal.** Until you can name ONE command you have ALREADY RUN that is
**red-capable**, **deterministic**, **fast**, and **agent-runnable**, you may not
state a hypothesis, may not guess at a cause, and may not edit a source file. No
such command yet → your only permitted work is building one. Paste the exact
invocation AND its real output into the artifact: a command you did not run cannot
be proven tight, and a pasted transcript is the proof.
- **Red-capable** means it asserts the actual symptom and fails *because of it*, and
  can go green once the bug is fixed. "Runs without erroring" is not red-capable —
  it cannot distinguish fixed from never-broken, and that distinction is the rule.
- **Deterministic**: same input, same verdict, every run. **Fast**: seconds, so you
  can afford to run it after every change. **Agent-runnable**: no owner, no GUI, no
  device — you can run it yourself, unattended.

Fill all seven sections, in this order: **Repro command + observed output** ·
**Expected vs actual** · **Minimised case** · **Ranked falsifiable hypotheses** ·
**Instrumentation tag** · **Confirmed cause** · **Regression test**. Rank
hypotheses by what a cheap experiment could *kill*, not by what feels likely.

**Tagged instrumentation is a close condition.** Every debug log you add carries one
unique prefix (record it under *Instrumentation tag*), and the step may not close
until a grep for that tag comes back empty. The regression test is what survives the
instrumentation — it fails on the old code and passes on the new.

## Guardrails
- **One step, then stop.** Do not roll into the next step — bounded scope is the
  design. The owner re-invokes (ideally in a fresh session) for the next one.
- **Escalate, don't auto-fix**, if plan_check reports a LOCKED-plan hash
  mismatch, a board status that contradicts git, or a pointer↔log contradiction.
  Surface it for an owner ruling — that is master-plan CHECK & REPAIR territory,
  not step work.
- **Unplanned / hotfix work** still gets a session entry (step field
  `unplanned: <reason>`) and an Amendment if it touched spec.

## Reference
- The project's own `planning/reference/CONVENTIONS.md` — authoritative for this
  repo's rotation / split / amendment specifics.
- The `master-plan` skill — planning, CHECK & REPAIR, plan close, ADOPT, and the
  budgets enforced by `plan_check.py`.

## Self-improvement closer — intentionally omitted
<!-- closer: intentionally-omitted -->
This skill deliberately ships without the improvement-retrospective closer the
authoring guide otherwise mandates. next-step is the planning system's own
execution machinery; it must stay stable, not rewrite itself mid-run. Changes to
it are deliberate owner edits, never a per-invocation retrospective. The catalog
honors this marker and does not flag the omission.

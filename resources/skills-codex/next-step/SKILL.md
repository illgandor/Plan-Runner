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
metadata:
  origin: claude
  mirrored_from: next-step
  source_sha: b7fd0a9ae097f8e6ee2b5ef2c632fbdbae9cb110f456768c582a1f214912b8c8
  twin_sha: 892c9cd9f631f17b6e4adf244a8f7331493762f233d23bdb432c906df4ec2d03
  synced: 2026-07-15
---

# Next Step — execute one master-plan step

Advances a master-plan project by exactly one step and leaves it green,
committed, and doc-clean. This is the running counterpart to the planning
`master-plan` skill: `master-plan` writes the plan; `next-step` executes it, one
bounded step at a time.

> **Fresh context is the whole point.** Each step is sized for one fresh Opus 4.8
> (1M-token) window. Run this in a NEW session (or clear context first) — a session
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

## If the step overflows the window
Reach a green sub-state, commit it, split the step in PROGRESS.md (`<id>a` ✅ +
new row `<id>b` ⬜ + `NEXT: <id>b`), log a one-line Amendment. Never end red.

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

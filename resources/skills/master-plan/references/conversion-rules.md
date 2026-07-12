# Conversion rules — reference for the master-plan skill

How to decompose a rough draft into a master plan, run the plan-close ritual,
and migrate legacy projects. Templates live in `templates.md`; this file is the
judgment layer.

---

## Step grammar & sizing

A **step** is the unit one fresh Claude Code session executes end-to-end.

1. **Size to one context window.** The reference window is one fresh **Opus 4.8
   (1M-token)** Claude Code session — the model the owner runs by default; size
   against that, not a smaller model's budget. At 1M tokens raw token count is
   rarely the binding limit, so the heuristics below (not token math) are what
   actually cap a step. `[S]` = light session, `[M]` = full session. `[L]` is
   not a legal size — split until everything is S or M. Heuristics for "too big":
   touches more than ~6 files meaningfully; needs more than ~10 Approach bullets;
   has two unrelated Verify commands; mixes agent work with owner work; or you
   can't state one Objective sentence.
2. **Self-contained.** A fresh session reads ONLY: PROGRESS.md + this step's
   block + what its Context field cites + the previous step's Carryover (a
   plan's first step has none). If the
   step needs more than 3 Context pointers, it's carrying hidden coupling —
   either freeze the shared thing in CONTRACTS.md or re-split.
3. **Decidable DoD.** Every Completion-criteria box must be checkable from the
   plan alone. What's banned is an *unmade choice about what to build* —
   "either…or", "and/or", "TBD", "decide later", "if the owner prefers". A box
   that accepts a set of observable results ("returns 200 or 201") is fine — the
   linter no longer flags a bare "or". Unresolved choices go to §8 Open decisions
   and BLOCK their steps until an owner ruling (recorded as an Amendment) resolves
   them.
4. **Machine-verifiable close.** The last DoD box names a gate from GATES.md.
   The Verify field gives a command + expected observable output ("70/70 PASS",
   "curl :3000/billing → 200 with price table"). Steps with no runnable
   verifier get an observable-output check ("screenshot reviewed: X visible") —
   design against the verifier, not your mental model (Lantern Lock).
5. **Owner-gating at planning time, not by accident.** Any human-only action
   (create account, real payment, physical/device check, DNS) is:
   - pre-split: `S07a` (agent-doable code slice) / `S07b` (owner-gated
     verification), with `[owner-gate: yes]` on the b-step, AND
   - mirrored as an OWNER_TODO item tagged with the step ID.
   Four TowDefender amendments were exactly this discovery made late — make it
   at conversion time.
6. **Carryover is a first-class field.** Gotchas the NEXT session must know
   ("custom Fabric props MUST go in HISTORY_PROPS or they vanish") go in the
   finishing step's Carryover, ≤3 lines. This is DMGoblin's proven forward-feed
   pattern.
7. **Contracts before dependents.** Any file path, signature, schema, or ID
   shared by 2+ steps is frozen in §5 / CONTRACTS.md BEFORE the steps that use
   it are written. If steps will run as parallel agents, add a serialized
   "Stage-0" step that lands the contract files first (Schlorm's rule).

## Decomposition procedure (INIT / NEW-PLAN)

1. Extract from the draft: mission, hard constraints, phases, and every
   decision it silently assumes. Surface each assumption as Locked (owner
   confirms) or Open (blocks steps).
2. Map phases → milestones (M1..). Every milestone gets a one-line goal and an
   observable milestone gate.
3. Slice milestones into steps under the grammar above. Number flat: P02-S01..
   S18 in execution order. Order so every `[deps:]` points backward; cross-plan
   deps (`[deps: P01-S14]`) are legal, forward deps are not.
4. Write the estimates table (steps + est. sessions per milestone) and the cut
   order under pressure (what drops first; what is never cut).
5. Self-lint before presenting: every step ≤40 lines with all 7 fields; DoD
   decidable; ≤30 steps per plan (a bigger backlog is two plans); plan file
   ≤96KB. Run `plan_check.py` — the plan must pass before it locks.
6. Present the plan (step count, session estimate, open decisions needing
   rulings). On approval: `status: LOCKED`, record the date, run
   `plan_check.py --update-hashes`.
7. Stamp the source draft's header:
   `> CONVERTED (date) → planning/plans/PLAN-NN-<slug>.md — do not execute from
   this file.` (DMGoblin's orphaned root plan is the anti-pattern.)

## Plan-close ritual (when the active plan's last step flips ✅)

Run when every board row is ✅/❌-with-amendment and the plan's mission holds:

1. Stamp the plan file's frontmatter `status: COMPLETE`, `completed: <date>` —
   the only permitted post-lock edit — and re-run `--update-hashes`.
2. Generate `planning/archive/PLAN-NN-CLOSEOUT.md` (template §9): final board
   moved verbatim, the plan's amendments, retired decisions, milestone rollup.
3. In PROGRESS.md: flip the Dashboard row to ✅ COMPLETE; replace the active
   board with nothing (or the next plan's all-⬜ board); add one line under
   `## Completed plans` linking the closeout; sweep this plan's amendment lines
   out of the hot ledger.
4. Set `NEXT:` to the next plan's first step, or
   `NEXT: none — no active plan (run master-plan with a new draft)`.
5. Run `plan_check.py` to exit 0. Commit as `PLAN-NN: closed`.

## Plan-park procedure (owner ruling required)

To set aside an INCOMPLETE plan (e.g. the owner wants a new plan active now):

1. Record the ruling as one Amendment (`A-P<NN>-<##> … parked by owner ruling`).
2. Write `planning/archive/PLAN-NN-PARKED.md`: the full board moved verbatim +
   resume notes (what was in flight, gotchas). Flip every non-✅ row to ⏸️
   there.
3. Dashboard row → `⏸️ PARKED n/N`. Do NOT edit the plan file — it stays
   LOCKED so its hash remains valid (`status: COMPLETE` remains the only
   permitted post-lock edit).
4. Resume = rebuild the board verbatim from the park file, flip the Dashboard
   row back to 🔵 ACTIVE, set `NEXT:` to its first non-✅ step.

Without a ruling, a new plan enters as ⏳ QUEUED and the incomplete
predecessor keeps its board and the ▶ NEXT STEP pointer.

## CHECK & REPAIR specifics

Fix mechanically (no judgment needed): rotate session entries past 3 into the
current archive shard (25/shard, then a new shard); rebuild missing board rows
from plan step headings (status from step-ID-prefixed commits where provable,
else ⬜ + a warning); collapse a closed plan's lingering board; delete duplicate
copies of the session prompt (keep SESSION_PROMPT.md, leave a link); re-wrap
>120-char lines; sweep >20 live decisions into the archive; refresh
`planning/tools/plan_check.py` from the skill's `scripts/` copy if outdated;
recreate missing `planning/reference/` scaffolding from templates.md —
CONVENTIONS.md verbatim (preserving its Project-specific additions section);
GATES.md rebuilt from the gate names cited in the active plan's DoD boxes with
commands recovered from PROGRESS.md Facts.

Escalate to the owner (never auto-fix): hash mismatch on a LOCKED plan (show
the diff; owner picks revert vs convert-the-edit-to-an-Amendment + re-lock);
board ✅ with no matching step-ID commit; the newest session entry's `Next:`
disagreeing with `▶ NEXT STEP`; a cited gate whose command cannot be recovered
from PROGRESS.md or git history (owner supplies it — never invent a gate
command); anything that would rewrite status the human may have set
deliberately.

## §Adopt — migrating a legacy project

For projects with pre-standard docs (BUILD_PLAN*.md + PROGRESS.md at CutClean
scale, PROJECT_STATE.md at Lantern Lock, scattered *_PLAN.md at DMGoblin).
Goal: standard layout with zero history loss and no rewriting of the past.

1. **Inventory.** List every planning-ish doc with size and role (plan / status
   / protocol / human-actions / reference / report). Show the mapping to the
   user before touching anything.
2. **Archive history verbatim.** Create `planning/archive/legacy/` and MOVE the
   dead weight there unchanged (old session narratives, superseded plans,
   point-in-time reports). Git preserves the move; nothing is deleted.
3. **Extract the living plan.** Steps not yet done in the legacy plan(s) become
   a fresh `PLAN-NN-<slug>.md` (converted to the standard grammar — this is a
   real decomposition pass, not a copy). Completed legacy work is NOT re-planned:
   it becomes one closeout-style summary file per legacy plan era in
   `planning/archive/`, plus Dashboard rows marked ✅ LEGACY with step counts.
4. **Rebuild state.** Write fresh PROGRESS.md: Dashboard (legacy eras + the new
   plan), board for the new plan, Blockers/Environment/Facts distilled from the
   legacy status docs (curate — do not paste narratives). Facts gets the
   hard-won pitfalls (they are the most valuable legacy content).
5. **Standard files.** SESSION_PROMPT.md, OWNER_TODO.md (migrate open items,
   dated), GATES.md, CONVENTIONS.md, CLAUDE.md pointer block, plan_check.py.
6. **Stamp every legacy doc's header** with
   `> SUPERSEDED (date) → see PROGRESS.md / planning/ — kept for history.`
   and confirm no legacy doc still claims to be current anywhere.
7. Run `plan_check.py` to exit 0; commit as `planning: adopted standard layout`.

**Terminal ADOPT (no undone legacy steps).** If the legacy plan(s) are fully
complete — nothing left to decompose (TowDefender at end-of-v1) — there is no
fresh `PLAN-NN`: `planning/plans/` starts empty (keep it with a `.gitkeep`),
the completed era becomes a `PLAN-NN-…-CLOSEOUT.md` in `planning/archive/` with
a Dashboard row `✅ LEGACY`, and PROGRESS.md carries **no active board** and
`NEXT: none — <era> complete; no active plan`. This is a legal end state, not
an error (the checker requires `planning/plans/` to exist, not to be non-empty,
and accepts `NEXT: none`). Any residual live work is owner-gated (deploy,
activation, verification) → OWNER_TODO + the Environment register, never
manufactured into plan steps. The next real backlog (v2) enters later via a
NEW-PLAN run against a fresh draft.

## Why these numbers (budget rationale — keep in sync with plan_check.py)

- **PROGRESS.md 32KB/400 lines:** CutClean hit 1.7MB; TowDefender's 100KB cap
  never fired in 37 sessions (an unexercised bound is no bound). 32KB fits a
  30-step board + all registers + 3 entries with ~30% headroom, and rotation
  fires from session 4, so the mechanism is continuously exercised.
- **3 hot session entries:** the last handoff + notes is what a fresh session
  needs; everything older is audit material (archive). CutClean's 105-entry log
  was 512KB.
- **240 chars/field, not "lines":** TowDefender proved line-counted caps get
  gamed with 130-char crammed lines.
- **≤120-char lines:** CutClean's 7,957-char single lines broke grep/diff/
  partial reads — 2,435 "lines" masked 1.7MB. (Lines containing URLs are
  exempt in the checker.)
- **Plan ≤96KB / ≤30 steps:** a plan whose steps fit one context window must
  itself be navigable; BUILD_PLAN_PART4.md (345KB) was unreadable in a session.
  Bigger backlog = two plans, by construction.
- **Step ≤40 lines:** past that, a step is smuggling design-doc work that
  belongs in reference/ or is actually two steps.
- **Hashes for immutability:** CutClean's "byte-immutable" plan was appended
  into four times. A declaration isn't enforcement; a recorded SHA-256 is.

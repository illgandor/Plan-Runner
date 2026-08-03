#!/usr/bin/env python3
"""plan_check.py — conformance checker for the master-plan planning system.

Stdlib-only. Copied into each project at planning/tools/plan_check.py by the
master-plan skill. Run from the project root (or pass --root):

    python planning/tools/plan_check.py                 # check; exit 0 = pass
    python planning/tools/plan_check.py --update-hashes # record immutable-file hashes
    python planning/tools/plan_check.py --lanes PLAN-12 # derived lane split; read-only

Every budget here is the source of truth for the numbers quoted in
planning/reference/CONVENTIONS.md and the master-plan skill docs.
FAIL = exit 1 (session may not hand off). WARN = printed, exit still 0.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------- budgets
PROGRESS_MAX_BYTES = 32_768
PROGRESS_MAX_LINES = 400
LINE_MAX_CHARS = 120
NEXT_BLOCK_MAX_LINES = 6
SESSION_ENTRIES_MAX = 3
SESSION_FIELD_MAX_CHARS = 240
SESSION_ENTRY_MAX_LINES = 16
FACTS_MAX_BULLETS = 15
DECISIONS_MAX_LIVE = 20
DECISION_MAX_CHARS = 160
AMENDMENT_MAX_LINES = 3
PLAN_MAX_BYTES = 98_304
PLAN_MAX_LINES = 1_200
PLAN_MAX_STEPS = 30
STEP_MAX_LINES = 40
PROMPT_MAX_BYTES = 3_584
CLAUDE_WARN_BYTES = 8_192
ARCHIVE_SHARD_MAX_ENTRIES = 25
LANE_WIDTH = 2  # the N=2 assumption; wider schedules exist but are out of scope

SESSION_FIELDS =["Did", "Verified", "Decisions", "Handoff", "Next", "Notes"]
STEP_FIELDS = ["**Objective:**", "**Context:**", "**Files:**", "**Approach:**",
               "**Completion criteria:**", "**Verify:**", "**Carryover:**"]
STATUS_GLYPHS = {"⬜", "🔧", "✅", "⏸️", "⏸", "❌", "👤⬜", "👤🔧", "👤✅"}
PROMPT_SENTINEL = "One step is your entire job today."
FORBIDDEN_PROGRESS = ["<details>", "Why this state", "Full detail in"]

# Machine-local paths in planning docs. A clone lands wherever its owner puts it,
# so a path that locates THIS repo on one machine is wrong everywhere else — and
# in a hash-locked doc (SESSION_PROMPT.md, a LOCKED plan) it can never be fixed
# downstream without breaking the hash for the other clone. Deliberately narrow:
# drive letters, UNC shares, POSIX home roots, and elided path prefixes ("…/x").
# NOT bare "~/" or generic a\b\c — projects legitimately document external tool
# locations (~/.claude, %LOCALAPPDATA%\…\codex.exe), and a check that cries wolf
# is a check people stop reading.
ABS_PATH_RE = re.compile(
    r"(?<![A-Za-z])[A-Za-z]:[\\/]"          # C:\ or C:/ — not http:// (p preceded by a letter)
    r"|\\\\[A-Za-z0-9_.$-]+\\"              # \\server\share
    r"|/(?:home|Users|mnt)/"                # /home/x  /Users/x  /mnt/c
    r"|(?:…|\.\.\.)[\\/][\w .()-]")         # …/03 Projects — a truncated absolute path
PATH_SCAN_GLOBS = ["PROGRESS.md", "SESSION_PROMPT.md", "CLAUDE.md", "AGENTS.md",
                   "planning/**/*.md"]

STEP_ID_RE = re.compile(r"P\d{2}-S\d{2}[ab]?")
STEP_HEADING_RE = re.compile(r"^#### \[(P\d{2}-S\d{2}[ab]?)\]")
# The pointer grammar, shared with the runner's reader. The optional `[<lane>]` is the
# lane-qualified form for a multi-driver project; a bare `NEXT:` is the solo form and is
# unchanged. `WAIT <step-id>` says this lane is resting on another lane's step — like
# PLAN COMPLETE / none it is a resting state, not a cursor into a plan.
# Group 1 = the lane (None when bare) · group 2 = the target.
NEXT_RE = re.compile(
    r"^NEXT(?:\[([^\]]+)\])?: "
    r"(P\d{2}-S\d{2}[ab]?\b|PLAN COMPLETE\b|none\b|WAIT P\d{2}-S\d{2}[ab]?\b)")
SESSION_HEAD_RE = re.compile(r"^### (S\d{4}) ")
# `## Session log` (the solo form) or `## Session log — <driver>` (one section per
# driver). Group 1 = the driver, None when bare. The driver string IS the pointer's
# lane, so per-lane coherence can find the section belonging to a given cursor.
SESSION_LOG_RE = re.compile(r"^## Session log(?:\s+—\s+(\S+))?")
PLAN_FILE_RE = re.compile(r"^PLAN-(\d{2})-[a-z0-9][a-z0-9-]*\.md$")
SHARD_FILE_RE = re.compile(r"^SESSIONS-\d{4}-\d{4}\.md$")
AMENDMENT_RE = re.compile(r"- A-P\d{2}-\d{2} ")
# Flags an UNMADE choice about what to build, not any legitimate acceptance set.
# A bare "or" ("returns 200 or 201", "editor or viewer role") is NOT banned —
# only either…or / and/or / TBD / decide-later / if-the-owner constructions.
DOD_BANNED_RE = re.compile(
    r"\beither\b|\band/or\b|\bTBD\b|decide later|to be decided|"
    r"to be determined|if the owner|if we decide",
    re.I)


def has_sentinel(text):
    """Wrap-tolerant sentinel match (a re-wrapped copy must still be caught)."""
    return PROMPT_SENTINEL.lower() in " ".join(text.split()).lower()

results = []  # (level, check, detail)


def add(level, check, detail=""):
    results.append((level, check, detail))


def read(path: Path):
    return path.read_text(encoding="utf-8", errors="replace")


def sha256(path: Path):
    # CRLF is normalised to LF BEFORE hashing, so a plan hashes the same on every
    # machine (git autocrlf, a Windows checkout, or a Python text-mode rewrite all
    # change bytes without changing content). This means the recorded hash is
    # deliberately NOT `sha256sum <file>` — do not "fix" it back to raw bytes.
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def sections(lines, heading_prefix):
    """(start, end) line indexes of EVERY section whose ## heading starts with
    heading_prefix, each ending before the next ## heading. [] if absent.
    Use this wherever a heading may legitimately repeat: section() below stops at
    the first, which is how a second driver's session log went wholly unchecked."""
    out, start = [], -1
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            if start != -1:
                out.append((start, i))
                start = -1
            if ln.startswith("## " + heading_prefix):
                start = i
    if start != -1:
        out.append((start, len(lines)))
    return out


def section(lines, heading_prefix):
    """Return (start, end) line indexes of the FIRST section whose ## heading starts
    with heading_prefix, ending before the next ## heading. (-1,-1) if absent."""
    found = sections(lines, heading_prefix)
    return found[0] if found else (-1, -1)


def files_field(block):
    """A step's **Files:** value: the rest of its line plus any continuation
    lines, ending at the next field, bullet or blank line."""
    for j, ln in enumerate(block):
        if ln.startswith("**Files:**"):
            out = [ln[len("**Files:**"):]]
            for nxt in block[j + 1:]:
                if not nxt.strip() or nxt.startswith("**") or nxt.lstrip().startswith("- "):
                    break
                out.append(nxt)
            return " ".join(out).strip()
    return ""


def files_tokens(field):
    """Split a footprint on , ; · + and ' and ' — ONLY at parenthesis depth 0.
    Without the depth guard `src/usage.js (new, ported)` splits mid-annotation
    into phantom vague tokens; that single bug inflated the measured vagueness
    rate of the corpus from 14% to 59% (research 02 §7). Tokens are normalised:
    backticks and any trailing annotation/period dropped, NEVER a leading dot
    (or `.gitignore` becomes the prose word `gitignore`)."""
    toks, cur, depth, i = [], "", 0, 0
    while i < len(field):
        ch = field[i]
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        if depth == 0 and (ch in ",;·+" or field[i:i + 5] == " and "):
            toks.append(cur)
            cur, i = "", i + (5 if ch == " " else 1)
            continue
        cur += ch
        i += 1
    toks.append(cur)
    out = []
    for t in toks:
        t = t.strip().strip("`").split("(")[0].strip().rstrip(".").strip()
        if t:
            out.append(t)
    return out


def is_path_token(t):
    """A token counts as a path iff it has no whitespace and carries a '/' or a
    file extension (research 02 §1.1). Everything else is prose."""
    return not re.search(r"\s", t) and ("/" in t or bool(re.search(r"\.\w+$", t)))


def tokens_touch(x, y):
    """Two PATH tokens collide: equal, one containing the other at a '/'
    boundary, or either glob's stem (cut at the first '*') prefixing the other.
    A glob stem uses a raw prefix, not a boundary, so `src/web*` still collides
    with src/webview/chat.js — the conservative direction."""
    x, y = x.rstrip("/"), y.rstrip("/")
    if "*" in x or "*" in y:
        return y.startswith(x.split("*")[0]) or x.startswith(y.split("*")[0])
    return x == y or y.startswith(x + "/") or x.startswith(y + "/")


def overlaps(a, b):
    """True when footprints `a` and `b` — token lists from files_tokens() — are
    NOT provably disjoint. Research 02 §1.1's five rows: identical path,
    directory containment, glob, vague token, empty footprint. The last two are
    the safety half: an unprovable footprint must resolve to "conflicts", so the
    failure mode is lost parallelism (INV-10, today's serial behaviour), never an
    unsafe pairing. Bare filenames are deliberately NOT resolved against the repo
    root — eight are unambiguous but `chat.css` is not (§F-3), and a silent
    mis-resolve is the exact error this predicate exists to prevent.
    Disjointness is necessary, NOT sufficient: semantic overlap is undetectable
    by any footprint test (§F-5), so the gates stay the only net for that."""
    if not a or not b:
        return True
    return any(not is_path_token(ta) or not is_path_token(tb) or tokens_touch(ta, tb)
               for ta in a for tb in b)


def lane_ignore(progress_text):
    """Paths a lane split may ignore, DECLARED on a `Lane-ignore:` line beneath
    the board's roster line — never inferred, and absent line = ignore nothing,
    so the strict rule is the default. Research 02 §F-4: package.json and
    package-lock.json appear in 12+ corpus steps, nearly always for a two-line
    version bump, and strict disjointness then serialises a whole plan on them.
    That is a defect in the input, so the answer is to fix the input, not to
    soften the rule (doc 07 §4.2) — and it is declared where a human reads
    status, because a hidden allowance is how a checker stops being trusted."""
    m = re.search(r"^Lane-ignore:(.*)$", progress_text, re.M)
    return files_tokens(m.group(1)) if m else []


def drop_ignored(foot, ignore):
    """Drop declared-ignorable tokens from a footprint before overlaps() sees it.
    Containment is DIRECTED — an ignore entry covers tokens beneath it, never the
    reverse — so ignoring `src/webview/chat.js` can never erase a step's whole
    `src/` footprint. A step left with nothing becomes empty, which overlaps()
    already reads as conflicting-with-everything; that is the safe reading and it
    is deliberately not special-cased away."""
    def covered(t):
        return any(t == ig or t.startswith(ig.rstrip("/") + "/")
                   or ("*" in ig and t.startswith(ig.split("*")[0]))
                   for ig in ignore)
    return [t for t in foot if not covered(t)]


def step_block(lines, start, end):
    """The block for the step heading at `start`: up to the next heading of ANY
    level (## section, ### milestone), not just the next #### step, trailing
    blanks trimmed. Research 02 §7 step 1 requires lane derivation to mirror this
    slice exactly, so both callers share the one implementation."""
    block = lines[start:end]
    for j, bl in enumerate(block[1:], 1):
        if bl.startswith(("## ", "### ")):
            block = block[:j]
            break
    while block and not block[-1].strip():
        block.pop()
    return block


def plan_steps(lines):
    """[(step-id, intra-plan deps, footprint tokens)] in file order. A cross-plan
    dep is dropped, not resolved: lanes are derived inside ONE plan (D-063), so a
    dep on another plan is an already-satisfied constant."""
    heads = [(i, STEP_HEADING_RE.match(ln)) for i, ln in enumerate(lines)
             if ln.startswith("#### ")]
    steps = [(i, mm.group(1)) for i, mm in heads if mm]
    idxs = [i for i, _ in steps] + [len(lines)]
    ids = {sid for _, sid in steps}
    out = []
    for n, (i, sid) in enumerate(steps):
        dm = re.search(r"\[deps:\s*([^\]]*)\]", lines[i])
        deps = [d for d in re.findall(r"P\d{2}-S\d{2}[ab]?", dm.group(1) if dm else "")
                if d in ids]
        block = step_block(lines, i, idxs[n + 1])
        out.append((sid, deps, files_tokens(files_field(block))))
    return out


def ancestors(deps, _computed=None):
    """Transitive closure of `deps` by memoised DFS — every node's set is
    computed once and reused after (append-only `_computed` observes that, and
    is how --selftest proves it). It terminates because the forward-dep FAIL
    guarantees an acyclic intra-plan graph; the memo is seeded before recursing
    so a hand-built cycle is merely finite rather than fatal."""
    memo = {}

    def anc(sid):
        if sid in memo:
            return memo[sid]
        if _computed is not None:
            _computed.append(sid)
        memo[sid] = set()               # seeded first: a cycle stops here
        acc = set()
        for d in deps.get(sid, ()):
            acc.add(d)
            acc |= anc(d)
        memo[sid] = acc
        return acc

    return {sid: anc(sid) for sid in deps}


def concurrent(a, b, anc, foot):
    """Research 02 §1's rule: neither step transitively depends on the other AND
    their declared footprints are disjoint."""
    return (a not in anc[b] and b not in anc[a]
            and not overlaps(foot[a], foot[b]))


def schedule(steps, width=LANE_WIDTH, ignore=()):
    """Greedy rounds (research 02 §7 step 4): take every dep-ready step, seed the
    round with the first, then add further ready steps while concurrent() holds
    against all already picked and the round is under `width`. Greedy is NOT
    optimal, so what this saves is a LOWER bound on the pairing available.
    `ignore` is the declared Lane-ignore list and is applied ONCE, here, so
    overlaps() itself never learns about exceptions."""
    deps = {sid: d for sid, d, _ in steps}
    foot = {sid: drop_ignored(f, ignore) for sid, _, f in steps}
    anc = ancestors(deps)
    order = [sid for sid, _, _ in steps]
    done, rounds = set(), []
    while len(done) < len(order):
        ready = [s for s in order if s not in done
                 and all(d in done for d in deps[s])]
        if not ready:
            break                       # only a cycle gets here, and that FAILs
        pick = [ready[0]]
        for cand in ready[1:]:
            if len(pick) >= width:
                break
            if all(concurrent(cand, p, anc, foot) for p in pick):
                pick.append(cand)
        rounds.append(pick)
        done.update(pick)
    return rounds


def lanes(root: Path, want):
    """--lanes PLAN-NN: print ONE plan's derived width-2 split and change nothing.
    Read-only by construction (D-091) — it writes no file, records no hash, and
    never touches the exit code of a normal checking run."""
    nn = "".join(c for c in want if c.isdigit())
    hits = sorted((root / "planning" / "plans").glob(f"PLAN-{nn}-*.md")) if nn else []
    if not hits:
        print(f"no plan file matches '{want}' in planning/plans/")
        return 1
    f = hits[0]
    steps = plan_steps(read(f).splitlines())
    if not steps:
        print(f"{f.name}: no step headings to schedule")
        return 1
    prog = root / "PROGRESS.md"
    ignore = lane_ignore(read(prog)) if prog.is_file() else []
    rounds = schedule(steps, ignore=ignore)
    saved = len(steps) - len(rounds)
    print(f"{f.stem} — {len(steps)} steps -> {len(rounds)} rounds, {saved} saved")
    print(("ignoring, as declared on PROGRESS.md's Lane-ignore line: "
           + " · ".join(ignore)) if ignore else
          "no Lane-ignore line declared: every path counts (the strict rule).")
    for n, rd in enumerate(rounds, 1):
        print(f"  {n:>2}  {' ‖ '.join(rd)}{'   <- fork' if len(rd) > 1 else ''}")
    forks = [rd for rd in rounds if len(rd) > 1]
    if not forks:
        print("\nNo lanes here: every round is one step — a serial chain. That is a"
              " normal\nanswer; about a third of plans cannot be split at all"
              " (research 02 §3.4).")
        return 0
    print()
    for rd in forks:
        join = next((s for s, d, _ in steps if all(m in d for m in rd)), None)
        print(f"fork {' ‖ '.join(rd)}"
              + (f", rejoining at {join}" if join else ", never rejoined"))
    print("Greedy and width 2, so `saved` is a LOWER bound, not the maximum. A fork"
          "\nis mechanically safe, not necessarily a division of labour worth making.")
    return 0


def selftest():
    """--selftest: assert §1.1's five rows. This is the whole test strategy —
    there is no Python harness in this repo and planning/ is gitignored, so a
    test file beside the checker would not ship. One flag rides all five copies
    of plan_check.py for free (A-P14-01)."""
    checks = []
    for label, a, b, want in [
        ("identical path", ["src/runner.js"], ["src/runner.js"], True),
        ("directory containment", ["src/webview/"], ["src/webview/chat.js"], True),
        ("glob", ["test/*.test.js"], ["test/usage.test.js"], True),
        ("vague token", ["src/session.js if needed"], ["src/runner.js"], True),
        ("empty footprint", [], ["src/runner.js"], True),
        ("disjoint files", ["src/runner.js"], ["src/usage.js"], False),
        ("boundary, not substring", ["src/webview/chat.js"],
         ["src/webview/chatty.js"], False),
        ("glob stem is a raw prefix", ["src/web*"], ["src/webview/chat.js"], True),
    ]:
        checks.append((f"{label} (a,b)", overlaps(a, b), want))
        checks.append((f"{label} (b,a)", overlaps(b, a), want))  # the rule is symmetric

    # The parser half PLAN-14 already shipped — re-measured here, not rewritten.
    checks.append(("depth-0 split", files_tokens("src/usage.js (new, ported) · src/runner.js"),
                   ["src/usage.js", "src/runner.js"]))
    checks.append(("leading dot kept", files_tokens("`.gitignore`"), [".gitignore"]))
    checks.append(("prose is not a path", is_path_token("the webview"), False))
    checks.append(("path token", is_path_token("src/runner.js"), True))

    # ancestors: transitive, computed once per node, and finite even on a cycle
    # the forward-dep FAIL would have caught first.
    computed = []
    anc = ancestors({"a": [], "b": ["a"], "c": ["b"], "d": ["c", "a"]}, computed)
    checks.append(("ancestors transitive", anc["d"], {"a", "b", "c"}))
    checks.append(("ancestors memoised", sorted(computed), ["a", "b", "c", "d"]))
    checks.append(("ancestors terminates on a cycle",
                   set(ancestors({"x": ["y"], "y": ["x"]})), {"x", "y"}))

    # The declared ignore list (research 02 §F-4): a shared version bump must not
    # serialise a plan, the strict rule stays the default, and a footprint that is
    # ONLY ignorable paths still conflicts with everything.
    bump = [("P00-S01", [], ["src/a.js", "package.json"]),
            ("P00-S02", [], ["src/b.js", "package.json"])]
    checks.append(("declared ignore pairs a shared version bump",
                   schedule(bump, ignore=["package.json"]), [["P00-S01", "P00-S02"]]))
    checks.append(("no declaration = the strict rule",
                   schedule(bump), [["P00-S01"], ["P00-S02"]]))
    checks.append(("an all-ignored footprint still conflicts",
                   schedule([("P00-S01", [], ["package.json"]),
                             ("P00-S02", [], ["src/b.js"])], ignore=["package.json"]),
                   [["P00-S01"], ["P00-S02"]]))
    checks.append(("Lane-ignore is read only where declared",
                   [lane_ignore("Drivers: a · b — relay.\n"
                                "Lane-ignore: package.json · package-lock.json\n"),
                    lane_ignore("Drivers: a · b — relay.\n")],
                   [["package.json", "package-lock.json"], []]))
    checks.append(("an ignore entry covers what is beneath it",
                   drop_ignored(["src/webview/chat.js", "src/runner.js"],
                                ["src/webview/"]), ["src/runner.js"]))
    checks.append(("…but never what is above it",
                   drop_ignored(["src/"], ["src/webview/chat.js"]), ["src/"]))

    # …and on the REAL intra-plan graph, not just a toy one: every plan in this
    # project schedules every step exactly once. A vendored copy has no plans
    # directory beside it and simply contributes no rows here.
    pdir = Path("planning/plans")
    for f in sorted(pdir.glob("PLAN-*.md")) if pdir.is_dir() else []:
        real = plan_steps(read(f).splitlines())
        checks.append((f"{f.name} schedules every step once",
                       sorted(s for rd in schedule(real) for s in rd),
                       sorted(s for s, _, _ in real)))

    bad = [c for c in checks if c[1] != c[2]]
    for label, got, want in bad:
        print(f"FAIL | selftest | {label}: got {got!r}, want {want!r}")
    print(f"{'FAIL' if bad else 'PASS'}: selftest {len(checks) - len(bad)}"
          f"/{len(checks)} rows")
    return 1 if bad else 0


def check_line_lengths(path: Path, text, level):
    bad = [i + 1 for i, ln in enumerate(text.splitlines())
           if len(ln) > LINE_MAX_CHARS and "http" not in ln]
    if bad:
        shown = ", ".join(map(str, bad[:5])) + ("…" if len(bad) > 5 else "")
        add(level, f"{path.name}: lines <= {LINE_MAX_CHARS} chars",
            f"{len(bad)} over-long line(s) at {shown}")


# ---------------------------------------------------------------- PROGRESS.md
def check_progress(root: Path):
    p = root / "PROGRESS.md"
    if not p.exists():
        add("FAIL", "PROGRESS.md exists", "missing")
        return None
    text = read(p)
    lines = text.splitlines()

    size = p.stat().st_size
    if size > PROGRESS_MAX_BYTES:
        add("FAIL", "PROGRESS.md size cap", f"{size} bytes > {PROGRESS_MAX_BYTES}")
    if len(lines) > PROGRESS_MAX_LINES:
        add("FAIL", "PROGRESS.md line cap", f"{len(lines)} lines > {PROGRESS_MAX_LINES}")
    check_line_lengths(p, text, "FAIL")

    for pat in FORBIDDEN_PROGRESS:
        if pat in text:
            add("FAIL", "PROGRESS.md forbidden pattern",
                f'"{pat}" found — narrative belongs in git commit bodies')

    # ▶ NEXT STEP block
    s, e = section(lines, "▶ NEXT STEP")
    # One cursor per lane. A solo file has exactly one, unlaned — every rule below
    # then reduces to the single-cursor behaviour it had before lanes existed.
    next_ptrs, next_ids, plan_path = [], [], None
    if s == -1:
        add("FAIL", "▶ NEXT STEP section", "missing")
    else:
        block = [ln for ln in lines[s + 1:e] if ln.strip()]
        if len(block) > NEXT_BLOCK_MAX_LINES:
            add("FAIL", "▶ NEXT STEP block <= 6 lines",
                f"{len(block)} lines — pointer only, never restate the step")
        ptrs = [m for m in (NEXT_RE.match(ln) for ln in block) if m]
        lanes = {m.group(1) for m in ptrs}  # None = the bare, solo form
        if not ptrs:
            add("FAIL", "▶ NEXT STEP pointer format",
                'no line matching "NEXT[<lane>]: P##-S##[ab] | PLAN COMPLETE | none'
                ' | WAIT P##-S##"')
        if None in lanes and len(lanes) > 1:
            # The runner takes its own lane; the checker would validate all of them.
            # Two readers, two answers — so the file is wrong, not merely untidy.
            add("FAIL", "▶ NEXT STEP is laned or bare, never both",
                f"a bare NEXT: alongside {sorted(l for l in lanes if l)}")
        next_ptrs = [(m.group(1), m.group(2)) for m in ptrs
                     if m.group(2) not in ("PLAN COMPLETE", "none")
                     and not m.group(2).startswith("WAIT ")]
        next_ids = [t for _, t in next_ptrs]
        if next_ids:
            for ln in block:
                if ln.startswith("Plan: "):
                    plan_path = root / ln[len("Plan: "):].strip()
            if plan_path is None:
                add("FAIL", "▶ NEXT STEP names its plan file", 'no "Plan: <path>" line')
            elif not plan_path.exists():
                add("FAIL", "▶ NEXT STEP plan file exists", str(plan_path))
            else:
                plan_text = read(plan_path)
                for next_id in next_ids:
                    # a split step (S03b) is legal without editing the immutable
                    # plan — its base ID (S03) must exist there instead
                    if not any(f"[{i}]" in plan_text
                               for i in (next_id, re.sub(r"[ab]$", "", next_id))):
                        add("FAIL", "NEXT step exists in its plan file",
                            f"[{next_id}] not found in {plan_path.name}")

    # Session log — ONE bare section (the solo form) or one per driver, never a mix.
    # Every section is validated independently under the same rules; validating only
    # the first is how a second driver's log stayed silently unchecked.
    logs = sections(lines, "Session log")
    session_ids = set()
    newest_next = {}  # driver (None = bare) -> its newest entry's Next: field
    if not logs:
        add("FAIL", "Session log section", "missing")
    drivers = [SESSION_LOG_RE.match(lines[s]).group(1) for s, _ in logs]
    if None in drivers and len(logs) > 1:
        # Mirrors the laned-or-bare pointer FAIL above: two readers would disagree
        # about which section is the log, so the file is wrong, not merely untidy.
        add("FAIL", "Session log is per-driver or bare, never both",
            f"a bare heading alongside {sorted(d for d in drivers if d)}")
    for (s, e), driver in zip(logs, drivers):
        who = f" — {driver}" if driver else ""
        entries = [i for i in range(s, e) if SESSION_HEAD_RE.match(lines[i])]
        session_ids |= {SESSION_HEAD_RE.match(lines[i]).group(1) for i in entries}
        if len(entries) > SESSION_ENTRIES_MAX:
            add("FAIL", f"Session log{who} <= {SESSION_ENTRIES_MAX} hot entries",
                f"{len(entries)} — rotate oldest to planning/archive/SESSIONS-*.md")
        bounds = entries + [e]
        for n, i in enumerate(entries):
            entry = lines[i:bounds[n + 1]]
            eid = SESSION_HEAD_RE.match(lines[i]).group(1)
            if len(entry) > SESSION_ENTRY_MAX_LINES:
                add("FAIL", f"entry {eid}{who} <= {SESSION_ENTRY_MAX_LINES} lines",
                    f"{len(entry)} lines")
            body = "\n".join(entry)
            for f in SESSION_FIELDS:
                fm = re.search(rf"^- {f}: (.*?)(?=^- \w+:|\Z)", body, re.M | re.S)
                if not fm:
                    add("FAIL", f"entry {eid}{who} has field '{f}:'", "missing")
                else:
                    content = " ".join(fm.group(1).split())
                    if len(content) > SESSION_FIELD_MAX_CHARS:
                        add("FAIL", f"entry {eid}{who} field '{f}' <= "
                            f"{SESSION_FIELD_MAX_CHARS} chars", f"{len(content)}")
                    if n == 0 and f == "Next":
                        newest_next[driver] = content
    # Per lane: a cursor is evidenced by the newest entry of ITS OWN driver's section,
    # not by the newest entry in the file — otherwise one driver's close-out vouches
    # for the other's pointer. Solo (one bare pointer, one bare section) is the old
    # rule exactly. A lane with no section of its own is un-evidenced, not wrong: that
    # is the mid-migration state, and S05's ritual is what finishes it.
    for lane, target in next_ptrs:
        content = newest_next.get(lane)
        if content and target not in STEP_ID_RE.findall(content):
            add("FAIL", "pointer coherence",
                f"{lane or 'the'} lane's newest entry Next='{content[:40]}' does "
                f"not name its ▶ NEXT STEP ({target})")

    # Board ↔ plan parity
    active_nn = None
    board_rows = []  # (step id, status glyph, Done cell) — derived state reads these
    for i, ln in enumerate(lines):
        m = re.match(r"^## Board — PLAN-(\d{2}) \(active\)", ln)
        if m:
            active_nn = m.group(1)
            bs, be = section(lines, f"Board — PLAN-{active_nn}")
            board_ids, bad_cells = [], []
            for row in lines[bs:be]:
                cells = [c.strip() for c in row.split("|")]
                if len(cells) > 4 and STEP_ID_RE.fullmatch(cells[1]):
                    board_ids.append(cells[1])
                    board_rows.append((cells[1], cells[4],
                                       cells[5] if len(cells) > 5 else ""))
                    if cells[4] not in STATUS_GLYPHS:
                        bad_cells.append(f"{cells[1]}='{cells[4]}'")
            if bad_cells:
                add("FAIL", "status cells are one legend glyph",
                    "; ".join(bad_cells[:4]))
            plan_files = sorted((root / "planning/plans").glob(f"PLAN-{active_nn}-*.md"))
            if not plan_files:
                add("FAIL", "active plan file exists", f"PLAN-{active_nn}-*.md not found")
            else:
                plan_ids = [m2.group(1) for ln2 in read(plan_files[0]).splitlines()
                            for m2 in [STEP_HEADING_RE.match(ln2)] if m2]
                norm = lambda ids: {re.sub(r"[ab]$", "", x) for x in ids}
                missing = norm(plan_ids) - norm(board_ids)
                orphan = norm(board_ids) - norm(plan_ids)
                if missing:
                    add("FAIL", "board covers every plan step",
                        f"no board row for {sorted(missing)}")
                if orphan:
                    add("FAIL", "every board row is a plan step",
                        f"orphan rows {sorted(orphan)}")
            for next_id in next_ids:  # per lane — every lane runs the active plan
                if not next_id.startswith(f"P{active_nn}-"):
                    add("FAIL", "NEXT points into the active plan",
                        f"{next_id} vs active PLAN-{active_nn}")
    if active_nn is None and next_ids:
        add("WARN", "active board present", "NEXT names a step but no active board found")

    # Derived state — the board, the Dashboard count and the session log must
    # agree. Every number here is hand-maintained and drifts silently: five ✅
    # rows against a "4/10" count passed green before this. These are FAILs
    # (unlike the Updated: sha, which goes stale for innocent reasons) because a
    # wrong count is never innocent. Input is PROGRESS.md alone — the checker
    # still opens no source file (D-068).
    ds, de = section(lines, "Dashboard")
    if ds != -1:
        dash = {}
        for row in lines[ds:de]:
            cells = [c.strip() for c in row.split("|")]
            if len(cells) > 4 and re.fullmatch(r"PLAN-\d{2}", cells[1]):
                # leading N/M only — a trailing annotation ("41/45 (2 parked)")
                # is legitimate and still perfectly readable
                fr = re.match(r"(\d+)\s*/\s*(\d+)", cells[4])
                if fr:
                    dash[cells[1]] = (int(fr.group(1)), int(fr.group(2)))
                else:
                    add("FAIL", f"{cells[1]} Dashboard Done starts with N/M",
                        f"'{cells[4][:30]}' — the count must be machine-readable")
        tm = re.search(r"\*\*All plans: (\d+)/(\d+)", "\n".join(lines[ds:de]))
        if tm and dash:
            want = (sum(d for d, _ in dash.values()), sum(t for _, t in dash.values()))
            if (int(tm.group(1)), int(tm.group(2))) != want:
                add("FAIL", "Dashboard total == sum of its rows",
                    f"says {tm.group(1)}/{tm.group(2)}, the {len(dash)} rows sum to"
                    f" {want[0]}/{want[1]}")
        pid = f"PLAN-{active_nn}" if active_nn else None
        if board_rows and pid in dash:
            # ❌ rows are DROPPED steps — out of the plan, so out of both halves
            # of the fraction. A ⏸️ row is still a step, just not a done one.
            live = [r for r in board_rows if "❌" not in r[1]]
            done = sum(1 for _, g, _ in live if "✅" in g)
            if dash[pid] != (done, len(live)):
                add("FAIL", f"{pid} Dashboard Done == its board",
                    f"row says {dash[pid][0]}/{dash[pid][1]}, board has {done} ✅"
                    f" of {len(live)} rows (❌ dropped rows excluded)")

    # A row flipped to ✅ must be evidenced by a session entry naming the same
    # session. Only the live window is checkable: entries older than the oldest
    # hot one are rotated to planning/archive/, so a Done cell naming a session
    # at or before that is accepted, never guessed at.
    if board_rows and session_ids:
        oldest = min(session_ids)
        for sid, glyph, done_cell in board_rows:
            sm = re.search(r"S\d{4}", done_cell)
            if "✅" in glyph and sm and sm.group() > oldest \
                    and sm.group() not in session_ids:
                add("FAIL", "board ✅ row has its session entry",
                    f"{sid} is done in {sm.group()} but the log has no {sm.group()}"
                    " entry — the board claims work the log cannot evidence")

    # Facts / Decisions / Amendments / Blockers
    s, e = section(lines, "Facts future sessions need")
    if s != -1:
        n = sum(1 for ln in lines[s:e] if ln.lstrip().startswith("- "))
        if n > FACTS_MAX_BULLETS:
            add("FAIL", f"Facts <= {FACTS_MAX_BULLETS} bullets", f"{n} — curate, don't append")
    s, e = section(lines, "Decisions")
    if s != -1:
        dl = [ln for ln in lines[s:e] if ln.startswith("- D-")]
        if len(dl) > DECISIONS_MAX_LIVE:
            add("FAIL", f"Decisions <= {DECISIONS_MAX_LIVE} live", f"{len(dl)}")
        for ln in dl:
            if len(ln) > DECISION_MAX_CHARS:
                add("WARN", "decision one-liner length", f"{len(ln)} chars: {ln[:50]}…")
    s, e = section(lines, "Amendments")
    if s != -1:
        count = 0
        for ln in lines[s:e]:
            if ln.startswith("- A-"):
                count = 1
                if not AMENDMENT_RE.match(ln):
                    add("WARN", "amendment ID grammar",
                        f"expected '- A-P##-## (date, affects …): …': {ln[:60]}")
            elif ln.startswith("- ") and "A-P" not in ln:
                add("WARN", "amendment ID grammar",
                    f"bullet without an A-P##-## ID: {ln[:60]}")
            elif count and ln.strip() and not ln.startswith(("- ", "#")):
                count += 1
                if count > AMENDMENT_MAX_LINES:
                    add("WARN", f"amendment <= {AMENDMENT_MAX_LINES} lines", ln.strip()[:60])
    s, e = section(lines, "Blockers")
    if s != -1:
        stale = [ln for ln in lines[s:e] if "✅" in ln or "DONE" in ln]
        if stale:
            add("WARN", "Blockers holds open items only",
                f"{len(stale)} resolved-looking line(s) — delete them")

    # staleness tripwire — WARN only if the recorded sha is NOT an ancestor of
    # HEAD (divergent/unknown), or is >2 commits behind. Exact-equality cried
    # wolf on every clean close-out (the doc-closeout commit is 1 past the step
    # commit recorded in Updated:). (P06-S02)
    m = re.search(r"HEAD: ([0-9a-f]{7,})", text)
    if m:
        rec = m.group(1)
        try:
            anc = subprocess.run(["git", "merge-base", "--is-ancestor", rec, "HEAD"],
                                 cwd=root, capture_output=True, timeout=10)
            if anc.returncode == 0:
                cnt = subprocess.run(["git", "rev-list", "--count", f"{rec}..HEAD"],
                                     cwd=root, capture_output=True, text=True, timeout=10)
                behind = int(cnt.stdout.strip()) if cnt.returncode == 0 and cnt.stdout.strip() else 0
                if behind > 2:
                    add("WARN", "dashboard staleness",
                        f"Updated sha {rec[:7]} is {behind} commits behind git HEAD")
            elif anc.returncode == 1:
                add("WARN", "dashboard staleness",
                    f"Updated sha {rec[:7]} is not an ancestor of git HEAD")
            # any other exit code = git error (bad object / shallow clone) → stay quiet
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
    return text


# ---------------------------------------------------------------- plans
def check_plans(root: Path, hashes, progress_text):
    plans_dir = root / "planning" / "plans"
    if not plans_dir.exists():
        add("FAIL", "planning/plans/ exists", "missing")
        return
    ptext = progress_text or ""
    active_boards = re.findall(r"^## Board — (PLAN-\d{2}) \(active\)", ptext, re.M)
    if len(active_boards) > 1:
        add("WARN", "exactly one active board", f"found {active_boards}")
    seen_ids = {}
    for f in sorted(plans_dir.glob("*.md")):
        m = PLAN_FILE_RE.match(f.name)
        if not m:
            add("FAIL", "plan filename grammar", f"{f.name} != PLAN-NN-<kebab-slug>.md")
            continue
        nn = m.group(1)
        text = read(f)
        lines = text.splitlines()
        if f.stat().st_size > PLAN_MAX_BYTES or len(lines) > PLAN_MAX_LINES:
            add("FAIL", f"{f.name} size cap",
                f"{f.stat().st_size}B/{len(lines)}L > {PLAN_MAX_BYTES}B/{PLAN_MAX_LINES}L"
                " — a bigger backlog is two plans")
        check_line_lengths(f, text, "WARN")

        fm = re.search(r"^status: (\w+)", text, re.M)
        status = fm.group(1) if fm else None
        if status not in ("DRAFT", "LOCKED", "COMPLETE", "SUPERSEDED"):
            add("FAIL", f"{f.name} frontmatter status", f"'{status}'")

        heads = [(i, STEP_HEADING_RE.match(ln)) for i, ln in enumerate(lines)
                 if ln.startswith("#### ")]
        bad = [lines[i][:60] for i, mm in heads if not mm]
        if bad:
            add("FAIL", f"{f.name} step heading grammar",
                f"#### heading not matching [P##-S##]: {bad[0]}…")
        steps = [(i, mm.group(1)) for i, mm in heads if mm]
        if len(steps) > PLAN_MAX_STEPS:
            add("WARN", f"{f.name} <= {PLAN_MAX_STEPS} steps", f"{len(steps)}")
        sm = re.search(r"^steps: (\d+)", text, re.M)
        if sm and int(sm.group(1)) != len(steps):
            add("FAIL", f"{f.name} frontmatter steps == headings",
                f"says {sm.group(1)}, found {len(steps)}")
        idxs = [i for i, _ in steps] + [len(lines)]
        for n, (i, sid) in enumerate(steps):
            if not sid.startswith(f"P{nn}-"):
                add("FAIL", "step ID matches its plan number", f"{sid} in {f.name}")
            if sid in seen_ids:
                add("FAIL", "step IDs globally unique", f"{sid} in {f.name} and {seen_ids[sid]}")
            seen_ids[sid] = f.name
            block = step_block(lines, i, idxs[n + 1])
            if len(block) > STEP_MAX_LINES:
                add("FAIL", f"step {sid} <= {STEP_MAX_LINES} lines", f"{len(block)}")
            body = "\n".join(block)
            for lab in STEP_FIELDS:
                if lab not in body:
                    add("FAIL", f"step {sid} has {lab}", "missing")
            # Two advisory footprint WARNs — never FAIL. The corpus is already
            # LOCKED and cannot be edited, so a FAIL would make every existing
            # project permanently red. Lane derivation will later read **Files:**
            # as a safety argument, so say now when it cannot be trusted.
            field = files_field(block)
            if not field or field.lower().startswith("n/a"):
                if "[owner-gate: yes]" not in lines[i]:
                    add("WARN", f"{f.name} step {sid} declares files",
                        f"footprint is '{field[:30] or '(empty)'}' on an agent step —"
                        " a step that touches no file is usually an unwritten field")
            else:
                for tok in files_tokens(field):
                    if not is_path_token(tok):
                        add("WARN", f"{f.name} step {sid} files parseable",
                            f"'{tok[:50]}' is not a repo-relative path")
            for ln in block:
                if ln.lstrip().startswith("- [ ]") and DOD_BANNED_RE.search(ln):
                    add("WARN", f"step {sid} DoD decidable",
                        f"undecided-choice phrase (either…or/and-or/TBD/decide"
                        f" later/if the owner): {ln.strip()[:60]}")
            # forward-dep guard: a same-plan dep that sorts AFTER this step is a
            # forward reference (conversion-rules forbids it). Cross-plan deps
            # are legal. IDs are fixed-width so string compare orders them. (P06-S02)
            dep_m = re.search(r"\[deps:\s*([^\]]*)\]", lines[i])
            if dep_m:
                for dep in re.findall(r"P\d{2}-S\d{2}[ab]?", dep_m.group(1)):
                    if dep.startswith(f"P{nn}-") and dep > sid:
                        add("FAIL", f"step {sid} no forward dep",
                            f"depends on {dep}, which sorts after it in the same plan")

        # An ACTIVE plan must be LOCKED. Without this, a DRAFT plan can own the active
        # board and be built step by step with no hash recorded and no immutability
        # guarantee, and every hash rule below silently declines to fire. Recipes PLAN-02
        # ran 16 steps this way (DRAFT -> COMPLETE, hashed only at close, 2026-07-31).
        if f"PLAN-{nn}" in active_boards and status != "LOCKED":
            add("FAIL", f"PLAN-{nn} active plan is LOCKED",
                f"owns the active board with status '{status}' — lock it and run "
                "--update-hashes, or its spec is not immutable and nothing will notice")

        if status == "LOCKED":
            # every LOCKED plan's per-step state must be visible somewhere:
            # the active board, a QUEUED/PARKED dashboard row, or a park file
            pid = f"PLAN-{nn}"
            row = next((ln for ln in ptext.splitlines()
                        if ln.startswith(f"| {pid} ")), None)
            parked = any((root / "planning" / "archive").glob(f"{pid}-*PARKED*.md")) \
                if (root / "planning" / "archive").exists() else False
            if pid in active_boards:
                pass
            elif row and ("QUEUED" in row or "⏳" in row):
                pass
            elif row and ("PARKED" in row or "⏸" in row):
                if not parked:
                    add("WARN", f"{pid} park file exists",
                        "dashboard says PARKED but no planning/archive/"
                        f"{pid}-PARKED.md")
            elif row is None:
                add("FAIL", f"{pid} visible in Dashboard",
                    "LOCKED plan has no Dashboard row")
            else:
                add("FAIL", f"{pid} board present",
                    "LOCKED plan is neither the active board nor QUEUED/PARKED —"
                    " its per-step state has no home")

        if status in ("LOCKED", "COMPLETE"):
            rel = f"planning/plans/{f.name}"
            if rel not in hashes:
                add("FAIL", f"{f.name} hash recorded",
                    "not in plan-hashes.json — a LOCKED/COMPLETE plan with no"
                    " recorded hash has no immutability guard. Confirm the plan"
                    " is UNCHANGED first (git log -p on it); --update-hashes"
                    " blesses whatever is on disk, so re-hashing an edited plan"
                    " launders the edit. Unchanged: run --update-hashes.")
            elif hashes[rel] != sha256(f):
                add("FAIL", f"{f.name} immutability",
                    "hash mismatch — a LOCKED plan was edited. Revert, or record the"
                    " edit as an Amendment and re-run --update-hashes")


# ---------------------------------------------------------------- other files
def check_prompt(root: Path, hashes):
    p = root / "SESSION_PROMPT.md"
    if not p.exists():
        add("FAIL", "SESSION_PROMPT.md exists", "missing")
        return
    if p.stat().st_size > PROMPT_MAX_BYTES:
        add("FAIL", "SESSION_PROMPT.md size", f"{p.stat().st_size} > {PROMPT_MAX_BYTES}")
    if not has_sentinel(read(p)):
        add("WARN", "prompt sentinel present",
            f'"{PROMPT_SENTINEL}" not found — single-copy check degraded')
    copies = []
    for f in list(root.glob("*.md")) + list((root / "planning").rglob("*.md")):
        if has_sentinel(read(f)):
            copies.append(str(f.relative_to(root)))
    if len(copies) > 1:
        add("FAIL", "session prompt single copy",
            f"embedded copies: {[c for c in copies if c != 'SESSION_PROMPT.md']}")
    if "SESSION_PROMPT.md" in hashes and hashes["SESSION_PROMPT.md"] != sha256(p):
        add("FAIL", "SESSION_PROMPT.md immutability",
            "hash mismatch — re-run --update-hashes only if the change was deliberate")


def check_misc(root: Path):
    # The agent-instructions file is named per engine: CLAUDE.md (Claude Code) or
    # AGENTS.md (Codex). Check whichever the project actually has; only warn as
    # missing when neither exists.
    c = next((root / n for n in ("CLAUDE.md", "AGENTS.md") if (root / n).exists()),
             root / "CLAUDE.md")
    if c.exists():
        text = read(c)
        n = text.count("<!-- PLANDOC:POINTER")
        if n != 1:
            add("WARN", f"{c.name} pointer block", f"{n} sentinel blocks (want exactly 1)")
        if c.stat().st_size > CLAUDE_WARN_BYTES:
            add("WARN", f"{c.name} size",
                f"{c.stat().st_size} > {CLAUDE_WARN_BYTES} — project-facts narrative"
                f" belongs in commits/archive, not {c.name}")
    else:
        add("WARN", "CLAUDE.md/AGENTS.md exists",
            "neither found (pointer block not installed)")
    ot = root / "OWNER_TODO.md"
    if not ot.exists():
        add("WARN", "OWNER_TODO.md exists", "missing")
    else:
        t = read(ot)
        if "## Open" not in t or "## Done" not in t:
            add("WARN", "OWNER_TODO.md sections", "needs '## Open' and '## Done'")
    gates = root / "planning" / "reference" / "GATES.md"
    if not gates.exists():
        add("FAIL", "planning/reference/GATES.md exists",
            "missing — steps and SESSION_PROMPT resolve gate names from this file")
    conv = root / "planning" / "reference" / "CONVENTIONS.md"
    # W-d: a lane-qualified pointer IS the non-solo mode — there is no mode setting
    # anywhere — and the mode and the drivers are written in §Shared-repo rules.
    # Nothing machine-read lives in that section, so its absence is drift, not
    # damage: WARN, never FAIL.
    prog = root / "PROGRESS.md"
    laned = any((m := NEXT_RE.match(ln)) and m.group(1)
                for ln in (read(prog).splitlines() if prog.exists() else []))
    if not conv.exists():
        add("WARN", "planning/reference/CONVENTIONS.md exists",
            "missing — rotation/split/amendment rules live there")
    elif laned and "## Shared-repo rules" not in read(conv):
        add("WARN", "CONVENTIONS.md §Shared-repo rules exists",
            "the pointer is lane-qualified (more than one driver) but the mode and"
            " the drivers are written nowhere")
    arch = root / "planning" / "archive"
    if arch.exists():
        for f in arch.glob("SESSIONS-*.md"):
            if not SHARD_FILE_RE.match(f.name):
                add("WARN", "archive shard naming",
                    f"{f.name} != SESSIONS-NNNN-NNNN.md")
            text = read(f)
            if "PLANDOC:ARCHIVE" not in text:
                add("WARN", f"{f.name} header", "missing PLANDOC:ARCHIVE header")
            n = len(SESSION_HEAD_RE.findall(text))
            if n > ARCHIVE_SHARD_MAX_ENTRIES:
                add("WARN", f"{f.name} <= {ARCHIVE_SHARD_MAX_ENTRIES} entries", f"{n}")


# ---------------------------------------------------------------- main
def update_hashes(root: Path, hpath: Path):
    hashes = {}
    p = root / "SESSION_PROMPT.md"
    if p.exists():
        hashes["SESSION_PROMPT.md"] = sha256(p)
    for f in sorted((root / "planning" / "plans").glob("PLAN-*.md")):
        if re.search(r"^status: (LOCKED|COMPLETE)", read(f), re.M):
            hashes[f"planning/plans/{f.name}"] = sha256(f)
    hpath.parent.mkdir(parents=True, exist_ok=True)
    hpath.write_text(json.dumps(hashes, indent=2), encoding="utf-8")
    print(f"recorded {len(hashes)} hash(es) → {hpath}")


def check_paths(root: Path):
    """WARN on machine-local paths — they break the moment someone else clones."""
    seen = set()
    for pattern in PATH_SCAN_GLOBS:
        for f in sorted(root.glob(pattern)):
            if not f.is_file() or f in seen:
                continue
            seen.add(f)
            rel = f.relative_to(root).as_posix()
            for n, line in enumerate(read(f).splitlines(), 1):
                if ABS_PATH_RE.search(line):
                    add("WARN", "paths are repo-relative",
                        f"{rel}:{n} looks machine-local — use a repo-root-relative"
                        f" path: {line.strip()[:60]}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".", help="project root (default: cwd)")
    ap.add_argument("--update-hashes", action="store_true",
                    help="record SHA-256 of SESSION_PROMPT.md + LOCKED/COMPLETE plans")
    ap.add_argument("--selftest", action="store_true",
                    help="assert the footprint-disjointness rows; exit 0 or 1")
    ap.add_argument("--lanes", metavar="PLAN-NN",
                    help="print one plan's derived width-2 lane split; read-only")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    root = Path(args.root).resolve()
    if args.lanes:
        return lanes(root, args.lanes)

    hpath = root / "planning" / "tools" / "plan-hashes.json"

    if args.update_hashes:
        update_hashes(root, hpath)
        return 0

    hashes = {}
    if hpath.exists():
        try:
            hashes = json.loads(read(hpath))
        except ValueError as e:
            add("FAIL", "plan-hashes.json parses",
                f"{e} — restore from git or re-run --update-hashes")
        if not isinstance(hashes, dict):
            add("FAIL", "plan-hashes.json is a JSON object",
                f"got {type(hashes).__name__} — restore from git or re-run"
                " --update-hashes")
            hashes = {}

    progress_text = check_progress(root)
    check_plans(root, hashes, progress_text)
    check_prompt(root, hashes)
    check_misc(root)
    check_paths(root)

    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    width = max((len(r[1]) for r in results), default=20)
    for level, check, detail in results:
        print(f"{level:4} | {check:<{width}} | {detail}")
    print(f"\n{'FAIL' if fails else 'PASS'}: {len(fails)} failure(s), "
          f"{len(warns)} warning(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

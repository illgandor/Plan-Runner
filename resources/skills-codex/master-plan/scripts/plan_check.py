#!/usr/bin/env python3
"""plan_check.py — conformance checker for the master-plan planning system.

Stdlib-only. Copied into each project at planning/tools/plan_check.py by the
master-plan skill. Run from the project root (or pass --root):

    python planning/tools/plan_check.py                 # check; exit 0 = pass
    python planning/tools/plan_check.py --update-hashes # record immutable-file hashes

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

SESSION_FIELDS = ["Did", "Verified", "Decisions", "Handoff", "Next", "Notes"]
STEP_FIELDS = ["**Objective:**", "**Context:**", "**Files:**", "**Approach:**",
               "**Completion criteria:**", "**Verify:**", "**Carryover:**"]
STATUS_GLYPHS = {"⬜", "🔧", "✅", "⏸️", "⏸", "❌", "👤⬜", "👤🔧", "👤✅"}
PROMPT_SENTINEL = "One step is your entire job today."
FORBIDDEN_PROGRESS = ["<details>", "Why this state", "Full detail in"]

STEP_ID_RE = re.compile(r"P\d{2}-S\d{2}[ab]?")
STEP_HEADING_RE = re.compile(r"^#### \[(P\d{2}-S\d{2}[ab]?)\]")
NEXT_RE = re.compile(r"^NEXT: (P\d{2}-S\d{2}[ab]?\b|PLAN COMPLETE\b|none\b)")
SESSION_HEAD_RE = re.compile(r"^### (S\d{4}) ")
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
    return hashlib.sha256(path.read_bytes()).hexdigest()


def section(lines, heading_prefix):
    """Return (start, end) line indexes of the section whose ## heading starts
    with heading_prefix, ending before the next ## heading. (-1,-1) if absent."""
    start = -1
    for i, ln in enumerate(lines):
        if start == -1 and ln.startswith("## " + heading_prefix):
            start = i
        elif start != -1 and ln.startswith("## "):
            return start, i
    return (start, len(lines)) if start != -1 else (-1, -1)


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
    next_id, plan_path = None, None
    if s == -1:
        add("FAIL", "▶ NEXT STEP section", "missing")
    else:
        block = [ln for ln in lines[s + 1:e] if ln.strip()]
        if len(block) > NEXT_BLOCK_MAX_LINES:
            add("FAIL", "▶ NEXT STEP block <= 6 lines",
                f"{len(block)} lines — pointer only, never restate the step")
        m = next((NEXT_RE.match(ln) for ln in block if NEXT_RE.match(ln)), None)
        if not m:
            add("FAIL", "▶ NEXT STEP pointer format",
                'no line matching "NEXT: P##-S##[ab] | PLAN COMPLETE | none"')
        elif m.group(1) not in ("PLAN COMPLETE", "none"):
            next_id = m.group(1)
            for ln in block:
                if ln.startswith("Plan: "):
                    plan_path = root / ln[len("Plan: "):].strip()
            if plan_path is None:
                add("FAIL", "▶ NEXT STEP names its plan file", 'no "Plan: <path>" line')
            elif not plan_path.exists():
                add("FAIL", "▶ NEXT STEP plan file exists", str(plan_path))
            elif not any(f"[{i}]" in read(plan_path)
                         for i in (next_id, re.sub(r"[ab]$", "", next_id))):
                # a split step (S03b) is legal without editing the immutable
                # plan — its base ID (S03) must exist there instead
                add("FAIL", "NEXT step exists in its plan file",
                    f"[{next_id}] not found in {plan_path.name}")

    # Session log
    s, e = section(lines, "Session log")
    if s == -1:
        add("FAIL", "Session log section", "missing")
    else:
        entries = [i for i in range(s, e) if SESSION_HEAD_RE.match(lines[i])]
        if len(entries) > SESSION_ENTRIES_MAX:
            add("FAIL", f"Session log <= {SESSION_ENTRIES_MAX} hot entries",
                f"{len(entries)} — rotate oldest to planning/archive/SESSIONS-*.md")
        bounds = entries + [e]
        newest_next = None
        for n, i in enumerate(entries):
            entry = lines[i:bounds[n + 1]]
            eid = SESSION_HEAD_RE.match(lines[i]).group(1)
            if len(entry) > SESSION_ENTRY_MAX_LINES:
                add("FAIL", f"entry {eid} <= {SESSION_ENTRY_MAX_LINES} lines",
                    f"{len(entry)} lines")
            body = "\n".join(entry)
            for f in SESSION_FIELDS:
                fm = re.search(rf"^- {f}: (.*?)(?=^- \w+:|\Z)", body, re.M | re.S)
                if not fm:
                    add("FAIL", f"entry {eid} has field '{f}:'", "missing")
                else:
                    content = " ".join(fm.group(1).split())
                    if len(content) > SESSION_FIELD_MAX_CHARS:
                        add("FAIL", f"entry {eid} field '{f}' <= "
                            f"{SESSION_FIELD_MAX_CHARS} chars", f"{len(content)}")
                    if n == 0 and f == "Next":
                        newest_next = content
        if next_id and newest_next and next_id not in STEP_ID_RE.findall(newest_next):
            add("FAIL", "pointer coherence",
                f"newest entry Next='{newest_next[:40]}' != ▶ NEXT STEP {next_id}")

    # Board ↔ plan parity
    active_nn = None
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
            if next_id and not next_id.startswith(f"P{active_nn}-"):
                add("FAIL", "NEXT points into the active plan",
                    f"{next_id} vs active PLAN-{active_nn}")
    if active_nn is None and next_id is not None:
        add("WARN", "active board present", "NEXT names a step but no active board found")

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

    # staleness tripwire
    m = re.search(r"HEAD: ([0-9a-f]{7,})", text)
    if m:
        try:
            head = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"],
                                  cwd=root, capture_output=True, text=True, timeout=10)
            if head.returncode == 0 and not head.stdout.strip().startswith(m.group(1)[:7]):
                add("WARN", "dashboard staleness",
                    f"Updated line says {m.group(1)[:7]}, git HEAD is {head.stdout.strip()}")
        except (OSError, subprocess.TimeoutExpired):
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
            block = lines[i:idxs[n + 1]]
            # a step block ends at the next heading of ANY level (## section,
            # ### milestone), not just the next #### step heading
            for j, bl in enumerate(block[1:], 1):
                if bl.startswith(("## ", "### ")):
                    block = block[:j]
                    break
            # trim trailing blanks from the block length count
            while block and not block[-1].strip():
                block.pop()
            if len(block) > STEP_MAX_LINES:
                add("FAIL", f"step {sid} <= {STEP_MAX_LINES} lines", f"{len(block)}")
            body = "\n".join(block)
            for lab in STEP_FIELDS:
                if lab not in body:
                    add("FAIL", f"step {sid} has {lab}", "missing")
            for ln in block:
                if ln.lstrip().startswith("- [ ]") and DOD_BANNED_RE.search(ln):
                    add("WARN", f"step {sid} DoD decidable",
                        f"undecided-choice phrase (either…or/and-or/TBD/decide"
                        f" later/if the owner): {ln.strip()[:60]}")

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
                    " recorded hash has no immutability guard; run --update-hashes")
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
    c = root / "CLAUDE.md"
    if c.exists():
        text = read(c)
        n = text.count("<!-- PLANDOC:POINTER")
        if n != 1:
            add("WARN", "CLAUDE.md pointer block", f"{n} sentinel blocks (want exactly 1)")
        if c.stat().st_size > CLAUDE_WARN_BYTES:
            add("WARN", "CLAUDE.md size",
                f"{c.stat().st_size} > {CLAUDE_WARN_BYTES} — project-facts narrative"
                " belongs in commits/archive, not CLAUDE.md")
    else:
        add("WARN", "CLAUDE.md exists", "missing (pointer block not installed)")
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
    if not conv.exists():
        add("WARN", "planning/reference/CONVENTIONS.md exists",
            "missing — rotation/split/amendment rules live there")
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


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".", help="project root (default: cwd)")
    ap.add_argument("--update-hashes", action="store_true",
                    help="record SHA-256 of SESSION_PROMPT.md + LOCKED/COMPLETE plans")
    args = ap.parse_args()
    root = Path(args.root).resolve()
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

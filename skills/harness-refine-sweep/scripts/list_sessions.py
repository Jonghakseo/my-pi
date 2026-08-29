#!/usr/bin/env python3
"""List recent pi session JSONL files that qualify for a harness-refine sweep.

Read-only. Outputs JSON: candidate sessions filtered by mtime window and
assistant-turn count, excluding the current session and already-processed ones.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_SESSIONS_DIR = Path.home() / ".pi" / "agent" / "sessions"
DEFAULT_REPORTS_DIR = Path.home() / ".pi" / "agent" / "retrospective" / "refine-reports"


def read_header(path: Path):
    try:
        with path.open("r", errors="replace") as f:
            line = f.readline()
        head = json.loads(line)
        if head.get("type") == "session":
            return head
    except (OSError, json.JSONDecodeError):
        pass
    return {}


REFINE_MARKER = "session_inspect.py summary"


def scan_session(path: Path):
    """Single pass: (assistant turn count, harness-refine already ran in-session)."""
    n = 0
    refined = False
    try:
        with path.open("r", errors="replace") as f:
            for line in f:
                if '"role":"assistant"' in line or '"role": "assistant"' in line:
                    n += 1
                if not refined and REFINE_MARKER in line:
                    refined = True
    except OSError:
        return 0, False
    return n, refined


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hours", type=float, help="mtime window in hours")
    ap.add_argument("--days", type=float, help="mtime window in days (default 3)")
    ap.add_argument("--min-turns", type=int, default=10, help="minimum assistant turns (default 10)")
    ap.add_argument("--min-idle-hours", type=float, default=12, help="exclude sessions touched within this many hours (default 12; 0 = disable)")
    ap.add_argument("--limit", type=int, default=10, help="max candidates returned, newest first (default 10; 0 = unlimited)")
    ap.add_argument("--sessions-dir", type=Path, default=DEFAULT_SESSIONS_DIR)
    ap.add_argument("--reports-dir", type=Path, default=DEFAULT_REPORTS_DIR)
    ap.add_argument("--include-processed", action="store_true", help="include sessions that already have a report")
    ap.add_argument("--include-subagents", action="store_true", help="include subagent session files (excluded by default)")
    ap.add_argument("--include-refined", action="store_true", help="include sessions where harness-refine already ran in-session")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    if args.hours is not None and args.days is not None:
        ap.error("use only one of --hours / --days")
    window_hours = args.hours if args.hours is not None else (args.days if args.days is not None else 3) * 24
    now = time.time()
    cutoff = now - window_hours * 3600
    idle_cutoff = now - args.min_idle_hours * 3600

    current = os.environ.get("PI_SESSION_FILE", "")
    current_real = os.path.realpath(current) if current else ""

    per_session_dir = args.reports_dir / "sessions"
    candidates = []
    skipped = {"too_few_turns": 0, "processed": 0, "already_refined": 0, "recently_active": 0, "current_session": 0, "subagent": 0, "unreadable": 0}

    for path in sorted(args.sessions_dir.rglob("*.jsonl")):
        try:
            st = path.stat()
        except OSError:
            skipped["unreadable"] += 1
            continue
        if st.st_mtime < cutoff:
            continue
        if st.st_mtime > idle_cutoff:
            skipped["recently_active"] += 1
            continue
        if current_real and os.path.realpath(str(path)) == current_real:
            skipped["current_session"] += 1
            continue
        if not args.include_subagents and "subagents" in path.relative_to(args.sessions_dir).parts:
            skipped["subagent"] += 1
            continue

        head = read_header(path)
        session_id = head.get("id") or path.stem.split("_")[-1]
        processed = (per_session_dir / f"{session_id}.md").exists()
        if processed and not args.include_processed:
            skipped["processed"] += 1
            continue

        turns, refined = scan_session(path)
        if turns < args.min_turns:
            skipped["too_few_turns"] += 1
            continue
        if refined and not args.include_refined:
            skipped["already_refined"] += 1
            continue

        candidates.append({
            "id": session_id,
            "file": str(path),
            "cwd": head.get("cwd", ""),
            "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
            "size_bytes": st.st_size,
            "assistant_turns": turns,
            "processed": processed,
        })

    candidates.sort(key=lambda c: c["mtime"], reverse=True)
    total_matched = len(candidates)
    if args.limit > 0:
        candidates = candidates[: args.limit]

    out = {
        "window_hours": window_hours,
        "min_idle_hours": args.min_idle_hours,
        "min_turns": args.min_turns,
        "sessions_dir": str(args.sessions_dir),
        "reports_dir": str(args.reports_dir),
        "total_matched": total_matched,
        "returned": len(candidates),
        "skipped": skipped,
        "candidates": candidates,
    }
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

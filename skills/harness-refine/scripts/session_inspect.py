#!/usr/bin/env python3
"""Inspect the active Pi session JSONL without modifying it.

The current session is resolved from PI_SESSION_FILE by default. Output is JSON so
both humans and skills can consume the same stable structure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
SECRET_KEY_RE = re.compile(
    r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|"
    r"password|passwd|secret|cookie|private[_-]?key)",
    re.IGNORECASE,
)
SECRET_PATTERNS = [
    re.compile(r"\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bxox[bp]-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(
        r"(?i)\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|API_KEY))\s*=\s*([^\s'\"]+)"
    ),
]
SUBAGENT_OUTCOME_RE = re.compile(
    r"^\[(?P<async_id>subagent[^\]]*)\]\s+(?P<outcome>error|failed|completed)\b",
    re.IGNORECASE,
)


def redact_text(value: str) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        if pattern.groups:
            redacted = pattern.sub(lambda match: f"{match.group(1)}=<redacted>", redacted)
        else:
            redacted = pattern.sub("<redacted>", redacted)
    return redacted


def truncate(value: str, limit: int) -> str:
    value = redact_text(value)
    if limit < 0 or len(value) <= limit:
        return value
    return f"{value[: max(0, limit - 18)]}… <truncated>"


def sanitize(value: Any, string_limit: int = 2_000) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "<redacted>" if SECRET_KEY_RE.search(str(key)) else sanitize(item, string_limit)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item, string_limit) for item in value]
    if isinstance(value, str):
        return truncate(value, string_limit)
    return value


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def duration_ms(start: Any, end: Any) -> int | None:
    start_dt = parse_iso(start)
    end_dt = parse_iso(end)
    if not start_dt or not end_dt:
        return None
    return max(0, int((end_dt - start_dt).total_seconds() * 1_000))


def load_session(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    if not path.exists():
        raise ValueError(f"session file not found: {path}")
    header: dict[str, Any] | None = None
    entries: list[dict[str, Any]] = []
    warnings: list[str] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as error:
                warnings.append(f"ignored malformed JSONL line {line_number}: {error.msg}")
                continue
            if not isinstance(item, dict):
                warnings.append(f"ignored non-object JSONL line {line_number}")
                continue
            if item.get("type") == "session" and header is None:
                header = item
            elif isinstance(item.get("id"), str):
                entries.append(item)
    if header is None:
        raise ValueError("session header not found")
    return header, entries, warnings


def active_branch(entries: list[dict[str, Any]], leaf_id: str | None = None) -> list[dict[str, Any]]:
    if not entries:
        return []
    by_id = {entry["id"]: entry for entry in entries if isinstance(entry.get("id"), str)}
    current_id = leaf_id or entries[-1].get("id")
    if current_id not in by_id:
        raise ValueError(f"leaf entry not found: {current_id}")
    branch: list[dict[str, Any]] = []
    seen: set[str] = set()
    while current_id is not None:
        if current_id in seen:
            raise ValueError(f"cycle detected at session entry {current_id}")
        seen.add(current_id)
        entry = by_id.get(current_id)
        if entry is None:
            raise ValueError(f"missing parent entry: {current_id}")
        branch.append(entry)
        parent_id = entry.get("parentId")
        current_id = parent_id if isinstance(parent_id, str) else None
    branch.reverse()
    return branch


def message_text(message: dict[str, Any], max_chars: int) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return truncate(content, max_chars)
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return truncate("\n".join(parts), max_chars)


def result_text(message: dict[str, Any], max_chars: int) -> str:
    return message_text(message, max_chars)


def tool_records(branch: list[dict[str, Any]], include_results: bool, max_chars: int) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    by_call_id: dict[str, dict[str, Any]] = {}
    results: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}

    for entry in branch:
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant" and isinstance(message.get("content"), list):
            for block in message["content"]:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                call_id = str(block.get("id", ""))
                record = {
                    "sequence": len(calls) + 1,
                    "entry_id": entry.get("id"),
                    "timestamp": entry.get("timestamp"),
                    "tool_call_id": call_id,
                    "tool": str(block.get("name", "unknown")),
                    "arguments": sanitize(block.get("arguments", {}), max_chars),
                    "status": "pending",
                    "is_error": None,
                    "result_entry_id": None,
                    "duration_ms": None,
                }
                calls.append(record)
                if call_id:
                    by_call_id[call_id] = record
        elif message.get("role") == "toolResult":
            call_id = message.get("toolCallId")
            if isinstance(call_id, str):
                results[call_id] = (entry, message)

    for call_id, record in by_call_id.items():
        matched = results.get(call_id)
        if not matched:
            continue
        entry, message = matched
        is_error = message.get("isError") is True
        record.update(
            {
                "status": "error" if is_error else "success",
                "is_error": is_error,
                "result_entry_id": entry.get("id"),
                "duration_ms": duration_ms(record.get("timestamp"), entry.get("timestamp")),
            }
        )
        if include_results:
            record["result"] = result_text(message, max_chars)
    return calls


def async_outcome_records(
    branch: list[dict[str, Any]], include_results: bool, max_chars: int
) -> list[dict[str, Any]]:
    """Parse async subagent completion notifications emitted after dispatch succeeds."""
    outcomes: list[dict[str, Any]] = []
    for entry in branch:
        if entry.get("type") != "custom_message" or entry.get("customType") != "subagent-tool":
            continue
        content = entry.get("content")
        if not isinstance(content, str):
            continue
        match = SUBAGENT_OUTCOME_RE.match(content.strip())
        if not match:
            continue
        outcome = match.group("outcome").casefold()
        record = {
            "sequence": len(outcomes) + 1,
            "entry_id": entry.get("id"),
            "timestamp": entry.get("timestamp"),
            "tool": "subagent",
            "async_id": match.group("async_id"),
            "outcome": outcome,
            "status": "success" if outcome == "completed" else "error",
            "is_error": outcome != "completed",
        }
        if include_results:
            record["result"] = truncate(content, max_chars)
        outcomes.append(record)
    return outcomes


def tool_stats(calls: list[dict[str, Any]], assistant_turns: int) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for call in calls:
        grouped[call["tool"]].append(call)
    total = len(calls)
    stats = []
    for name, records in grouped.items():
        durations = [record["duration_ms"] for record in records if isinstance(record.get("duration_ms"), int)]
        stats.append(
            {
                "tool": name,
                "calls": len(records),
                "frequency_percent": round(len(records) * 100 / total, 2) if total else 0.0,
                "calls_per_assistant_turn": round(len(records) / assistant_turns, 3) if assistant_turns else 0.0,
                "successes": sum(record["status"] == "success" for record in records),
                "errors": sum(record["status"] == "error" for record in records),
                "pending": sum(record["status"] == "pending" for record in records),
                "average_duration_ms": round(sum(durations) / len(durations)) if durations else None,
            }
        )
    return sorted(stats, key=lambda item: (-item["calls"], item["tool"]))


def usage_summary(branch: list[dict[str, Any]]) -> dict[str, Any]:
    totals: Counter[str] = Counter()
    costs: Counter[str] = Counter()
    for entry in branch:
        message = entry.get("message") if entry.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens"):
            value = usage.get(key)
            if isinstance(value, (int, float)):
                totals[key] += value
        cost = usage.get("cost")
        if isinstance(cost, dict):
            for key in ("input", "output", "cacheRead", "cacheWrite", "total"):
                value = cost.get(key)
                if isinstance(value, (int, float)):
                    costs[key] += value
    return {"tokens": dict(totals), "cost": {key: round(value, 8) for key, value in costs.items()}}


def session_context(
    args: argparse.Namespace,
) -> tuple[Path, dict[str, Any], list[dict[str, Any]], list[str], dict[str, Any]]:
    raw_path = args.session or os.environ.get("PI_SESSION_FILE")
    if not raw_path:
        raise ValueError("PI_SESSION_FILE is not set; pass --session <path>")
    path = Path(raw_path).expanduser().resolve()
    header, entries, warnings = load_session(path)
    expected_id = None if args.session else os.environ.get("PI_SESSION_ID")
    if expected_id and header.get("id") != expected_id:
        raise ValueError(
            f"PI_SESSION_ID mismatch: env={expected_id}, file={header.get('id')} ({path})"
        )
    branch = active_branch(entries, args.leaf_id)
    source_leaf_id = branch[-1].get("id") if branch else None
    excluded_entries = 0
    cutoff_reason = "requested_leaf" if args.leaf_id else "latest_entry"
    if args.exclude_current_turn:
        latest_user_index = next(
            (
                index
                for index in range(len(branch) - 1, -1, -1)
                if branch[index].get("type") == "message"
                and isinstance(branch[index].get("message"), dict)
                and branch[index]["message"].get("role") == "user"
            ),
            None,
        )
        if latest_user_index is None:
            raise ValueError("cannot exclude current turn: no user message found on active branch")
        excluded_entries = len(branch) - latest_user_index
        branch = branch[:latest_user_index]
        cutoff_reason = "before_latest_user"
    analysis = {
        "cutoff_reason": cutoff_reason,
        "source_leaf_id": source_leaf_id,
        "cutoff_leaf_id": branch[-1].get("id") if branch else None,
        "excluded_entries": excluded_entries,
    }
    return path, header, branch, warnings, analysis


def base_meta(
    path: Path,
    header: dict[str, Any],
    branch: list[dict[str, Any]],
    warnings: list[str],
    analysis: dict[str, Any],
) -> dict[str, Any]:
    compactions = sum(entry.get("type") == "compaction" for entry in branch)
    started = header.get("timestamp")
    ended = branch[-1].get("timestamp") if branch else started
    return {
        "schema_version": SCHEMA_VERSION,
        "session": {
            "id": header.get("id"),
            "file": str(path),
            "cwd": header.get("cwd"),
            "created_at": started,
            "active_leaf_id": branch[-1].get("id") if branch else None,
            "active_branch_entries": len(branch),
            "duration_ms": duration_ms(started, ended),
            "compactions": compactions,
            "history_coverage": "raw_branch_with_compaction_entries" if compactions else "raw_branch",
            "parent_session": header.get("parentSession"),
        },
        "analysis": analysis,
        "warnings": warnings,
    }


def command_summary(args: argparse.Namespace) -> dict[str, Any]:
    path, header, branch, warnings, analysis = session_context(args)
    roles: Counter[str] = Counter()
    models: Counter[str] = Counter()
    stop_reasons: Counter[str] = Counter()
    entry_types = Counter(str(entry.get("type", "unknown")) for entry in branch)
    for entry in branch:
        message = entry.get("message") if entry.get("type") == "message" else None
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "unknown"))
        roles[role] += 1
        if role == "assistant":
            models[f"{message.get('provider', 'unknown')}/{message.get('model', 'unknown')}"] += 1
            stop_reasons[str(message.get("stopReason", "unknown"))] += 1
    calls = tool_records(branch, include_results=False, max_chars=args.max_chars)
    async_outcomes = async_outcome_records(branch, include_results=False, max_chars=args.max_chars)
    assistant_turns = roles.get("assistant", 0)
    output = base_meta(path, header, branch, warnings, analysis)
    output["summary"] = {
        "entry_types": dict(entry_types),
        "message_roles": dict(roles),
        "assistant_models": dict(models),
        "assistant_stop_reasons": dict(stop_reasons),
        "usage": usage_summary(branch),
        "tools": {
            "total_calls": len(calls),
            "calls_per_assistant_turn": round(len(calls) / assistant_turns, 3) if assistant_turns else 0.0,
            "errors": sum(call["status"] == "error" for call in calls),
            "pending": sum(call["status"] == "pending" for call in calls),
            "by_tool": tool_stats(calls, assistant_turns),
        },
        "async_outcomes": {
            "total": len(async_outcomes),
            "successes": sum(outcome["status"] == "success" for outcome in async_outcomes),
            "errors": sum(outcome["status"] == "error" for outcome in async_outcomes),
        },
    }
    return output


def command_tools(args: argparse.Namespace) -> dict[str, Any]:
    path, header, branch, warnings, analysis = session_context(args)
    assistant_turns = sum(
        entry.get("type") == "message"
        and isinstance(entry.get("message"), dict)
        and entry["message"].get("role") == "assistant"
        for entry in branch
    )
    calls = tool_records(branch, include_results=args.include_results, max_chars=args.max_chars)
    if args.tool:
        calls = [call for call in calls if call["tool"] == args.tool]
    output = base_meta(path, header, branch, warnings, analysis)
    output["tools"] = {
        "matched_calls": len(calls),
        "by_tool": tool_stats(calls, assistant_turns),
        "calls": calls[-args.limit :] if args.limit else calls,
    }
    return output


def infer_operation(tool: str, arguments: dict[str, Any]) -> str:
    if tool == "bash":
        command = arguments.get("command")
        if isinstance(command, str):
            try:
                tokens = shlex.split(command.lstrip("!"))
            except ValueError:
                tokens = command.split()
            for token in tokens:
                if "=" in token and not token.startswith(("./", "/")):
                    continue
                if token in {"env", "sudo", "command", "timeout"}:
                    continue
                return Path(token).name or "shell"
        return "shell"
    path = arguments.get("path")
    if isinstance(path, str):
        suffix = Path(path).suffix.lower()
        return f"path:{suffix or '<none>'}"
    for key in ("op", "action", "command", "type", "name"):
        value = arguments.get(key)
        if isinstance(value, (str, int, float, bool)):
            return f"{key}:{truncate(str(value), 80)}"
    return "default"


def command_patterns(args: argparse.Namespace) -> dict[str, Any]:
    path, header, branch, warnings, analysis = session_context(args)
    min_count = max(1, args.min_count)
    example_count = max(0, args.examples)
    example_chars = max(40, args.example_chars)
    calls = tool_records(branch, include_results=False, max_chars=args.max_chars)
    grouped: dict[tuple[str, str, tuple[str, ...]], list[dict[str, Any]]] = defaultdict(list)
    for call in calls:
        if args.tool and call["tool"] != args.tool:
            continue
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        argument_keys = tuple(sorted(str(key) for key in arguments))
        key = (call["tool"], infer_operation(call["tool"], arguments), argument_keys)
        grouped[key].append(call)

    groups: list[dict[str, Any]] = []
    for (tool, operation, argument_keys), records in grouped.items():
        if len(records) < min_count:
            continue
        groups.append(
            {
                "tool": tool,
                "operation": operation,
                "argument_keys": list(argument_keys),
                "calls": len(records),
                "successes": sum(record["status"] == "success" for record in records),
                "errors": sum(record["status"] == "error" for record in records),
                "pending": sum(record["status"] == "pending" for record in records),
                "first_timestamp": records[0].get("timestamp"),
                "last_timestamp": records[-1].get("timestamp"),
                "examples": [
                    {
                        "sequence": record["sequence"],
                        "entry_id": record["entry_id"],
                        "tool_call_id": record["tool_call_id"],
                        "status": record["status"],
                        "argument_preview": truncate(
                            json.dumps(record["arguments"], ensure_ascii=False, sort_keys=True, default=str),
                            example_chars,
                        ),
                    }
                    for record in records[:example_count]
                ],
            }
        )
    groups.sort(key=lambda item: (-item["calls"], item["tool"], item["operation"]))
    matched_patterns = len(groups)
    if args.limit:
        groups = groups[: args.limit]
    output = base_meta(path, header, branch, warnings, analysis)
    output["patterns"] = {
        "filters": {
            "tool": args.tool,
            "min_count": min_count,
            "examples": example_count,
            "example_chars": example_chars,
            "limit": args.limit,
        },
        "total_calls": len(calls),
        "matched_patterns": matched_patterns,
        "returned_patterns": len(groups),
        "groups": groups,
    }
    return output


def searchable_text(call: dict[str, Any]) -> str:
    return json.dumps(call, ensure_ascii=False, sort_keys=True, default=str)


def command_search(args: argparse.Namespace) -> dict[str, Any]:
    path, header, branch, warnings, analysis = session_context(args)
    calls = tool_records(branch, include_results=True, max_chars=args.max_chars)
    async_outcomes = async_outcome_records(branch, include_results=True, max_chars=args.max_chars)
    query = args.query.casefold() if args.query else None
    matches = []
    for call in calls:
        if args.tool and call["tool"] != args.tool:
            continue
        if args.errors_only and call["status"] != "error":
            continue
        if query and query not in searchable_text(call).casefold():
            continue
        if not args.include_results:
            call.pop("result", None)
        matches.append(call)
    async_matches = []
    for outcome in async_outcomes:
        if args.tool and args.tool != outcome["tool"]:
            continue
        if args.errors_only and outcome["status"] != "error":
            continue
        if query and query not in searchable_text(outcome).casefold():
            continue
        if not args.include_results:
            outcome.pop("result", None)
        async_matches.append(outcome)
    if args.limit:
        matches = matches[-args.limit :]
        async_matches = async_matches[-args.limit :]
    output = base_meta(path, header, branch, warnings, analysis)
    output["search"] = {
        "filters": {
            "tool": args.tool,
            "query": args.query,
            "errors_only": args.errors_only,
            "include_results": args.include_results,
        },
        "matched_calls": len(matches),
        "calls": matches,
        "matched_async_outcomes": len(async_matches),
        "async_outcomes": async_matches,
    }
    return output


def timeline_item(entry: dict[str, Any], args: argparse.Namespace) -> dict[str, Any] | None:
    entry_type = str(entry.get("type", "unknown"))
    base = {"entry_id": entry.get("id"), "timestamp": entry.get("timestamp"), "type": entry_type}
    if entry_type == "message":
        message = entry.get("message")
        if not isinstance(message, dict):
            return None
        role = str(message.get("role", "unknown"))
        base["role"] = role
        if role in {"user", "assistant"}:
            base["text"] = message_text(message, args.max_chars)
            if role == "assistant" and isinstance(message.get("content"), list):
                base["tool_calls"] = [
                    {"id": block.get("id"), "tool": block.get("name")}
                    for block in message["content"]
                    if isinstance(block, dict) and block.get("type") == "toolCall"
                ]
            return base
        if role == "toolResult":
            base.update(
                {
                    "tool": message.get("toolName"),
                    "tool_call_id": message.get("toolCallId"),
                    "status": "error" if message.get("isError") is True else "success",
                }
            )
            if args.include_results:
                base["result"] = result_text(message, args.max_chars)
            return base
        if role == "bashExecution":
            base["command"] = truncate(str(message.get("command", "")), args.max_chars)
            base["status"] = "error" if message.get("exitCode") not in (0, None) else "success"
            if args.include_results:
                base["result"] = truncate(str(message.get("output", "")), args.max_chars)
            return base
        return base
    if entry_type in {"compaction", "branch_summary"}:
        base["summary"] = truncate(str(entry.get("summary", "")), args.max_chars)
        return base
    if entry_type == "model_change":
        base["model"] = f"{entry.get('provider')}/{entry.get('modelId')}"
        return base
    if entry_type == "thinking_level_change":
        base["thinking_level"] = entry.get("thinkingLevel")
        return base
    if entry_type == "custom_message":
        base["custom_type"] = entry.get("customType")
        base["text"] = truncate(str(entry.get("content", "")), args.max_chars)
        return base
    if args.include_metadata:
        base["metadata"] = sanitize(
            {key: value for key, value in entry.items() if key not in {"id", "parentId", "timestamp", "type", "data"}},
            args.max_chars,
        )
        return base
    return None


def command_timeline(args: argparse.Namespace) -> dict[str, Any]:
    path, header, branch, warnings, analysis = session_context(args)
    items = [item for entry in branch if (item := timeline_item(entry, args)) is not None]
    if args.limit:
        items = items[-args.limit :]
    output = base_meta(path, header, branch, warnings, analysis)
    output["timeline"] = {"items": items, "returned_entries": len(items)}
    return output


def add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--session", help="Session JSONL path; defaults to PI_SESSION_FILE")
    parser.add_argument("--leaf-id", help="Analyze a specific branch leaf instead of the latest entry")
    parser.add_argument(
        "--exclude-current-turn",
        action="store_true",
        help="Freeze analysis before the latest user message so inspector calls do not observe themselves",
    )
    parser.add_argument("--max-chars", type=int, default=2_000, help="Maximum characters per text or argument value")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    summary = subparsers.add_parser("summary", help="Session, usage, and aggregate tool statistics")
    add_common_options(summary)
    summary.set_defaults(handler=command_summary)

    tools = subparsers.add_parser("tools", help="Tool-call frequencies and invocation history")
    add_common_options(tools)
    tools.add_argument("--tool", help="Only include one exact tool name")
    tools.add_argument("--include-results", action="store_true", help="Include redacted tool result text")
    tools.add_argument("--limit", type=int, default=200, help="Return the latest N matching calls; 0 means all")
    tools.set_defaults(handler=command_tools)

    patterns = subparsers.add_parser("patterns", help="Bounded repeated tool and argument-shape patterns")
    add_common_options(patterns)
    patterns.add_argument("--tool", help="Only include one exact tool name")
    patterns.add_argument("--min-count", type=int, default=2, help="Minimum calls required for a pattern")
    patterns.add_argument("--examples", type=int, default=3, help="Maximum example calls per pattern")
    patterns.add_argument("--example-chars", type=int, default=400, help="Maximum characters per example argument preview")
    patterns.add_argument("--limit", type=int, default=50, help="Maximum returned pattern groups; 0 means all")
    patterns.set_defaults(handler=command_patterns)

    search = subparsers.add_parser("search", help="Search tool names, arguments, and optionally results")
    add_common_options(search)
    search.add_argument("--tool", help="Only include one exact tool name")
    search.add_argument("--query", help="Case-insensitive substring search")
    search.add_argument("--errors-only", action="store_true", help="Only include failed tool calls")
    search.add_argument("--include-results", action="store_true", help="Return redacted result text")
    search.add_argument("--limit", type=int, default=100, help="Return the latest N matches; 0 means all")
    search.set_defaults(handler=command_search)

    timeline = subparsers.add_parser("timeline", help="Compact active-branch timeline without thinking or images")
    add_common_options(timeline)
    timeline.add_argument("--include-results", action="store_true", help="Include redacted tool/bash results")
    timeline.add_argument("--include-metadata", action="store_true", help="Include non-message branch metadata")
    timeline.add_argument("--limit", type=int, default=300, help="Return the latest N items; 0 means all")
    timeline.set_defaults(handler=command_timeline)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        output = args.handler(args)
    except (OSError, ValueError) as error:
        print(json.dumps({"schema_version": SCHEMA_VERSION, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    indent = 2 if args.pretty else None
    print(json.dumps(output, ensure_ascii=False, indent=indent, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

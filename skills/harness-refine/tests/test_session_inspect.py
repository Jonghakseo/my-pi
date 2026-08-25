#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "session_inspect.py"


def row(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False)


def assistant_message(*blocks: dict) -> dict:
    return {
        "role": "assistant",
        "content": list(blocks),
        "provider": "test-provider",
        "model": "test-model",
        "stopReason": "toolUse",
        "usage": {
            "input": 100,
            "output": 20,
            "cacheRead": 10,
            "cacheWrite": 0,
            "totalTokens": 130,
            "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0.01, "cacheWrite": 0, "total": 0.31},
        },
        "timestamp": 1,
    }


class SessionInspectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.session_path = Path(self.temp_dir.name) / "session.jsonl"
        entries = [
            {"type": "session", "version": 3, "id": "session-test", "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/tmp/project"},
            {"type": "model_change", "id": "m0", "parentId": None, "timestamp": "2026-01-01T00:00:01.000Z", "provider": "test-provider", "modelId": "test-model"},
            {"type": "message", "id": "u1", "parentId": "m0", "timestamp": "2026-01-01T00:00:02.000Z", "message": {"role": "user", "content": "Run the tests", "timestamp": 1}},
            {"type": "message", "id": "a-old", "parentId": "u1", "timestamp": "2026-01-01T00:00:03.000Z", "message": assistant_message({"type": "toolCall", "id": "old-call", "name": "obsolete", "arguments": {}})},
            {"type": "message", "id": "r-old", "parentId": "a-old", "timestamp": "2026-01-01T00:00:04.000Z", "message": {"role": "toolResult", "toolCallId": "old-call", "toolName": "obsolete", "content": [{"type": "text", "text": "old branch"}], "isError": False, "timestamp": 2}},
            {"type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-01-01T00:00:05.000Z", "message": assistant_message(
                {"type": "thinking", "thinking": "never expose this"},
                {"type": "text", "text": "I will inspect the failure."},
                {"type": "toolCall", "id": "call-bash", "name": "bash", "arguments": {"command": "pytest tests/test_api.py", "API_KEY": "secret-value"}},
                {"type": "toolCall", "id": "call-read", "name": "read", "arguments": {"path": "/tmp/project/config.py"}},
            )},
            {"type": "message", "id": "r1", "parentId": "a1", "timestamp": "2026-01-01T00:00:07.000Z", "message": {"role": "toolResult", "toolCallId": "call-bash", "toolName": "bash", "content": [{"type": "text", "text": "failed with sk-abcdefghijklmnopqrstuvwxyz123456"}], "isError": True, "timestamp": 3}},
            {"type": "message", "id": "r2", "parentId": "r1", "timestamp": "2026-01-01T00:00:08.000Z", "message": {"role": "toolResult", "toolCallId": "call-read", "toolName": "read", "content": [{"type": "text", "text": "configuration"}], "isError": False, "timestamp": 4}},
            {"type": "custom_message", "id": "async-ok", "parentId": "r2", "timestamp": "2026-01-01T00:00:08.200Z", "customType": "subagent-tool", "content": "[subagent:worker#1] completed\nPrompt: inspect code"},
            {"type": "custom_message", "id": "async-error", "parentId": "async-ok", "timestamp": "2026-01-01T00:00:08.400Z", "customType": "subagent-tool", "content": "[subagent-batch#batch-1] error\nRuns: #1 done, #2 error\nCause: API_TOKEN=super-secret-value"},
            {"type": "message", "id": "u2", "parentId": "async-error", "timestamp": "2026-01-01T00:00:09.000Z", "message": {"role": "user", "content": "Use the project runner next time", "timestamp": 5}},
        ]
        self.session_path.write_text("\n".join(row(entry) for entry in entries) + "\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_cli(self, *args: str, use_env: bool = False) -> dict:
        command = ["python3", str(SCRIPT), *args]
        env = os.environ.copy()
        if use_env:
            env["PI_SESSION_FILE"] = str(self.session_path)
            env["PI_SESSION_ID"] = "session-test"
        else:
            command.extend(["--session", str(self.session_path)])
        result = subprocess.run(command, check=True, capture_output=True, text=True, env=env)
        return json.loads(result.stdout)

    def test_summary_uses_active_branch_and_reports_frequency(self) -> None:
        output = self.run_cli("summary")
        tools = output["summary"]["tools"]
        self.assertEqual(tools["total_calls"], 2)
        self.assertEqual(tools["errors"], 1)
        self.assertEqual([item["tool"] for item in tools["by_tool"]], ["bash", "read"])
        self.assertEqual(tools["by_tool"][0]["frequency_percent"], 50.0)
        self.assertNotIn("obsolete", json.dumps(output))
        self.assertEqual(output["summary"]["usage"]["tokens"]["totalTokens"], 130)

    def test_summary_reports_async_subagent_outcomes_separately(self) -> None:
        output = self.run_cli("summary")
        outcomes = output["summary"]["async_outcomes"]

        self.assertEqual(outcomes, {"total": 2, "successes": 1, "errors": 1})
        self.assertEqual(output["summary"]["tools"]["errors"], 1)

    def test_tools_redacts_secret_arguments_and_results(self) -> None:
        output = self.run_cli("tools", "--include-results")
        serialized = json.dumps(output, ensure_ascii=False)
        self.assertNotIn("secret-value", serialized)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz123456", serialized)
        self.assertIn("<redacted>", serialized)
        bash_call = output["tools"]["calls"][0]
        self.assertEqual(bash_call["status"], "error")
        self.assertEqual(bash_call["duration_ms"], 2000)

    def test_search_filters_tool_arguments_and_errors(self) -> None:
        output = self.run_cli(
            "search",
            "--tool",
            "bash",
            "--query",
            "pytest",
            "--errors-only",
            "--include-results",
        )
        self.assertEqual(output["search"]["matched_calls"], 1)
        self.assertEqual(output["search"]["calls"][0]["tool"], "bash")

    def test_search_errors_includes_redacted_async_subagent_outcomes(self) -> None:
        output = self.run_cli("search", "--errors-only", "--include-results")
        search = output["search"]
        serialized = json.dumps(search, ensure_ascii=False)

        self.assertEqual(search["matched_calls"], 1)
        self.assertEqual(search["matched_async_outcomes"], 1)
        self.assertEqual(search["async_outcomes"][0]["async_id"], "subagent-batch#batch-1")
        self.assertNotIn("super-secret-value", serialized)
        self.assertIn("<redacted>", serialized)

    def test_search_tool_filter_applies_to_async_subagent_outcomes(self) -> None:
        output = self.run_cli("search", "--tool", "bash", "--errors-only")
        self.assertEqual(output["search"]["matched_async_outcomes"], 0)

        output = self.run_cli("search", "--tool", "subagent", "--errors-only")
        self.assertEqual(output["search"]["matched_calls"], 0)
        self.assertEqual(output["search"]["matched_async_outcomes"], 1)

    def test_timeline_excludes_thinking_and_old_branch(self) -> None:
        output = self.run_cli("timeline")
        serialized = json.dumps(output, ensure_ascii=False)
        self.assertIn("I will inspect the failure", serialized)
        self.assertNotIn("never expose this", serialized)
        self.assertNotIn("old branch", serialized)

    def test_exclude_current_turn_uses_stable_pre_user_snapshot(self) -> None:
        current_assistant = {
            "type": "message",
            "id": "a-current",
            "parentId": "u2",
            "timestamp": "2026-01-01T00:00:10.000Z",
            "message": assistant_message(
                {
                    "type": "toolCall",
                    "id": "call-inspector",
                    "name": "bash",
                    "arguments": {"command": "session_inspect.py summary"},
                }
            ),
        }
        with self.session_path.open("a", encoding="utf-8") as handle:
            handle.write(row(current_assistant) + "\n")

        unbounded = self.run_cli("summary")
        bounded = self.run_cli("summary", "--exclude-current-turn")

        self.assertEqual(unbounded["summary"]["tools"]["pending"], 1)
        self.assertEqual(bounded["summary"]["tools"]["total_calls"], 2)
        self.assertEqual(bounded["summary"]["tools"]["pending"], 0)
        self.assertEqual(bounded["analysis"]["cutoff_reason"], "before_latest_user")
        self.assertEqual(bounded["analysis"]["source_leaf_id"], "a-current")
        self.assertEqual(bounded["analysis"]["cutoff_leaf_id"], "async-error")
        self.assertEqual(bounded["analysis"]["excluded_entries"], 2)

    def test_patterns_returns_bounded_argument_shape_groups(self) -> None:
        output = self.run_cli(
            "patterns", "--min-count", "1", "--examples", "1", "--example-chars", "80"
        )
        groups = output["patterns"]["groups"]
        by_tool = {group["tool"]: group for group in groups}

        self.assertEqual(output["patterns"]["matched_patterns"], 2)
        self.assertEqual(by_tool["bash"]["operation"], "pytest")
        self.assertEqual(by_tool["bash"]["argument_keys"], ["API_KEY", "command"])
        self.assertEqual(len(by_tool["bash"]["examples"]), 1)
        self.assertLessEqual(len(by_tool["bash"]["examples"][0]["argument_preview"]), 80)
        self.assertEqual(by_tool["read"]["operation"], "path:.py")

    def test_environment_resolves_and_verifies_current_session(self) -> None:
        output = self.run_cli("summary", use_env=True)
        self.assertEqual(output["session"]["id"], "session-test")

    def test_environment_id_mismatch_fails_closed(self) -> None:
        env = os.environ.copy()
        env["PI_SESSION_FILE"] = str(self.session_path)
        env["PI_SESSION_ID"] = "wrong-session"
        result = subprocess.run(
            ["python3", str(SCRIPT), "summary"], capture_output=True, text=True, env=env
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("PI_SESSION_ID mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Validate a Pi/Agent Skills skill directory.

This intentionally uses only the Python standard library so the skill can run
without setup. It checks the constraints that most often break Pi skill loading.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def parse_frontmatter(text: str) -> Tuple[Dict[str, str], List[str]]:
    errors: List[str] = []
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["SKILL.md must start with YAML frontmatter delimiter '---'"]

    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, ["SKILL.md frontmatter is missing closing '---'"]

    data: Dict[str, str] = {}
    for raw in lines[1:end]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            errors.append(f"Unsupported frontmatter line (expected key: value): {raw}")
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        data[key] = value
    return data, errors


def validate(path: Path) -> int:
    errors: List[str] = []
    warnings: List[str] = []

    skill_dir = path.expanduser().resolve()
    if skill_dir.is_file():
        skill_file = skill_dir
        skill_dir = skill_file.parent
    else:
        skill_file = skill_dir / "SKILL.md"

    if not skill_file.exists():
        errors.append(f"Missing SKILL.md: {skill_file}")
        return report(skill_dir, errors, warnings)

    text = skill_file.read_text(encoding="utf-8")
    frontmatter, fm_errors = parse_frontmatter(text)
    errors.extend(fm_errors)

    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    compatibility = frontmatter.get("compatibility")

    if not name:
        errors.append("Missing required frontmatter field: name")
    else:
        if len(name) > 64:
            errors.append(f"name exceeds 64 characters: {len(name)}")
        if not NAME_RE.match(name):
            errors.append("name must use lowercase letters, numbers, and single hyphens only")
        if name != skill_dir.name:
            errors.append(f"name must match parent directory: name={name!r}, directory={skill_dir.name!r}")

    if not description:
        errors.append("Missing required frontmatter field: description")
    elif len(description) > 1024:
        errors.append(f"description exceeds 1024 characters: {len(description)}")

    if compatibility is not None and len(compatibility) > 500:
        errors.append(f"compatibility exceeds 500 characters: {len(compatibility)}")

    line_count = len(text.splitlines())
    if line_count > 500:
        warnings.append(f"SKILL.md is {line_count} lines; consider moving detail to references/")

    for directory in ("scripts", "references", "assets"):
        candidate = skill_dir / directory
        if candidate.exists() and not candidate.is_dir():
            errors.append(f"{directory}/ exists but is not a directory")

    return report(skill_dir, errors, warnings)


def report(skill_dir: Path, errors: List[str], warnings: List[str]) -> int:
    print(f"Validating: {skill_dir}")
    if warnings:
        print("\nWarnings:")
        for warning in warnings:
            print(f"  - {warning}")
    if errors:
        print("\nErrors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("\nOK: skill passed validation checks")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Pi/Agent Skills skill directory")
    parser.add_argument("skill_path", help="Path to a skill directory or SKILL.md file")
    args = parser.parse_args()
    return validate(Path(args.skill_path))


if __name__ == "__main__":
    sys.exit(main())

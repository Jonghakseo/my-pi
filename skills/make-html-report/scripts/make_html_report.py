#!/usr/bin/env python3
"""Validate and compile structured context reports into a single static HTML file."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

from html_renderer import Element, TrustedAssets, append_text, child, render_document


SCHEMA_VERSION = 1
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
ASSETS_DIR = SKILL_DIR / "assets"
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
INLINE_RE = re.compile(r"(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))")
LANGUAGE_RE = re.compile(r"^[a-z0-9-]+$")
ALLOWED_LINK_SCHEMES = {"", "http", "https", "mailto"}
ALLOWED_IMAGE_SCHEMES = {"", "http", "https", "data"}
RASTER_DATA_URL_RE = re.compile(r"^data:image/(?:png|jpeg|gif|webp);base64,")
SVG_DATA_URL_RE = re.compile(r"^data:image/svg\+xml;base64,")
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_PRE_PARSE_DENYLIST_RE = re.compile(r"<!\s*(?:doctype|entity)\b", re.IGNORECASE)
SVG_PROCESSING_INSTRUCTION_RE = re.compile(r"<\?(?!xml\s)", re.IGNORECASE)
SVG_RASTER_HREF_RE = re.compile(r"^data:image/(?:png|jpeg|gif|webp);base64,", re.IGNORECASE)
SVG_URL_RE = re.compile(r"url\(\s*([\"']?)(.*?)\1\s*\)", re.IGNORECASE)
SVG_FORBIDDEN_CSS_RE = re.compile(r"javascript:|expression\s*\(|@import|\\", re.IGNORECASE)
SVG_FORBIDDEN_ELEMENTS = {
    "script": "<script>",
    "foreignobject": "<foreignObject>",
    "iframe": "<iframe>",
    "embed": "<embed>",
    "object": "<object>",
    "animate": "an SVG animation element <animate>",
    "set": "an SVG animation element <set>",
    "animatetransform": "an SVG animation element <animateTransform>",
    "animatemotion": "an SVG animation element <animateMotion>",
    "animatecolor": "an SVG animation element <animateColor>",
}
BLOCK_KEYS: dict[str, set[str]] = {
    "prose": {"type", "heading", "paragraphs"},
    "bullets": {"type", "heading", "items"},
    "steps": {"type", "heading", "items"},
    "code": {
        "type",
        "title",
        "path",
        "caption",
        "language",
        "code",
        "start_line",
        "highlights",
        "collapsed_ranges",
    },
    "table": {"type", "heading", "caption", "columns", "rows"},
    "callout": {"type", "tone", "title", "body"},
    "quote": {"type", "quote", "attribution"},
    "image": {"type", "src", "alt", "caption"},
    "links": {"type", "heading", "items"},
}
UI_TEXT: dict[str, dict[str, Any]] = {
    "ko": {
        "overview_title": "한눈에 보기",
        "legend": "파란 선과 해설은 본문 설명에 직접 연결되는 코드입니다.",
        "toolbar_aria": "보기 설정",
        "expand_all": "전체 펼치기",
        "theme_auto": "테마: 자동",
        "attention_title": "먼저 볼 점",
        "attention_labels": {
            "action": "먼저 할 일",
            "caution": "주의해서 볼 점",
            "question": "확인할 질문",
            "info": "알아둘 점",
        },
        "block_count": "{}개 블록",
        "code_excerpt": "코드 인용",
        "annotation": "해설",
        "line_count": "{}줄",
        "callout_labels": {"info": "정보", "success": "확인", "warning": "주의", "danger": "위험"},
        "verification_title": "확인한 내용",
        "verification_labels": {"verified": "확인", "failed": "실패", "not_run": "미실행", "partial": "일부 확인"},
        "notes_summary": "범위와 작성 기준",
        "progress_aria": "문서 진행 상황",
        "current_flow": "현재 흐름",
        "zero_progress": "0% 읽음",
        "reading_flow": "읽는 흐름",
        "minimap_meta": "섹션 {} · 콘텐츠 블록 {}",
    },
    "en": {
        "overview_title": "At a glance",
        "legend": "Blue lines and notes connect code directly to the explanation.",
        "toolbar_aria": "View settings",
        "expand_all": "Expand all",
        "theme_auto": "Theme: auto",
        "attention_title": "Read first",
        "attention_labels": {
            "action": "Action",
            "caution": "Caution",
            "question": "Question",
            "info": "Context",
        },
        "block_count": "{} blocks",
        "code_excerpt": "Code excerpt",
        "annotation": "Note",
        "line_count": "{} lines",
        "callout_labels": {"info": "INFO", "success": "VERIFIED", "warning": "WARNING", "danger": "DANGER"},
        "verification_title": "What was checked",
        "verification_labels": {"verified": "Verified", "failed": "Failed", "not_run": "Not run", "partial": "Partial"},
        "notes_summary": "Scope and methodology",
        "progress_aria": "Document progress",
        "current_flow": "Current section",
        "zero_progress": "0% read",
        "reading_flow": "Reading flow",
        "minimap_meta": "{} sections · {} content blocks",
    },
}


class ReportError(RuntimeError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ReportError(f"input does not exist: {path}") from error
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ReportError(f"could not read JSON from {path}: {error}") from error
    if not isinstance(value, dict):
        raise ReportError("report root must be a JSON object")
    return value


def write_text_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def paths_are_same(left: Path, right: Path) -> bool:
    if left == right:
        return True
    try:
        return left.exists() and right.exists() and os.path.samefile(left, right)
    except OSError:
        return False


def is_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def ui_for(language: str) -> dict[str, Any]:
    return UI_TEXT[language.split("-", 1)[0]]


def expect_keys(value: dict[str, Any], *, allowed: set[str], path: str, errors: list[str]) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        errors.append(f"{path} has unknown fields: {', '.join(unknown)}")


def validate_url(value: Any, *, path: str, image: bool, errors: list[str]) -> None:
    if not is_string(value):
        errors.append(f"{path} must be a non-empty URL string")
        return
    try:
        parsed = urlsplit(value)
        parsed.port  # urllib validates malformed and out-of-range ports lazily.
    except ValueError as error:
        errors.append(f"{path} is not a valid URL: {error}")
        return
    allowed = ALLOWED_IMAGE_SCHEMES if image else ALLOWED_LINK_SCHEMES
    if parsed.scheme.lower() not in allowed:
        errors.append(f"{path} uses unsupported URL scheme: {parsed.scheme}")
        return
    if image and parsed.scheme.lower() == "data":
        prefix = value[:80].lower()
        if SVG_DATA_URL_RE.match(prefix):
            validate_svg_data_url(value, path=path, errors=errors)
        elif not RASTER_DATA_URL_RE.match(prefix):
            errors.append(f"{path} only permits base64 png, jpeg, gif, webp, or svg+xml data URLs")


def xml_local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1].lower()


def validate_svg_url_references(value: str, *, path: str, errors: list[str]) -> bool:
    for match in SVG_URL_RE.finditer(value):
        target = match.group(2).strip()
        if not target.startswith("#"):
            errors.append(f"{path} embeds SVG referencing an external url() resource: {target or '(empty url())'}")
            return False
    return True


def validate_svg_css(value: str, *, path: str, errors: list[str]) -> bool:
    if SVG_FORBIDDEN_CSS_RE.search(value):
        errors.append(f"{path} embeds SVG containing unsafe CSS, which is not allowed")
        return False
    return validate_svg_url_references(value, path=path, errors=errors)


def validate_svg_data_url(value: str, *, path: str, errors: list[str]) -> None:
    payload = value.split(",", 1)[1]
    try:
        markup = base64.b64decode(payload, validate=True).decode("utf-8")
    except (binascii.Error, ValueError):
        errors.append(f"{path} is not valid base64-encoded UTF-8 SVG markup")
        return
    if SVG_PRE_PARSE_DENYLIST_RE.search(markup):
        errors.append(f"{path} embeds SVG containing a DOCTYPE or ENTITY declaration, which is not allowed")
        return
    if SVG_PROCESSING_INSTRUCTION_RE.search(markup):
        errors.append(f"{path} embeds SVG containing a processing instruction, which is not allowed")
        return
    try:
        root = ElementTree.fromstring(markup)
    except ElementTree.ParseError as error:
        errors.append(f"{path} embeds SVG that is not well-formed XML: {error}")
        return
    if root.tag != f"{{{SVG_NAMESPACE}}}svg":
        errors.append(f"{path} embeds XML whose root element is not <svg> in the SVG namespace")
        return
    for element in root.iter():
        element_name = xml_local_name(element.tag)
        # Keep forbidden-name matching case-insensitive: inline SVG in HTML treats tag names case-insensitively.
        if element_name in SVG_FORBIDDEN_ELEMENTS:
            errors.append(
                f"{path} embeds SVG containing {SVG_FORBIDDEN_ELEMENTS[element_name]}, which is not allowed"
            )
            return
        for attribute, attribute_value in element.attrib.items():
            attribute_name = xml_local_name(attribute)
            if attribute_name.startswith("on"):
                errors.append(f"{path} embeds SVG containing an inline event handler attribute, which is not allowed")
                return
            if "javascript:" in attribute_value.lower():
                errors.append(f"{path} embeds SVG containing a javascript: URL, which is not allowed")
                return
            if attribute_name == "style" and not validate_svg_css(attribute_value, path=path, errors=errors):
                return
            if not validate_svg_url_references(attribute_value, path=path, errors=errors):
                return
            if attribute_name == "href" and not (
                attribute_value.startswith("#") or SVG_RASTER_HREF_RE.match(attribute_value)
            ):
                errors.append(
                    f"{path} embeds SVG referencing an external resource: {attribute_value or '(empty href)'}"
                )
                return
        if element_name == "style" and not validate_svg_css("".join(element.itertext()), path=path, errors=errors):
            return


def validate_markdown_links(text: str, *, path: str, errors: list[str]) -> None:
    for match in INLINE_RE.finditer(text):
        token = match.group(0)
        if token.startswith("["):
            target = token[token.rfind("](") + 2 : -1]
            validate_url(target, path=f"{path} inline link", image=False, errors=errors)


def validate_text(value: Any, *, path: str, errors: list[str], allow_empty: bool = False) -> None:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        qualifier = "string" if allow_empty else "non-empty string"
        errors.append(f"{path} must be a {qualifier}")
        return
    validate_markdown_links(value, path=path, errors=errors)


def validate_literal_text(value: Any, *, path: str, errors: list[str], allow_empty: bool = False) -> None:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        qualifier = "string" if allow_empty else "non-empty string"
        errors.append(f"{path} must be a {qualifier}")


def validate_string_list(
    value: Any,
    *,
    path: str,
    errors: list[str],
    minimum: int = 0,
    maximum: int | None = None,
) -> None:
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return
    if len(value) < minimum:
        errors.append(f"{path} must contain at least {minimum} item(s)")
    if maximum is not None and len(value) > maximum:
        errors.append(f"{path} must contain at most {maximum} item(s)")
    for index, item in enumerate(value):
        validate_text(item, path=f"{path}[{index}]", errors=errors)


def validate_named_items(
    value: Any,
    *,
    path: str,
    errors: list[str],
    required: set[str],
    optional: set[str] | None = None,
) -> None:
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return
    for index, item in enumerate(value):
        item_path = f"{path}[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{item_path} must be an object")
            continue
        expect_keys(item, allowed=required | (optional or set()), path=item_path, errors=errors)
        for field in required:
            validate_text(item.get(field), path=f"{item_path}.{field}", errors=errors)
        for field in optional or set():
            if field in item:
                validate_text(item[field], path=f"{item_path}.{field}", errors=errors)


def line_count(code: str) -> int:
    return max(1, len(code.splitlines()))


def validate_ranges(
    value: Any,
    *,
    path: str,
    errors: list[str],
    minimum_line: int,
    maximum_line: int,
    note_field: str,
) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return ranges
    for index, item in enumerate(value):
        item_path = f"{path}[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{item_path} must be an object")
            continue
        expect_keys(item, allowed={"start", "end", note_field}, path=item_path, errors=errors)
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, int) or isinstance(start, bool):
            errors.append(f"{item_path}.start must be an integer")
            continue
        if not isinstance(end, int) or isinstance(end, bool):
            errors.append(f"{item_path}.end must be an integer")
            continue
        if start > end:
            errors.append(f"{item_path} start must not exceed end")
        if start < minimum_line or end > maximum_line:
            errors.append(f"{item_path} must stay within code lines {minimum_line}-{maximum_line}")
        validate_text(item.get(note_field), path=f"{item_path}.{note_field}", errors=errors)
        ranges.append((start, end))
    for index, current in enumerate(sorted(ranges)):
        if index and current[0] <= sorted(ranges)[index - 1][1]:
            errors.append(f"{path} ranges must not overlap")
            break
    return ranges


def validate_block(block: Any, *, path: str, errors: list[str]) -> None:
    if not isinstance(block, dict):
        errors.append(f"{path} must be an object")
        return
    block_type = block.get("type")
    if not isinstance(block_type, str) or block_type not in BLOCK_KEYS:
        errors.append(f"{path}.type must be one of: {', '.join(BLOCK_KEYS)}")
        return
    expect_keys(block, allowed=BLOCK_KEYS[block_type], path=path, errors=errors)
    if "heading" in block:
        validate_text(block["heading"], path=f"{path}.heading", errors=errors)

    if block_type == "prose":
        validate_string_list(block.get("paragraphs"), path=f"{path}.paragraphs", errors=errors, minimum=1)
    elif block_type == "bullets":
        items = block.get("items")
        if not isinstance(items, list) or not items:
            errors.append(f"{path}.items must be a non-empty array")
        else:
            for index, item in enumerate(items):
                item_path = f"{path}.items[{index}]"
                if isinstance(item, str):
                    validate_text(item, path=item_path, errors=errors)
                elif isinstance(item, dict):
                    expect_keys(item, allowed={"title", "body"}, path=item_path, errors=errors)
                    validate_text(item.get("title"), path=f"{item_path}.title", errors=errors)
                    validate_text(item.get("body"), path=f"{item_path}.body", errors=errors)
                else:
                    errors.append(f"{item_path} must be a string or title/body object")
    elif block_type == "steps":
        validate_named_items(block.get("items"), path=f"{path}.items", errors=errors, required={"title", "body"})
        if isinstance(block.get("items"), list) and not block["items"]:
            errors.append(f"{path}.items must not be empty")
    elif block_type == "code":
        if "title" in block:
            validate_text(block["title"], path=f"{path}.title", errors=errors)
        if "path" in block:
            validate_text(block["path"], path=f"{path}.path", errors=errors)
        if "caption" in block:
            validate_text(block["caption"], path=f"{path}.caption", errors=errors)
        language = block.get("language")
        if language is not None and (not isinstance(language, str) or not LANGUAGE_RE.fullmatch(language)):
            errors.append(f"{path}.language must use lowercase letters, numbers, or hyphens")
        code = block.get("code")
        validate_literal_text(code, path=f"{path}.code", errors=errors, allow_empty=True)
        start_line = block.get("start_line", 1)
        if not isinstance(start_line, int) or isinstance(start_line, bool) or start_line < 1:
            errors.append(f"{path}.start_line must be a positive integer")
            start_line = 1
        if isinstance(code, str):
            maximum = start_line + line_count(code) - 1
            highlights = validate_ranges(
                block.get("highlights", []),
                path=f"{path}.highlights",
                errors=errors,
                minimum_line=start_line,
                maximum_line=maximum,
                note_field="note",
            )
            collapsed = validate_ranges(
                block.get("collapsed_ranges", []),
                path=f"{path}.collapsed_ranges",
                errors=errors,
                minimum_line=start_line,
                maximum_line=maximum,
                note_field="reason",
            )
            for highlight in highlights:
                for fold in collapsed:
                    if max(highlight[0], fold[0]) <= min(highlight[1], fold[1]):
                        errors.append(f"{path} highlights must not overlap collapsed_ranges")
                        return
    elif block_type == "table":
        columns = block.get("columns")
        validate_string_list(columns, path=f"{path}.columns", errors=errors, minimum=1)
        if "caption" in block:
            validate_text(block["caption"], path=f"{path}.caption", errors=errors)
        rows = block.get("rows")
        if not isinstance(rows, list) or not rows:
            errors.append(f"{path}.rows must be a non-empty array")
        elif isinstance(columns, list):
            for row_index, row in enumerate(rows):
                row_path = f"{path}.rows[{row_index}]"
                if not isinstance(row, list) or len(row) != len(columns):
                    errors.append(f"{row_path} must contain exactly {len(columns)} cells")
                    continue
                for column_index, cell in enumerate(row):
                    validate_text(cell, path=f"{row_path}[{column_index}]", errors=errors, allow_empty=True)
    elif block_type == "callout":
        tone = block.get("tone")
        if not isinstance(tone, str) or tone not in {"info", "success", "warning", "danger"}:
            errors.append(f"{path}.tone must be info, success, warning, or danger")
        validate_text(block.get("title"), path=f"{path}.title", errors=errors)
        validate_text(block.get("body"), path=f"{path}.body", errors=errors)
    elif block_type == "quote":
        validate_text(block.get("quote"), path=f"{path}.quote", errors=errors)
        if "attribution" in block:
            validate_text(block["attribution"], path=f"{path}.attribution", errors=errors)
    elif block_type == "image":
        validate_url(block.get("src"), path=f"{path}.src", image=True, errors=errors)
        validate_text(block.get("alt"), path=f"{path}.alt", errors=errors)
        if "caption" in block:
            validate_text(block["caption"], path=f"{path}.caption", errors=errors)
    elif block_type == "links":
        items = block.get("items")
        validate_named_items(items, path=f"{path}.items", errors=errors, required={"label", "url"}, optional={"note"})
        if isinstance(items, list):
            if not items:
                errors.append(f"{path}.items must not be empty")
            for index, item in enumerate(items):
                if isinstance(item, dict):
                    validate_url(item.get("url"), path=f"{path}.items[{index}].url", image=False, errors=errors)


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    expect_keys(
        report,
        allowed={
            "schema_version",
            "language",
            "kicker",
            "title",
            "summary",
            "metadata",
            "overview",
            "attention",
            "sections",
            "verification",
            "notes",
        },
        path="report",
        errors=errors,
    )
    if report.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"report.schema_version must be {SCHEMA_VERSION}")
    language = report.get("language", "ko")
    if (
        not isinstance(language, str)
        or not re.fullmatch(r"[a-z]{2,3}(?:-[A-Za-z0-9]+)*", language)
        or language.split("-", 1)[0] not in UI_TEXT
    ):
        errors.append("report.language must be a supported Korean or English tag such as ko or en-US")
    for field in ("kicker", "title", "summary"):
        validate_text(report.get(field), path=f"report.{field}", errors=errors)

    metadata = report.get("metadata", [])
    validate_named_items(metadata, path="report.metadata", errors=errors, required={"label", "value"})
    if isinstance(metadata, list) and len(metadata) > 6:
        errors.append("report.metadata must contain at most 6 items")
    validate_string_list(report.get("overview"), path="report.overview", errors=errors, minimum=1, maximum=5)

    attention = report.get("attention", [])
    if not isinstance(attention, list):
        errors.append("report.attention must be an array")
    else:
        for index, item in enumerate(attention):
            item_path = f"report.attention[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{item_path} must be an object")
                continue
            expect_keys(item, allowed={"tone", "title", "body"}, path=item_path, errors=errors)
            tone = item.get("tone")
            if not isinstance(tone, str) or tone not in {"action", "caution", "question", "info"}:
                errors.append(f"{item_path}.tone must be action, caution, question, or info")
            validate_text(item.get("title"), path=f"{item_path}.title", errors=errors)
            validate_text(item.get("body"), path=f"{item_path}.body", errors=errors)

    sections = report.get("sections")
    section_ids: set[str] = set()
    if not isinstance(sections, list) or not sections:
        errors.append("report.sections must be a non-empty array")
    else:
        for index, section in enumerate(sections):
            path = f"report.sections[{index}]"
            if not isinstance(section, dict):
                errors.append(f"{path} must be an object")
                continue
            expect_keys(
                section,
                allowed={"id", "title", "summary", "default_open", "blocks"},
                path=path,
                errors=errors,
            )
            section_id = section.get("id")
            if not isinstance(section_id, str) or not ID_RE.fullmatch(section_id):
                errors.append(f"{path}.id must use lowercase kebab-case")
            elif section_id in section_ids:
                errors.append(f"{path}.id duplicates {section_id}")
            else:
                section_ids.add(section_id)
            validate_text(section.get("title"), path=f"{path}.title", errors=errors)
            validate_text(section.get("summary"), path=f"{path}.summary", errors=errors)
            if not isinstance(section.get("default_open"), bool):
                errors.append(f"{path}.default_open must be a boolean")
            blocks = section.get("blocks")
            if not isinstance(blocks, list) or not blocks:
                errors.append(f"{path}.blocks must be a non-empty array")
            else:
                for block_index, block in enumerate(blocks):
                    validate_block(block, path=f"{path}.blocks[{block_index}]", errors=errors)

    verification = report.get("verification", [])
    if not isinstance(verification, list):
        errors.append("report.verification must be an array")
    else:
        for index, item in enumerate(verification):
            path = f"report.verification[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{path} must be an object")
                continue
            expect_keys(item, allowed={"status", "label", "detail"}, path=path, errors=errors)
            status = item.get("status")
            if not isinstance(status, str) or status not in {"verified", "failed", "not_run", "partial"}:
                errors.append(f"{path}.status must be verified, failed, not_run, or partial")
            validate_text(item.get("label"), path=f"{path}.label", errors=errors)
            validate_text(item.get("detail"), path=f"{path}.detail", errors=errors)

    validate_string_list(report.get("notes", []), path="report.notes", errors=errors)
    return errors


def append_inline(parent: Element, text: str) -> None:
    position = 0
    for match in INLINE_RE.finditer(text):
        append_text(parent, text[position : match.start()])
        token = match.group(0)
        if token.startswith("**"):
            child(parent, "strong", token[2:-2])
        elif token.startswith("`"):
            child(parent, "code", token[1:-1], {"class": "inline-code"})
        else:
            split_at = token.rfind("](")
            label = token[1:split_at]
            target = token[split_at + 2 : -1]
            child(parent, "a", label, {"href": target, "rel": "noreferrer"})
        position = match.end()
    append_text(parent, text[position:])


def append_rich_text(parent: Element, text: str) -> None:
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if index:
            child(parent, "br")
        append_inline(parent, line)


def append_optional_heading(parent: Element, block: dict[str, Any]) -> None:
    if block.get("heading"):
        child(parent, "h3", block["heading"], {"class": "block-heading"})


def ranges_by_start(items: list[dict[str, Any]], field: str) -> dict[int, dict[str, Any]]:
    return {item["start"]: item for item in items if field in item}


def render_code_block(
    section_id: str,
    block_index: int,
    block: dict[str, Any],
    ui: dict[str, Any],
) -> Element:
    article = Element("article", {"class": "artifact code-artifact"})
    header = child(article, "header", attributes={"class": "artifact-header"})
    identity = child(header, "div")
    child(identity, "h3", block.get("title") or block.get("path") or ui["code_excerpt"])
    if block.get("path"):
        child(identity, "p", block["path"], {"class": "artifact-path"})
    if block.get("caption"):
        caption = child(header, "p", attributes={"class": "artifact-caption"})
        append_rich_text(caption, block["caption"])

    code = block["code"]
    lines = code.splitlines() or [""]
    start_line = block.get("start_line", 1)
    highlights = block.get("highlights", [])
    folds = ranges_by_start(block.get("collapsed_ranges", []), "reason")
    notes = ranges_by_start(highlights, "note")
    highlighted_lines = {
        line_number
        for item in highlights
        for line_number in range(item["start"], item["end"] + 1)
    }
    code_grid = child(article, "div", attributes={"class": "code-grid"})
    offset = 0
    while offset < len(lines):
        line_number = start_line + offset
        if line_number in folds:
            fold = folds[line_number]
            count = fold["end"] - fold["start"] + 1
            details = child(code_grid, "details", attributes={"class": "code-fold"})
            summary = child(details, "summary")
            child(summary, "span", "···", {"class": "fold-gutter", "aria-hidden": "true"})
            fold_copy = child(summary, "span", attributes={"class": "fold-copy"})
            child(fold_copy, "span", fold["reason"], {"class": "fold-reason"})
            child(fold_copy, "span", ui["line_count"].format(count), {"class": "fold-count"})
            folded = child(details, "div", attributes={"class": "folded-code"})
            for folded_offset in range(offset, offset + count):
                actual = start_line + folded_offset
                folded.append(render_code_line(section_id, block_index, actual, lines[folded_offset], block.get("language"), False))
            offset += count
            continue
        if line_number in notes:
            note = child(code_grid, "aside", attributes={"class": "inline-code-note"})
            child(note, "span", ui["annotation"])
            copy = child(note, "p")
            append_rich_text(copy, notes[line_number]["note"])
        code_grid.append(
            render_code_line(
                section_id,
                block_index,
                line_number,
                lines[offset],
                block.get("language"),
                line_number in highlighted_lines,
            )
        )
        offset += 1
    return article


def render_code_line(
    section_id: str,
    block_index: int,
    line_number: int,
    text: str,
    language: str | None,
    focus: bool,
) -> Element:
    classes = "code-line focus" if focus else "code-line"
    row = Element(
        "div",
        {
            "id": f"code-{section_id}-{block_index}-L{line_number}",
            "class": classes,
        },
    )
    child(row, "span", str(line_number), {"class": "line-number"})
    cell = child(row, "span", attributes={"class": "code-cell"})
    attributes = {"class": f"language-{language}"} if language else None
    child(cell, "code", text, attributes)
    return row


def render_block(
    section_id: str,
    block_index: int,
    block: dict[str, Any],
    ui: dict[str, Any],
) -> Element:
    block_type = block["type"]
    if block_type == "code":
        return render_code_block(section_id, block_index, block, ui)

    article = Element("article", {"class": f"content-block {block_type}-block"})
    append_optional_heading(article, block)
    if block_type == "prose":
        for paragraph in block["paragraphs"]:
            node = child(article, "p")
            append_rich_text(node, paragraph)
    elif block_type == "bullets":
        listing = child(article, "ul", attributes={"class": "bullet-list"})
        for item in block["items"]:
            node = child(listing, "li")
            if isinstance(item, str):
                append_rich_text(node, item)
            else:
                child(node, "strong", item["title"])
                body = child(node, "span")
                append_rich_text(body, item["body"])
    elif block_type == "steps":
        listing = child(article, "ol", attributes={"class": "step-list"})
        for item in block["items"]:
            node = child(listing, "li")
            copy = child(node, "div")
            child(copy, "h4", item["title"])
            body = child(copy, "p")
            append_rich_text(body, item["body"])
    elif block_type == "table":
        if block.get("caption"):
            caption = child(article, "p", attributes={"class": "table-caption"})
            append_rich_text(caption, block["caption"])
        scroll = child(article, "div", attributes={"class": "table-scroll"})
        table = child(scroll, "table")
        head = child(table, "thead")
        header_row = child(head, "tr")
        for column in block["columns"]:
            cell = child(header_row, "th", attributes={"scope": "col"})
            append_rich_text(cell, column)
        body = child(table, "tbody")
        for row in block["rows"]:
            row_node = child(body, "tr")
            for value in row:
                cell = child(row_node, "td")
                append_rich_text(cell, value)
    elif block_type == "callout":
        article.set("class", f'content-block callout {block["tone"]}')
        child(article, "p", ui["callout_labels"][block["tone"]], {"class": "callout-label"})
        child(article, "h3", block["title"])
        copy = child(article, "p")
        append_rich_text(copy, block["body"])
    elif block_type == "quote":
        quote = child(article, "blockquote")
        copy = child(quote, "p")
        append_rich_text(copy, block["quote"])
        if block.get("attribution"):
            child(quote, "cite", block["attribution"])
    elif block_type == "image":
        figure = child(article, "figure")
        child(figure, "img", attributes={"src": block["src"], "alt": block["alt"], "loading": "lazy"})
        if block.get("caption"):
            caption = child(figure, "figcaption")
            append_rich_text(caption, block["caption"])
    elif block_type == "links":
        listing = child(article, "ul", attributes={"class": "link-list"})
        for item in block["items"]:
            node = child(listing, "li")
            child(node, "a", item["label"], {"href": item["url"], "rel": "noreferrer"})
            if item.get("note"):
                note = child(node, "span")
                append_rich_text(note, item["note"])
    return article


def render_report(report: dict[str, Any]) -> str:
    ui = ui_for(report.get("language", "ko"))
    main = Element("main", {"class": "shell"})
    header = child(main, "header", attributes={"class": "report-header"})
    child(header, "p", report["kicker"], {"class": "report-kicker"})
    child(header, "h1", report["title"])
    summary = child(header, "p", attributes={"class": "summary"})
    append_rich_text(summary, report["summary"])
    if report.get("metadata"):
        stats = child(header, "dl", attributes={"class": "report-stats"})
        for item in report["metadata"]:
            stat = child(stats, "div", attributes={"class": "report-stat"})
            child(stat, "dt", item["label"])
            value = child(stat, "dd")
            append_rich_text(value, item["value"])

    overview = child(main, "section", attributes={"class": "overview report-section"})
    child(overview, "p", "OVERVIEW", {"class": "section-label"})
    child(overview, "h2", ui["overview_title"])
    overview_list = child(overview, "ul")
    for item in report["overview"]:
        node = child(overview_list, "li")
        append_rich_text(node, item)
    legend = child(overview, "p", attributes={"class": "legend"})
    child(legend, "span")
    append_text(legend, ui["legend"])

    toolbar = child(main, "div", attributes={"class": "toolbar", "aria-label": ui["toolbar_aria"]})
    child(toolbar, "button", ui["expand_all"], {"type": "button", "data-action": "expand-all"})
    child(toolbar, "button", ui["theme_auto"], {"type": "button", "data-action": "toggle-theme"})

    layout = child(main, "div", attributes={"class": "report-layout"})
    content = child(layout, "div", attributes={"class": "report-content"})

    if report.get("attention"):
        labels = ui["attention_labels"]
        attention = child(content, "section", attributes={"class": "attention report-section"})
        child(attention, "p", "ATTENTION", {"class": "section-label"})
        child(attention, "h2", ui["attention_title"])
        for item in report["attention"]:
            article = child(attention, "article", attributes={"class": f'attention-item {item["tone"]}'})
            child(article, "p", labels[item["tone"]], {"class": "attention-label"})
            child(article, "h3", item["title"])
            body = child(article, "p")
            append_rich_text(body, item["body"])

    sections = report["sections"]
    for section_index, section in enumerate(sections, start=1):
        attributes = {
            "id": f'section-{section["id"]}',
            "class": "report-chapter",
            "data-report-section": section["id"],
        }
        if section["default_open"]:
            attributes["open"] = ""
        chapter = child(content, "details", attributes=attributes)
        chapter_summary = child(chapter, "summary")
        child(chapter_summary, "span", f"{section_index:02d}", {"class": "section-number"})
        child(chapter_summary, "span", section["title"], {"class": "section-heading"})
        summary_copy = child(chapter_summary, "span", attributes={"class": "section-summary"})
        append_rich_text(summary_copy, section["summary"])
        child(
            chapter_summary,
            "span",
            ui["block_count"].format(len(section["blocks"])),
            {"class": "section-count"},
        )
        body = child(chapter, "div", attributes={"class": "section-body"})
        for block_index, block in enumerate(section["blocks"], start=1):
            body.append(render_block(section["id"], block_index, block, ui))

    if report.get("verification"):
        labels = ui["verification_labels"]
        verification = child(content, "section", attributes={"class": "verification report-section"})
        child(verification, "p", "VERIFICATION", {"class": "section-label"})
        child(verification, "h2", ui["verification_title"])
        listing = child(verification, "ul")
        for item in report["verification"]:
            node = child(listing, "li")
            child(node, "strong", labels[item["status"]], {"class": f'status {item["status"]}'})
            copy = child(node, "span")
            child(copy, "b", item["label"])
            append_text(copy, " — ")
            append_rich_text(copy, item["detail"])

    if report.get("notes"):
        notes = child(content, "details", attributes={"class": "technical report-section"})
        child(notes, "summary", ui["notes_summary"])
        listing = child(notes, "ul")
        for item in report["notes"]:
            node = child(listing, "li")
            append_rich_text(node, item)

    first_section = sections[0]
    minimap = child(layout, "aside", attributes={"class": "minimap", "aria-label": ui["progress_aria"]})
    compact = child(
        minimap,
        "button",
        attributes={
            "type": "button",
            "class": "minimap-compact",
            "data-action": "toggle-minimap",
            "aria-expanded": "false",
        },
    )
    child(compact, "span", ui["current_flow"], {"class": "minimap-compact-kicker"})
    child(compact, "strong", f'01/{len(sections):02d} · {first_section["title"]}', {"data-minimap-current": ""})
    child(compact, "span", ui["zero_progress"], {"data-minimap-percent": ""})
    progress = child(compact, "span", attributes={"class": "minimap-progress"})
    child(progress, "i", attributes={"data-minimap-progress": ""})

    navigation = child(minimap, "nav")
    heading = child(navigation, "div", attributes={"class": "minimap-heading"})
    child(heading, "p", ui["reading_flow"], {"class": "minimap-title"})
    child(heading, "span", ui["zero_progress"], {"data-minimap-percent": ""})
    progress = child(navigation, "span", attributes={"class": "minimap-progress"})
    child(progress, "i", attributes={"data-minimap-progress": ""})
    listing = child(navigation, "ol")
    for section_index, section in enumerate(sections, start=1):
        item = child(listing, "li")
        attributes = {
            "href": f'#section-{section["id"]}',
            "data-minimap-link": section["id"],
            "data-section-title": section["title"],
        }
        if not section["default_open"]:
            attributes["class"] = "secondary"
        link = child(item, "a", attributes=attributes)
        child(link, "span", f"{section_index:02d}")
        append_text(link, section["title"])
    total_blocks = sum(len(section["blocks"]) for section in sections)
    child(
        navigation,
        "p",
        ui["minimap_meta"].format(len(sections), total_blocks),
        {"class": "minimap-meta"},
    )

    stylesheet = (ASSETS_DIR / "report.css").read_text(encoding="utf-8")
    syntax_script = (ASSETS_DIR / "vendor" / "prism.js").read_text(encoding="utf-8")
    behavior_script = (ASSETS_DIR / "report.js").read_text(encoding="utf-8")
    try:
        return render_document(
            title=report["title"],
            main=main,
            language=report.get("language", "ko"),
            assets=TrustedAssets(
                stylesheet=stylesheet,
                syntax_script=syntax_script,
                behavior_script=behavior_script,
            ),
        )
    except (OSError, UnicodeError, ValueError) as error:
        raise ReportError(f"could not render report: {error}") from error


def command_init(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser().resolve()
    if output.exists() and not args.force:
        raise ReportError(f"output already exists: {output}; pass --force to replace it")
    template = ASSETS_DIR / "report-template.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(template, output)
    print(output)
    return 0


def command_validate(args: argparse.Namespace) -> int:
    path = Path(args.input).expanduser().resolve()
    report = read_json(path)
    errors = validate_report(report)
    if errors:
        print("INVALID")
        for error in errors:
            print(f"- {error}")
        return 1
    block_count = sum(len(section["blocks"]) for section in report["sections"])
    print("VALID")
    print(f"sections={len(report['sections'])} blocks={block_count}")
    return 0


def command_compile(args: argparse.Namespace) -> int:
    input_path = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve() if args.output else input_path.with_suffix(".html")
    if paths_are_same(input_path, output):
        raise ReportError("compile input and output paths must be different")
    report = read_json(input_path)
    errors = validate_report(report)
    if errors:
        raise ReportError("report validation failed:\n" + "\n".join(f"- {error}" for error in errors))
    try:
        write_text_atomic(output, render_report(report))
    except OSError as error:
        raise ReportError(f"could not write HTML to {output}: {error}") from error
    print(output)
    return 0


def command_describe(_args: argparse.Namespace) -> int:
    print(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "commands": {
                    "init": "create a reusable report.json template",
                    "validate": "validate report structure, URLs, and code ranges",
                    "compile": "validate and render one standalone HTML document",
                },
                "block_types": sorted(BLOCK_KEYS),
                "inline_formatting": ["**strong**", "`inline code`", "[label](https://example.com)"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="write a reusable report JSON template")
    init.add_argument("--output", required=True, help="path for the new report.json")
    init.add_argument("--force", action="store_true", help="replace an existing output")
    init.set_defaults(handler=command_init)

    validate = subparsers.add_parser("validate", help="validate a report JSON file")
    validate.add_argument("--input", required=True, help="report JSON path")
    validate.set_defaults(handler=command_validate)

    compile_parser = subparsers.add_parser("compile", help="compile report JSON into static HTML")
    compile_parser.add_argument("--input", required=True, help="report JSON path")
    compile_parser.add_argument("--output", help="HTML output path; defaults beside the input")
    compile_parser.set_defaults(handler=command_compile)

    describe = subparsers.add_parser("describe", help="print the local command contract")
    describe.set_defaults(handler=command_describe)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except ReportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

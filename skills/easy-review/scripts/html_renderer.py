"""Small, dependency-free primitives for safe static HTML documents."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from typing import Mapping


Element = ElementTree.Element
SCRIPT_END_RE = re.compile(r"</script", re.IGNORECASE)


@dataclass(frozen=True)
class TrustedAssets:
    stylesheet: str
    syntax_script: str
    behavior_script: str


def child(
    parent: Element,
    tag: str,
    text: str | None = None,
    attributes: Mapping[str, str] | None = None,
) -> Element:
    node = ElementTree.SubElement(parent, tag, dict(attributes or {}))
    if text is not None:
        node.text = text
    return node


def append_text(parent: Element, text: str) -> None:
    if len(parent):
        last_child = parent[-1]
        last_child.tail = (last_child.tail or "") + text
    else:
        parent.text = (parent.text or "") + text


def render_document(*, title: str, main: Element, assets: TrustedAssets) -> str:
    for name, script in (
        ("syntax highlighter", assets.syntax_script),
        ("review behavior", assets.behavior_script),
    ):
        if SCRIPT_END_RE.search(script):
            raise ValueError(f"trusted {name} asset contains a closing script tag")

    root = Element("html", {"lang": "ko"})
    head = child(root, "head")
    child(head, "meta", attributes={"charset": "utf-8"})
    child(
        head,
        "meta",
        attributes={"name": "viewport", "content": "width=device-width, initial-scale=1"},
    )
    child(head, "title", title)
    child(head, "style", assets.stylesheet)
    body = child(root, "body")
    body.append(main)
    child(body, "script", "window.Prism = {manual: true};\n" + assets.syntax_script)
    child(body, "script", assets.behavior_script)
    return "<!doctype html>\n" + ElementTree.tostring(root, encoding="unicode", method="html")

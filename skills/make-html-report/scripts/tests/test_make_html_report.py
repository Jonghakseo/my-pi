from __future__ import annotations

import base64
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "make_html_report.py"
TEMPLATE = Path(__file__).resolve().parents[2] / "assets" / "report-template.json"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("make_html_report", SCRIPT)
assert SPEC and SPEC.loader
make_html_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(make_html_report)


def run(*arguments: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != expected:
        raise AssertionError(
            f"returncode={completed.returncode}, expected={expected}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed


def template_report() -> dict[str, object]:
    return json.loads(TEMPLATE.read_text(encoding="utf-8"))


CLEAN_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">'
    '<rect x="1" y="1" width="38" height="18" fill="#eef"/>'
    '<text x="4" y="13" font-size="8">flow</text>'
    "</svg>"
)


def svg_data_url(markup: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(markup.encode("utf-8")).decode("ascii")


def image_src_errors(src: str) -> list[str]:
    errors: list[str] = []
    make_html_report.validate_url(src, path="report.image.src", image=True, errors=errors)
    return errors


class MakeHtmlReportTests(unittest.TestCase):
    def test_template_validates_and_compiles_as_standalone_html(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report_path = root / "report.json"
            html_path = root / "custom.html"
            run("init", "--output", str(report_path))
            validation = run("validate", "--input", str(report_path))
            compile_result = run(
                "compile",
                "--input",
                str(report_path),
                "--output",
                str(html_path),
            )

            html = html_path.read_text(encoding="utf-8")
            self.assertIn("VALID", validation.stdout)
            self.assertIn(str(html_path.resolve()), compile_result.stdout)
            self.assertIn('<!doctype html>', html)
            self.assertIn('class="report-header"', html)
            self.assertIn('class="report-chapter"', html)
            self.assertIn('class="artifact code-artifact"', html)
            self.assertIn('class="minimap"', html)
            self.assertIn('data-action="toggle-theme"', html)
            self.assertIn('class="language-python"', html)
            self.assertIn(':root[data-theme="dark"]', html)
            self.assertIn('window.Prism = {manual: true};', html)
            self.assertNotIn("{{", html)

    def test_dynamic_text_is_escaped_and_limited_inline_markup_is_structured(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report = template_report()
            report["title"] = "<script>alert('x')</script>"
            report["sections"][0]["blocks"][0]["paragraphs"] = [
                "<img src=x onerror=alert(1)> **safe** `value` [docs](https://example.com?a=1&b=2)"
            ]
            report_path = root / "report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            run("compile", "--input", str(report_path))

            html = report_path.with_suffix(".html").read_text(encoding="utf-8")
            self.assertNotIn("<script>alert('x')</script>", html)
            self.assertIn("&lt;script&gt;alert('x')&lt;/script&gt;", html)
            self.assertNotIn("<img src=x", html)
            self.assertIn("&lt;img src=x onerror=alert(1)&gt;", html)
            self.assertIn("<strong>safe</strong>", html)
            self.assertIn('<code class="inline-code">value</code>', html)
            self.assertIn('href="https://example.com?a=1&amp;b=2"', html)

    def test_code_ranges_render_notes_focus_and_folds_with_original_line_numbers(self) -> None:
        report = template_report()
        html = make_html_report.render_report(report)

        self.assertIn('id="code-code-flow-1-L42" class="code-line focus"', html)
        self.assertIn("입력을 정규화한 뒤 유효하지 않으면", html)
        self.assertIn('class="code-fold"', html)
        self.assertIn("실행과 감사 기록", html)
        self.assertIn('id="code-code-flow-1-L48" class="code-line"', html)
        self.assertIn("return result", html)

    def test_validation_rejects_unsafe_urls_bad_ranges_and_unknown_fields(self) -> None:
        report = template_report()
        report["sections"][0]["blocks"][0]["paragraphs"] = ["[bad](javascript:alert(1))"]
        report["sections"][1]["blocks"][0]["highlights"] = [
            {"start": 40, "end": 44, "note": "outside"}
        ]
        report["sections"][2]["blocks"][3]["items"][0]["url"] = "file:///etc/passwd"
        report["unexpected"] = True

        errors = make_html_report.validate_report(report)
        joined = "\n".join(errors)
        self.assertIn("unknown fields: unexpected", joined)
        self.assertIn("unsupported URL scheme: javascript", joined)
        self.assertIn("must stay within code lines 41-48", joined)
        self.assertIn("unsupported URL scheme: file", joined)

    def test_code_is_literal_and_does_not_apply_rich_text_url_rules(self) -> None:
        report = template_report()
        code_block = report["sections"][1]["blocks"][0]
        code_block.update(
            {
                "start_line": 1,
                "code": 'const sample = "[payload](javascript:alert(1))";',
                "highlights": [],
                "collapsed_ranges": [],
            }
        )

        errors = make_html_report.validate_report(report)
        html = make_html_report.render_report(report)
        self.assertEqual(errors, [])
        self.assertIn("[payload](javascript:alert(1))", html)
        self.assertNotIn('href="javascript:alert(1)', html)

    def test_malformed_urls_and_enum_types_return_validation_errors_without_crashing(self) -> None:
        report = template_report()
        report["attention"][0]["tone"] = []
        report["sections"][0]["blocks"][0]["type"] = []
        report["sections"][2]["blocks"][3]["items"] = [
            {"label": "bad bracket", "url": "http://[", "note": "invalid"},
            {"label": "bad port", "url": "https://example.com:notaport/path", "note": "invalid"},
        ]
        report["verification"][0]["status"] = {}

        errors = make_html_report.validate_report(report)
        joined = "\n".join(errors)
        self.assertIn("tone must be action", joined)
        self.assertIn("type must be one of", joined)
        self.assertGreaterEqual(joined.count("is not a valid URL"), 2)
        self.assertIn("Port could not be cast to integer", joined)
        self.assertIn("status must be verified", joined)

    def test_english_language_localizes_visible_report_ui(self) -> None:
        report = template_report()
        report["language"] = "en-US"
        html = make_html_report.render_report(report)

        self.assertIn('<html lang="en-US">', html)
        self.assertIn(">At a glance<", html)
        self.assertIn(">Read first<", html)
        self.assertIn(">Expand all<", html)
        self.assertIn(">Theme: auto<", html)
        self.assertIn(">What was checked<", html)
        self.assertIn(">Reading flow<", html)
        self.assertIn(">2 blocks<", html)
        self.assertNotIn("decodeURIComponent", html)

    def test_compile_refuses_invalid_report_same_path_and_init_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report_path = root / "report.json"
            run("init", "--output", str(report_path))
            original = report_path.read_text(encoding="utf-8")
            second_init = run("init", "--output", str(report_path), expected=1)
            self.assertIn("already exists", second_init.stderr)
            self.assertEqual(report_path.read_text(encoding="utf-8"), original)

            same_path = run(
                "compile",
                "--input",
                str(report_path),
                "--output",
                str(report_path),
                expected=1,
            )
            self.assertIn("input and output paths must be different", same_path.stderr)
            self.assertEqual(report_path.read_text(encoding="utf-8"), original)

            report = json.loads(original)
            report["sections"][0]["blocks"][0]["type"] = "raw-html"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            compile_result = run("compile", "--input", str(report_path), expected=1)
            self.assertIn("report validation failed", compile_result.stderr)
            self.assertFalse(report_path.with_suffix(".html").exists())


    def test_sanitized_svg_data_url_is_embeddable_and_renders_in_a_single_file(self) -> None:
        report = template_report()
        report["sections"][0]["blocks"].append(
            {
                "type": "image",
                "src": svg_data_url(CLEAN_SVG),
                "alt": "flow 라벨이 있는 사각형 도식",
            }
        )

        self.assertEqual(make_html_report.validate_report(report), [])
        html = make_html_report.render_report(report)
        self.assertIn("data:image/svg+xml;base64,", html)
        self.assertEqual(image_src_errors(svg_data_url(CLEAN_SVG)), [])

    def test_unsafe_svg_data_urls_are_rejected_with_the_reason(self) -> None:
        cases = {
            CLEAN_SVG.replace("<rect", "<script>alert(1)</script><rect"): "<script>",
            CLEAN_SVG.replace("<rect", '<rect onload="alert(1)"'): "inline event handler",
            CLEAN_SVG.replace("<rect", "<foreignObject><b/></foreignObject><rect"): "<foreignObject>",
            CLEAN_SVG.replace("<rect", "<iframe/><rect"): "<iframe>",
            '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>': "DOCTYPE or ENTITY",
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>': "javascript: URL",
            (
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'xmlns:xlink="http://www.w3.org/1999/xlink">'
                '<use xlink:href="https://evil.test/x#a"/></svg>'
            ): "external resource",
            '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>': "not well-formed XML",
        }
        for markup, expected in cases.items():
            with self.subTest(expected=expected):
                errors = image_src_errors(svg_data_url(markup))
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(expected, errors[0])

        self.assertIn("not valid base64", image_src_errors("data:image/svg+xml;base64,!!!!")[0])

    def test_svg_validation_rejects_parsed_security_boundaries(self) -> None:
        cases = {
            (
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'xmlns:s="http://www.w3.org/2000/svg"><s:script/></svg>'
            ): "<script>",
            (
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'xmlns:svg="http://www.w3.org/2000/svg"><svg:foreignObject/></svg>'
            ): "<foreignObject>",
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(assets/p.svg#p)"/></svg>': "url() resource",
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(&#x68;ttps://evil.test/x)"/></svg>': "url() resource",
            "<root/>": "root element is not <svg>",
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html;base64,AAAA"/></svg>': "external resource",
        }
        for markup, expected in cases.items():
            with self.subTest(expected=expected):
                errors = image_src_errors(svg_data_url(markup))
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(expected, errors[0])

    def test_svg_validation_rejects_css_pi_smil_and_namespace_bypasses(self) -> None:
        cases = {
            (
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<style>.a{}<x/>.b{fill:url(https://evil.test/x)}</style></svg>'
            ): "url() resource",
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/x.css";</style></svg>': "unsafe CSS",
            '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:javascript:alert(1)}</style></svg>': "unsafe CSS",
            '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{width:expression(alert(1))}</style></svg>': "unsafe CSS",
            r'<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:\75rl(https://evil.test/x)}</style></svg>': "unsafe CSS",
            '<?xml-stylesheet href="https://evil.test/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>': "processing instruction",
            '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="https://evil.test/x.png"/></svg>': "animation element <set>",
            '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>': "animation element <animate>",
            '<x:svg xmlns:x="urn:not-svg"/>': "SVG namespace",
        }
        for markup, expected in cases.items():
            with self.subTest(expected=expected):
                errors = image_src_errors(svg_data_url(markup))
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(expected, errors[0])

    def test_svg_validation_preserves_safe_diagram_markup(self) -> None:
        cases = (
            '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>',
            '<svg xmlns="http://www.w3.org/2000/svg" data-href="https://example.com"/>',
            '<svg xmlns="http://www.w3.org/2000/svg"><text>href="https://example.com" javascript:</text></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><!-- <script> --><rect/></svg>',
            (
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>'
            ),
            (
                '<svg xmlns="http://www.w3.org/2000/svg" '
                'xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#id"/></svg>'
            ),
            (
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<defs><linearGradient id="gradient"/></defs>'
                '<style>.node { fill: url(#gradient); }</style></svg>'
            ),
        )
        for markup in cases:
            with self.subTest(markup=markup):
                self.assertEqual(image_src_errors(svg_data_url(markup)), [])

    def test_raster_and_relative_image_sources_still_validate(self) -> None:
        for src in (
            "data:image/png;base64,iVBORw0KGgo=",
            "data:image/jpeg;base64,AAAA",
            "data:image/gif;base64,AAAA",
            "data:image/webp;base64,AAAA",
            "assets/flow.svg",
            "https://example.com/flow.png",
        ):
            with self.subTest(src=src):
                self.assertEqual(image_src_errors(src), [])
        self.assertIn(
            "png, jpeg, gif, webp, or svg+xml",
            image_src_errors("data:image/bmp;base64,AAAA")[0],
        )


if __name__ == "__main__":
    unittest.main()

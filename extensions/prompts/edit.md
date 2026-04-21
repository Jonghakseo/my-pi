Apply precise file edits using `LINE#HASH` anchors from `read` output.

Preferred shape: use one `edit` call per file. For insertion-only changes, prefer `append`/`prepend`; when existing lines must change, express replacements as a block range plus a single `content` string.

```json
{
  "path": "src/main.ts",
  "returnMode": "changed",
  "edits": [
    {
      "op": "replace",
      "range": { "start": "12#MQ", "end": "14#VR" },
      "content": "const x = 1;\nconst y = 2;"
    }
  ]
}
```

Operations:
- `replace` — replace `range.start` through optional `range.end` with `content` (`string` or `null`). Use this when you are actually rewriting or removing those existing lines.
- `append` — insert `content` after `pos`. Omit `pos` to append at EOF.
- `prepend` — insert `content` before `pos`. Omit `pos` to prepend at BOF.
- `replace_text` — exact unique text replacement with `oldText` and `newText`. Use only when anchored edits are not practical.
- Legacy `pos`/`end` + `lines` is still supported, but prefer `range` + `content`.

Rules:
- Copy anchors exactly from `read`. Never invent or reconstruct them.
- `content` must be literal file content. Do not include `LINE#HASH:` prefixes or diff markers.
- For `replace`, include only the new content for the targeted range. Do not repeat the line before or after the range.
- If a change only inserts content next to existing lines, use `append`/`prepend` instead of `replace`.
- If the new content would start or end with the same line that survives immediately outside the target range, the range is too narrow. Expand it or switch to `append`/`prepend`. Pay special attention to delimiter-only lines like `}`, `]`, `)`, `};`, `});`.
- All edits in one call target the same pre-edit file state.
- Do not emit overlapping or adjacent edits; merge them into one change.
- Keep each edit as small as possible while still unique and correct, but not so small that boundary lines are duplicated.
- If `replace_text` matches zero or multiple times, re-read and use anchors instead.

Examples:
```json
{ "op": "replace", "range": { "start": "12#MQ" }, "content": "const x = 1;" }
{ "op": "replace", "range": { "start": "12#MQ", "end": "14#VR" }, "content": "line a\nline b" }
{ "op": "replace", "range": { "start": "12#MQ", "end": "14#VR" }, "content": null }
{ "op": "append", "pos": "50#NK", "content": "\n## New Section" }
{ "op": "prepend", "content": "// header\n" }
{ "op": "replace_text", "oldText": "before", "newText": "after" }
```

Return modes:
- `changed` (default) — returns diff preview and updated anchors around the changed region.
- `ranges` — requires `returnRanges` and returns requested post-edit hashline windows in `details.returnedRanges`.

Errors:
- Stale anchor: the file changed since `read`; retry using the `>>> LINE#HASH` lines from the error.
- No-op: unchanged edits return `classification: "noop"`.

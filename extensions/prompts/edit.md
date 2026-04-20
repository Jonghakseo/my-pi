Apply edits to a file using `LINE#HASH` anchors from `read` output.

<usage>
Submit one `edit` call per file. Include all operations for that file in a single call.

Use `read` first if you do not have current `LINE#HASH` references for the target file.
</usage>

<payload>
```json
{
{
  "path": "src/main.ts",
  "snapshotId": "v1|/abs/path|...",
  "returnMode": "changed",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["..."] }
  ]
}
```

- `path` — target file path.
- `snapshotId` — optional fingerprint returned by `read`; when provided, `edit` rejects stale file state before applying changes and returns refresh anchors around the requested edit.
- `returnMode` — optional response mode. `changed` (default) returns diff + updated anchors; `full` returns a compact structure outline in `content` and the returned hashline block in `details.fullContent`; `ranges` returns a compact structure outline in `content` and the requested post-edit windows in `details.returnedRanges`.
- `returnRanges` — required when `returnMode="ranges"`. Array of `{ "start": number, "end"?: number }` post-edit line windows to return.
- `edits` — array of edit operations.
</payload>

<operations>
Each entry has an `op`.

- `replace` — replaces the line at `pos`, or all lines from `pos` through `end` inclusive, with the contents of `lines`. `pos` is required; `end` is optional.
- `append` — inserts `lines` after `pos`. Omit `pos` to insert at end of file.
- `prepend` — inserts `lines` before `pos`. Omit `pos` to insert at start of file.
- `replace_text` — replaces one exact unique `oldText` match with `newText`. Use this when you do not have anchors yet, or for exact string substitutions that can safely coexist with anchored edits in the same request.

`end` is only valid with `replace`.

Anchor format: `"LINE#HASH"` copied exactly from `read` output (e.g. `"12#MQ"`).
</operations>

<examples>

Replace one line:

```json
{ "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
```

Replace a range — `lines` is the complete new content for that range, not including the surrounding lines:

```json
{ "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": ["line a", "line b"] }
```

Delete lines:

```json
{ "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": [] }
```

Insert after a line:

```json
{ "op": "append", "pos": "50#NK", "lines": ["", "## New Section"] }
```

Exact unique text replacement:

```json
{ "op": "replace_text", "oldText": "before", "newText": "after" }
```

Mixed edits in one call — all anchors refer to the same pre-edit snapshot, and `replace_text` matches against that same snapshot:

```json
{
  "path": "README.md",
  "edits": [
    { "op": "replace",      "pos": "33#YW", "lines": ["updated line"] },
    { "op": "replace_text", "oldText": "draft title", "newText": "final title" },
    { "op": "append",       "pos": "50#NK", "lines": ["", "## New Section"] },
    { "op": "prepend",                      "lines": ["// header"] }
  ]
}
```

Return only selected post-edit ranges:

```json
{
  "path": "src/main.ts",
  "returnMode": "ranges",
  "returnRanges": [
    { "start": 1, "end": 20 },
    { "start": 80, "end": 90 }
  ],
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
  ]
}
```
</examples>

<constraints>
- Copy `LINE#HASH` anchors exactly from `read` output — do not guess or construct them.
- Copy indentation exactly from `read` output.
- `lines` must be literal file content. Do not include `LINE#HASH:` prefixes or diff markers.
- `replace_text` is exact-only: it must match exactly once in the current file. If it matches zero or multiple times, re-read and use anchors instead.
- Do not echo the line immediately before or after the replaced range into `lines` — include only the new content for the targeted lines.
- Each edit in a call targets anchors from the same pre-edit snapshot. Do not use anchors from the result of one edit as input to another edit in the same call.
- Pass `snapshotId` from the latest `read` when available. If it is stale, re-read before retrying.
- Do not emit overlapping or adjacent edits — merge nearby changes into a single entry.
- Keep each edit as small as possible; do not pad with large unchanged regions.
- Submitting content identical to the current file is rejected.
</constraints>

<after-edit>
A successful edit returns:
- `Diff preview` — in `returnMode="changed"`, changed lines with `+`/`-` markers.
- `Structure outline` — in `returnMode="full"` and `returnMode="ranges"`, `content` contains a compact regex-level outline of the returned content.
- `details.fullContent` — in `returnMode="full"`, the post-edit hashline block plus optional `nextOffset` for continuation.
- `details.returnedRanges` — in `returnMode="ranges"`, the requested post-edit hashline windows.
- `SnapshotId` — the fresh post-edit fingerprint for subsequent edits on the same file.
- `Updated anchors` — fresh `LINE#HASH` references for the changed region, usable in the next call without re-reading. For edits outside that region, use `read` first.
</after-edit>

<errors>
- **Stale anchor**: the file has changed since your last `read`. The error shows the current content with `>>>` marking the lines you need. Copy those `>>> LINE#HASH` values and retry. For a range replace, update both `pos` and `end`.
- **Stale snapshotId**: the file changed since your last `read`. Re-run `read` and retry with the latest `snapshotId`. The error also includes `Refresh anchors:` with a broader current hashline window around the requested edit when possible.
- **Identical content**: unchanged edits return `classification: "noop"` instead of throwing. Re-read only if you expected a real change.
</errors>
</errors>

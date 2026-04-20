Read a file and return its contents with line-level hash anchors.

Each line is prefixed as `LINE#HASH:content`. Use these anchors when calling `edit`.

> The response also includes a `snapshotId` footer and `details.snapshotId`. Pass that `snapshotId` back to `edit` to confirm the file has not changed since this read.

Empty files return an advisory message. Images (JPEG, PNG, GIF, WebP) are returned as attachments. Binary files and directories are rejected.

Supported parameters:
- `path` — file path (relative or absolute).
- `offset` — start reading from this line number (1-indexed, optional).
- `limit` — maximum number of lines to return (optional).

Default limit: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}.

When the first selected line exceeds the byte budget, the tool returns an advisory instead of a partial line, because partial lines produce unusable hash anchors.

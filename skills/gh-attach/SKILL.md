---
name: gh-attach
description: "gh attach/gh-attach로 로컬 파일·이미지를 GitHub user-attachments에 업로드하고 첨부 URL을 얻을 때 사용한다."
compatibility: Requires GitHub CLI gh, the sudosubin/gh-attach extension, gh auth login, and a GitHub browser session/cookies for uploads.
---

# gh-attach

Use the `sudosubin/gh-attach` GitHub CLI extension to upload a local file to GitHub user-attachments and return an attachment URL.

Official references:

- gh-attach README: https://github.com/sudosubin/gh-attach
- Pi skills documentation: https://agentskills.io/specification and local Pi `docs/skills.md`

## Core principles

- Only upload files the user explicitly asked to attach, or files that are clearly required for the current requested GitHub/PR/report task.
- Never upload secrets, credentials, private keys, database dumps, logs with tokens, or files whose contents are unknown and potentially sensitive.
- Prefer the GitHub CLI extension command `gh attach` over custom upload code.
- Keep output easy to paste: return the final `https://github.com/user-attachments/assets/...` URL, or markdown image syntax when the user asks for PR/comment-ready text.
- If the target repository is ambiguous and the current directory is not the intended repo, ask for `OWNER/REPO` before uploading.

## Workflow

### 1. Check installation and authentication

Run:

```bash
gh --version
gh extension list | rg '^gh attach\s' || gh extension install sudosubin/gh-attach
gh auth status
```

If `gh` is missing, tell the user GitHub CLI is required before using this skill. If auth is missing, ask the user to run `gh auth login` or confirm that you should start it interactively.

### 2. Confirm the file and repository

- Verify the file exists and is the intended attachment.
- For images, `file <path>` or `ls -lh <path>` is usually enough.
- Use `-R OWNER/REPO` when the target repo is not certainly the current git remote.
- If the user gave a GitHub PR/issue/repo URL, derive `OWNER/REPO` from it.

### 3. Upload

Basic command:

```bash
gh attach ./image.png -R owner/repo
```

From inside the intended repository, repo auto-detection is allowed:

```bash
gh attach ./image.png
```

For structured output:

```bash
gh attach ./image.png -R owner/repo --json href,name
```

For markdown-ready output:

```bash
gh attach ./image.png -R owner/repo --json href,name --template '![{{.name}}]({{.href}})'
```

### 4. Browser cookie options when upload fails

`gh-attach` uses the current GitHub login from `gh` and browser cookies matching that GitHub account. If upload fails because it cannot find cookies or the wrong account/session is selected, retry with explicit browser/profile options:

```bash
gh attach ./image.png -R owner/repo --browser chrome --profile Default
```

Supported browser values include `auto`, `arc`, `brave`, `chrome`, `chromium`, `edge`, `firefox`, `safari`, `vivaldi`, `whale`, and others listed by `gh attach --help`.

For repeated use, create or update the config file at `~/.config/gh/attach.yml`:

```yaml
browsers:
  - browser: chrome
    profile: Default
  - browser: safari
```

### 5. Return result

- If the command prints a URL, return that URL directly.
- If the user asked to embed in GitHub Markdown, return `![alt](url)`.
- If the user asked to add it to a PR/issue/comment, use the relevant GitHub command only after the upload succeeds.

## Troubleshooting

- `unknown command attach`: install with `gh extension install sudosubin/gh-attach`.
- `not logged in`: run `gh auth login`.
- Repository detection failure: add `-R owner/repo`.
- Cookie/session mismatch: pass `--browser` and `--profile`, or ensure the browser is logged into the same GitHub account as `gh auth status`.
- Need verbose diagnostics: add `-v`.

## Safety checklist

Before upload:

- The user explicitly requested this attachment or it is directly required by the requested GitHub task.
- The file path is correct and the file exists.
- The file is safe to upload publicly or to the target GitHub context.
- The target repository is correct.

## Test prompts

Use these prompts to verify the skill triggers and guides the agent correctly:

- `gh attach로 이 스크린샷 GitHub URL 만들어줘: /tmp/a.png -R my-org/my-repo`
- `gh attatch 사용법 알려줘`
- `PR에 넣을 이미지 첨부 URL 만들어줘`
- `gh-attach가 쿠키를 못 찾는다고 하는데 해결해줘`

Near-miss prompts that should not automatically upload anything:

- `GitHub Actions artifact 다운로드해줘`
- `이미지를 S3에 업로드해줘`
- `이 로그 파일을 어디든 올려줘` without a clear GitHub attachment request and safety confirmation.

## Validation

After creating or editing this skill, run:

```bash
python3 ~/.pi/agent/skills/skill-creator/scripts/validate_skill.py ~/.pi/agent/skills/gh-attach
```

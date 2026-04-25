# Pi Skill Checklist

Use this checklist when reviewing a new or modified Pi skill.

## Required structure

- [ ] Skill is a directory containing `SKILL.md`.
- [ ] `SKILL.md` starts with YAML frontmatter delimited by `---`.
- [ ] `name` exists, is lowercase alphanumeric with single hyphens, and matches the parent directory.
- [ ] `description` exists, is non-empty, and is under 1024 characters.
- [ ] Optional `compatibility` is under 500 characters if present.

## Pi loading behavior

- [ ] Location is appropriate:
  - global: `~/.pi/agent/skills/`
  - project: `.pi/skills/` or `.agents/skills/`
  - package/settings/CLI path when sharing or testing
- [ ] User knows to run `/reload` or start a new Pi session after adding a global skill.
- [ ] If testing in isolation, use `pi --no-skills --skill /path/to/skill -p "..."`.

## Trigger quality

- [ ] `description` says both what the skill does and when to use it.
- [ ] Includes realistic user phrases and domain keywords.
- [ ] Avoids over-broad trigger wording that would steal unrelated tasks.
- [ ] Near-miss cases are documented in the body if needed.

## Progressive disclosure

- [ ] `SKILL.md` is concise enough to read on activation.
- [ ] Long references are in `references/`.
- [ ] Deterministic/repeated work is in `scripts/`.
- [ ] Templates/examples are in `assets/`.
- [ ] Relative file references are clear and rooted at the skill directory.

## Safety and maintainability

- [ ] No hidden destructive commands.
- [ ] No credential exfiltration, unauthorized access, or malware-like behavior.
- [ ] Tool usage guidance matches the Pi harness, not another product's assumptions.
- [ ] Final output format and validation steps are explicit.

## Evaluation

- [ ] At least 2 realistic test prompts exist when the workflow is non-trivial.
- [ ] Objective tasks have assertions or command-based checks.
- [ ] Subjective tasks rely on human review rather than fake precision.
- [ ] Findings are generalized into the skill, not overfit to one prompt.

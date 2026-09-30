---
name: handoff
description: "현재 대화를 다른 에이전트가 이어받도록 인계 문서로 정리할 때 사용한다."
argument-hint: "What will the next session be used for?"
disable-model-invocation: false
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

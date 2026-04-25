---
name: skill-creator
description: Pi용 스킬을 새로 만들거나 기존 스킬을 개선·검증·평가할 때 사용한다. 사용자가 "스킬 만들어줘", "SKILL.md 작성", "이 워크플로우를 skill로", "스킬 설명/트리거 최적화", "기존 skill 수정", "eval로 스킬 테스트"처럼 말하면 반드시 이 스킬을 사용한다. Agent Skills 표준과 Pi의 스킬 로딩/검증 규칙에 맞춰 스킬 구조, 프론트매터, progressive disclosure, 평가 루프를 설계한다.
argument-hint: "만들 스킬의 목적 또는 수정할 스킬 경로"
disable-model-invocation: false
---

# skill-creator

Pi 환경에서 Agent Skills 표준을 따르는 스킬을 만들고, 작게 검증하고, 피드백으로 반복 개선한다. Anthropic의 skill-creator에서 가져온 핵심 루프(의도 파악 → 초안 → 테스트 프롬프트 → 평가 → 개선)를 Pi 도구와 로컬 스킬 구조에 맞게 적용한다.

## 핵심 원칙

- **Pi 우선**: Claude Code 전용 명령, `claude -p`, Anthropic eval viewer 스크립트를 전제로 하지 않는다. Pi CLI, `read`/`write`/`edit`/`bash`, 필요 시 `subagent`, `ask_user_question`, `todo_write`를 사용한다.
- **표준 준수**: `SKILL.md`는 Agent Skills 표준의 YAML frontmatter + Markdown 본문 구조를 지킨다.
- **Progressive disclosure**: 항상 들어가는 `description`은 정확하고 트리거 친화적으로, 본문은 500줄 미만을 목표로, 긴 자료는 `references/`, 반복 가능한 작업은 `scripts/`, 템플릿은 `assets/`에 둔다.
- **검증 가능한 산출물**: 새 스킬에는 최소한 자체 검증 체크리스트와 현실적인 테스트 프롬프트를 남긴다. 객관 검증이 가능한 스킬이면 `evals/evals.json`도 만든다.
- **놀라움 금지**: 사용자가 기대하지 않은 권한 상승, 데이터 유출, 위험한 자동화, 악성 행위 보조 스킬은 만들지 않는다.

## 언제 어떤 작업을 하나

```
사용자가 스킬을 만들고 싶다
  ├─ 의도/트리거/출력 형식이 충분히 명확함 → 초안 작성
  ├─ 일부만 명확함 → 대화 기록에서 추출 후 빈칸만 질문
  └─ 모호함 → ask_user_question으로 목적, 트리거, 산출물, 평가 필요 여부를 한 번에 확인

사용자가 기존 스킬을 고치고 싶다
  ├─ 경로 제공됨 → 해당 SKILL.md와 주변 resources 읽기
  └─ 경로 없음 → 후보 검색 후 확인

사용자가 스킬 성능/트리거를 개선하고 싶다
  ├─ 현재 description 분석
  ├─ should-trigger / should-not-trigger 쿼리 작성
  └─ 필요하면 Pi CLI 또는 subagent로 소규모 eval 실행
```

## Workflow

### 1. 컨텍스트 수집

1. 관련 공식 문서를 확인한다.
   - Pi 스킬 문서: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/skills.md`
   - 필요 시 Pi README의 CLI 옵션: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
   - Agent Skills 표준: `https://agentskills.io/specification`
2. 기존 스킬 패턴이 필요하면 `~/.pi/agent/skills/` 또는 프로젝트의 `.pi/skills/`, `.agents/skills/`를 살펴본다.
3. 사용자의 현재 대화에서 다음을 먼저 추출한다.
   - 스킬이 가능하게 해야 하는 일
   - 트리거되어야 하는 표현/상황
   - 기대 산출물 형식
   - 필요한 도구/의존성/권한
   - 테스트 또는 eval이 필요한지
4. 빈칸이 많으면 `ask_user_question`으로 한 번에 묻는다. 단, 이미 충분히 명확하면 묻지 말고 진행한다.

### 2. 위치와 이름 결정

기본 선택:

- 개인/전역 워크플로우: `~/.pi/agent/skills/<skill-name>/SKILL.md`
- 특정 레포 전용: `<repo>/.pi/skills/<skill-name>/SKILL.md`
- 다른 Agent Skills 클라이언트와 공유 목적: `.agents/skills/<skill-name>/SKILL.md`도 고려

이름 규칙:

- 디렉터리명과 `name` frontmatter는 반드시 동일하게 한다.
- 1~64자, 소문자 영문/숫자/하이픈만 사용한다.
- 앞뒤 하이픈, 연속 하이픈은 금지한다.
- 예: `ship`, `systematic-debugging`, `airtable-reporting`

### 3. 설계 초안

복잡한 스킬이면 작성 전에 짧게 설계를 보여준다.

```markdown
스킬 설계안:
- 이름/위치: ...
- 트리거: ...
- 핵심 workflow: ...
- resources: scripts/... references/... assets/...
- 검증 방법: ...
```

간단한 스킬이면 설계 문단을 내부 체크리스트로 처리하고 바로 초안을 작성해도 된다.

### 4. SKILL.md 작성 패턴

프론트매터:

```yaml
---
name: my-skill
description: 무엇을 하고 언제 사용해야 하는지 구체적으로 쓴다. 사용자의 실제 표현과 관련 키워드를 포함한다.
argument-hint: "선택: /skill:my-skill 뒤에 올 인자 예시"
disable-model-invocation: false
---
```

본문 권장 구조:

```markdown
# my-skill

한 문단 요약.

## 핵심 원칙
- 왜 이 절차가 중요한지 설명한다.

## Workflow
### 1. ...
### 2. ...

## Tool guidance
- 어떤 상황에서 어떤 Pi 도구를 쓸지 적는다.

## Output format
사용자가 기대하는 최종 응답/파일 형식을 명시한다.

## Validation
완료 전에 확인할 명령과 체크리스트를 적는다.

## Edge cases
흔한 실패/예외와 대응을 적는다.
```

작성 팁:

- `description`에는 "무엇"과 "언제"를 모두 넣는다. 자동 트리거는 이 필드에 크게 의존한다.
- 모델이 따라야 하는 행동은 명령형으로 쓰되, 무조건적인 MUST 남발보다 이유를 설명한다.
- 대형 레퍼런스는 본문에 붙이지 말고 `references/`로 분리한 뒤 언제 읽어야 하는지 명시한다.
- 반복적·결정적 검증은 `scripts/`로 옮겨 매번 재발명하지 않게 한다.
- 상대 경로는 스킬 루트 기준으로 쓴다. 예: `references/checklist.md`, `scripts/validate_skill.py`

### 5. Pi 친화적 평가 루프

사용자가 평가를 원하거나 객관 결과가 중요한 스킬이면 아래를 적용한다.

1. `evals/evals.json`을 만든다.
   - 시작은 2~3개 현실적인 프롬프트로 충분하다.
   - 파일 변환, 코드 생성, 데이터 추출처럼 객관 검증 가능한 항목에는 `assertions`를 추가한다.
   - 템플릿은 `assets/evals-template.json`을 참고한다.
2. 작업 공간을 스킬 디렉터리의 sibling으로 둔다.
   - 예: `~/.pi/agent/skills/<skill-name>-workspace/iteration-1/...`
3. 가능한 경우 Pi CLI로 with-skill / baseline을 비교한다.

```bash
# with skill
pi --no-skills --skill /path/to/skill -p "<eval prompt>"

# baseline
pi --no-skills -p "<same eval prompt>"
```

4. 장시간 실행, TUI, 로그 추적이 필요하면 `interactive_shell` 스킬/도구 지침을 따른다.
5. 독립 판단이 중요한 경우에만 `subagent`를 사용한다. subagent를 쓰면 먼저 `subagent help`로 인터페이스를 확인하고, 같은 eval의 with-skill/baseline을 가능하면 batch로 띄운다.
6. 결과는 숫자보다 사용자 피드백을 우선한다. 단, 반복되는 실패는 스킬 본문이 아니라 `scripts/`나 `references/`로 구조화할 수 있는지 본다.

### 6. Description/trigger 개선

트리거 정확도를 개선할 때:

1. 실제 사용자가 말할 법한 쿼리 10~20개를 만든다.
   - should-trigger: 5~10개
   - should-not-trigger: 5~10개
   - 너무 쉬운 negative보다 비슷하지만 다른 작업인 near-miss를 포함한다.
2. 각 쿼리에 대해 현재 description에서 어떤 키워드/상황이 부족한지 분석한다.
3. 새 description은 1024자 이하로 유지하고, 다음을 포함한다.
   - 스킬이 하는 일
   - 반드시 써야 하는 상황
   - 사용자의 자연어 표현/키워드
   - 쓰지 말아야 할 가까운 상황은 본문 edge case에 둔다.
4. 과적합하지 않는다. 특정 eval 문장을 그대로 나열하지 말고 일반화한다.

### 7. 검증

스킬 작성/수정 후 반드시 아래를 확인한다.

```bash
python3 /Users/creatrip/.pi/agent/skills/skill-creator/scripts/validate_skill.py /path/to/skill
```

추가 확인:

- `SKILL.md`가 존재한다.
- frontmatter `name`과 디렉터리명이 일치한다.
- `description`이 비어 있지 않고 1024자 이하이다.
- 본문이 너무 길면 `references/`로 분리한다.
- 스킬이 위험한 행동을 암묵적으로 지시하지 않는다.
- 최종 보고에 생성/수정 파일과 검증 결과를 포함한다.

## Output format

최종 응답은 짧게:

```markdown
완료했습니다.
- 생성/수정: `path/to/SKILL.md`, ...
- 검증: `python3 .../validate_skill.py ...` 통과
- 참고: Pi 스킬 문서 / Agent Skills 표준 기준 반영
```

사용자에게 다음 행동이 필요하면 한 줄로만 묻는다. 예: "트리거 eval까지 돌려볼까요?"

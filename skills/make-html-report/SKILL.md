---
name: make-html-report
description: 설명 자료, 코드 워크스루, 기술 조사, 설계안, 운영 가이드, 비교 분석처럼 여러 근거와 맥락을 Easy Review 계열의 읽기 좋은 단일 HTML 문서로 만든다. 사용자가 "HTML 리포트로 만들어줘", "설명 자료를 문서로 정리", "코드와 맥락을 엮어 보여줘", "읽기 좋은 보고서 생성"처럼 요청할 때 사용한다.
compatibility: Python 3.10+와 최신 브라우저가 필요하며 렌더링 자체는 외부 패키지나 네트워크를 사용하지 않는다.
---

# make-html-report

자료와 코드를 독자의 질문 순서로 재구성해, Easy Review와 같은 편집 디자인의 재사용 가능한 정적 HTML 리포트로 만든다. 특정 저장소, Git diff, 문서 종류에 의존하지 않는다.

## 핵심 원칙

- 원자료의 나열이 아니라 **결과 → 핵심 흐름 → 경계 → 검증** 순서의 읽기 문서를 만든다.
- 코드는 다시 작성하지 않고 확인한 원문을 정확히 인용한다.
- 사실, 해석, 제안, 미확인 사항을 구분한다.
- 일부 자료를 읽지 못했다면 범위와 누락 자료를 명시한다.
- 임의 HTML을 생성하거나 JSON에 넣지 않는다. 구조화된 블록만 사용해 동적 텍스트와 attribute를 serializer가 이스케이프하게 한다.
- 렌더러는 외부 LLM API, 제공자 API 키, CDN을 사용하지 않는다.
- 공식 문서나 원자료가 있는 주장은 가능하면 `links` 블록으로 출처를 남긴다.

## Workflow

### 1. 대상과 산출물 경로를 정한다

사용자 요청에서 다음을 추출한다.

- 독자와 목적
- 읽고 나서 가능해야 하는 판단 또는 행동
- 사용할 자료: 로컬 파일, 코드, URL, 대화 내용, 조사 결과
- 전체/일부 범위와 기준 시점
- 원하는 HTML 경로

이미 충분히 명확하면 묻지 않는다. 대상이나 독자에 따라 결론이 달라질 때만 `ask_user_question`으로 빈칸을 한 번에 확인한다.

`SKILL_DIR`을 이 파일이 있는 디렉터리로 정한다. 출력 경로가 없으면 현재 작업 공간의 `.pi/reports/<short-slug>/report.json`을 사용한다. 소스 파일은 수정하지 않는다.

### 2. 자료를 읽고 읽는 순서를 설계한다

[references/content-design.md](references/content-design.md)를 완전히 읽는다.

- 관련 자료를 먼저 모두 읽은 뒤 section 순서를 정한다.
- 저장소 코드가 포함되면 정의, 호출자, 경계, 대표 테스트를 필요한 만큼 확인한다.
- 웹 자료는 제목만 보고 단정하지 말고 본문을 확인한다.
- 공식 문서가 존재하는 기술 주장은 공식 문서를 우선한다.
- 큰 범위에서 일부만 확인했으면 완료 상태를 과장하지 않는다.

### 3. 리포트 JSON을 만든다

```bash
python3 "$SKILL_DIR/scripts/make_html_report.py" init --output <report.json>
```

[references/report-schema.md](references/report-schema.md)를 읽고 템플릿을 실제 내용으로 교체한다.

- `overview`는 상세 내용 전에 알아야 할 결과 1~5개다.
- `sections` 배열이 실제 읽는 순서다. 자료 수집 순서나 파일 경로 순서를 그대로 쓰지 않는다.
- 핵심 흐름은 `default_open: true`, 부록과 보조 자료는 대개 `false`로 둔다.
- 설명과 직접 연결되는 코드만 `code` 블록에 정확히 인용한다.
- 코드의 `highlights`에는 줄 범위와 그 줄이 조건·동작·결과에 어떻게 연결되는지 적는다.
- `attention`과 `verification`은 실제 근거가 있는 항목만 담고, 없으면 빈 배열로 둔다.
- 이미지는 자립성을 의식적으로 선택한다. 상대 경로는 생성될 HTML 위치를 기준으로 쓰되, HTML만 옮기면 이미지가 전부 깨진다. 단독으로 열려야 하면 base64 data URI로 내장한다. 벡터 도식은 PNG로 강등하지 말고 위생 처리된 `image/svg+xml` data URI를 쓴다.
- 모든 이미지에 `alt`를 넣는다. 도식의 `alt`는 핵심 라벨과 흐름 방향을 담아, 이미지를 보지 못해도 같은 정보를 얻게 쓴다. `caption`은 출처와 맥락만 짧게 남긴다.
- 허용된 제한적 inline 표기는 `**강조**`, `` `inline code` ``, `[라벨](URL)`뿐이다.

### 4. 검증하고 렌더링한다

```bash
python3 "$SKILL_DIR/scripts/make_html_report.py" validate --input <report.json>
python3 "$SKILL_DIR/scripts/make_html_report.py" compile --input <report.json> --output <report.html>
```

validation 오류가 있으면 필드명, URL scheme, 코드 줄 범위, 중복 section ID를 바로잡는다. 오류를 없애려고 사실의 신뢰 수준이나 검토 범위를 과장하지 않는다.

`validate`와 `compile`은 시각적 정확성을 검사하지 않는다. `image` 블록이 있으면 컴파일된 HTML을 헤드리스 브라우저로 PNG 캡처한 뒤, 그 PNG를 `read`로 열어 라벨 겹침, 그룹 경계, 화살표 방향을 눈으로 확인한다(기준은 [references/content-design.md](references/content-design.md)의 도식 항목). 캡처 전 `전체 펼치기`로 모든 `<details>`를 열고 lazy image가 로드된 뒤, 전체 페이지 높이를 포함해 캡처한다.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --screenshot=<out.png> --window-size=<W>,<full-page-height> --force-device-scale-factor=2 file://<abs.html>
```

생성한 `<out.png>`를 `read`로 열어 확인한다.

렌더러는 다음을 제공한다.

- 단일 정적 HTML
- 라이트/다크/시스템 테마
- section 전체 펼치기/접기
- sticky 읽기 미니맵과 진행률
- 코드 줄 번호, 구문 강조, 줄 해설, 부분 접기
- 설명, 목록, 단계, 표, 콜아웃, 인용, 이미지, 링크 블록
- 반응형 모바일 레이아웃

### 5. 결과를 전달한다

`report.html`의 절대 경로 링크를 준다. 자동으로 브라우저를 열지 않는다. 사용자가 열어 달라고 요청한 경우에만 실제로 연다.

최종 답변에는 다음만 간결하게 적는다.

- 대상과 전체/일부 범위
- 실제로 먼저 볼 점
- 수행한 대상 검증
- 생성한 HTML 링크

문제를 찾지 못했다는 사실을 승인이나 안전 보장으로 표현하지 않는다.

## Tool guidance

- 텍스트와 이미지는 `read`로 확인한다.
- 저장소 탐색과 대상 검증에는 `bash`를 사용한다.
- 기존 JSON의 작은 수정은 `edit`, 새 JSON 작성이나 전체 교체는 `write`를 사용한다.
- 긴 조사나 구현 분석이 필요하면 `todo_write`로 진행 상황을 관리한다.
- 이 스킬의 렌더링 스크립트는 네트워크를 사용하지 않지만, 리포트 작성을 위한 조사에는 사용자가 허용한 일반 도구를 사용할 수 있다.

## Validation

스킬 자체를 수정했을 때:

```bash
python3 ~/.pi/agent/skills/skill-creator/scripts/validate_skill.py "$SKILL_DIR"
python3 -m unittest discover -s "$SKILL_DIR/scripts/tests" -p 'test_*.py'
```

현실적인 테스트 프롬프트:

1. `이 인증 흐름을 코드와 공식 문서를 엮어서 HTML 리포트로 만들어줘.`
2. `두 아키텍처 선택지를 비교하고 권장안을 읽기 좋은 보고서로 생성해줘.`
3. `이 장애 타임라인과 관련 코드를 운영 가이드 형태의 HTML로 정리해줘.`

완료 체크:

- 독자가 원자료 관계를 다시 조립하지 않아도 되는가?
- 모든 인용 코드가 원문과 일치하는가?
- 확인하지 않은 사실을 확인한 것처럼 쓰지 않았는가?
- 공식 문서와 원자료 링크가 필요한 주장에 연결됐는가?
- `validate`와 `compile`이 모두 성공했는가?
- 도식을 렌더해서 눈으로 확인했고, 도식이 본문과 같은 사실을 말하는가?
- HTML이 외부 자산 없이 단독으로 열리는가, 아니면 함께 옮겨야 할 자산을 사용자에게 알렸는가?
- HTML에 임의 템플릿 placeholder가 남지 않았는가?

## Edge cases

- 빠른 텍스트 답변만 원하면 이 스킬을 사용하지 않는다.
- 슬라이드, 대시보드, 인터랙티브 앱이 주 산출물이면 해당 전용 도구나 스킬을 우선한다.
- 실행 가능한 코드 예제가 원문이 아니라 설명을 위한 새 예제라면 `caption`에서 명시한다.
- URL이나 이미지가 인증 뒤에 있으면 HTML에서 보이지 않을 수 있으므로 캡처 시점과 접근 조건을 `notes`에 남긴다.
- Prism이 모르는 언어도 코드는 보존되지만 구문 강조는 제한될 수 있다.

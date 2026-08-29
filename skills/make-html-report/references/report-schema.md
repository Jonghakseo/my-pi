# report.json 계약

`schema_version` 1의 JSON 객체를 입력으로 사용한다. 임의 HTML은 지원하지 않는다. 일반 텍스트에서 제한적으로 `**강조**`, `` `inline code` ``, `[label](URL)`만 사용할 수 있다.

완전한 예시는 `assets/report-template.json`에 있다. 새 리포트는 직접 복사하지 말고 `init` 명령으로 만든다.

## 최상위 필드

| 필드 | 형식 | 규칙 |
|---|---|---|
| `schema_version` | number | 현재 `1` |
| `language` | string | 한국어·영어 UI를 위한 `ko`, `ko-KR`, `en`, `en-US` 계열 언어 태그 |
| `kicker` | string | 제목 위 짧은 문서 유형 |
| `title` | string | 결과 중심 제목 |
| `summary` | string | 목적과 최종 결과 한 문단 |
| `metadata` | array | `{label, value}` 최대 6개 |
| `overview` | string[] | 핵심 결과 1~5개 |
| `attention` | array | 먼저 판단할 항목, 없으면 `[]` |
| `sections` | array | 실제 읽는 순서, 최소 1개 |
| `verification` | array | 대상에 대해 실제 확인한 검증 |
| `notes` | string[] | 범위, 기준 시점, 누락 자료 |

## attention

```json
{
  "tone": "action | caution | question | info",
  "title": "짧은 제목",
  "body": "조건과 영향을 설명하는 문장"
}
```

## section

```json
{
  "id": "lowercase-kebab-case",
  "title": "독자의 질문",
  "summary": "입력 → 판단 → 결과",
  "default_open": true,
  "blocks": []
}
```

section `id`는 문서 안에서 유일해야 한다.

## 블록

### prose

```json
{
  "type": "prose",
  "heading": "선택 제목",
  "paragraphs": ["문단 1", "문단 2"]
}
```

### bullets

문자열과 `{title, body}`를 섞을 수 있다.

```json
{
  "type": "bullets",
  "heading": "선택 제목",
  "items": [
    "짧은 항목",
    {"title": "기준", "body": "상세 설명"}
  ]
}
```

### steps

```json
{
  "type": "steps",
  "heading": "선택 제목",
  "items": [
    {"title": "첫 단계", "body": "무엇을 왜 하는지"}
  ]
}
```

### code

`start_line`은 인용문의 실제 첫 줄 번호다. `highlights`와 `collapsed_ranges`의 줄 번호도 이 값을 기준으로 하며 서로 겹칠 수 없다. 각 배열 안의 범위끼리도 겹칠 수 없다.

```json
{
  "type": "code",
  "title": "코드 묶음 제목",
  "path": "src/file.ts",
  "caption": "이 코드가 필요한 이유",
  "language": "typescript",
  "start_line": 120,
  "code": "const value = read();\nreturn value;",
  "highlights": [
    {"start": 120, "end": 121, "note": "조건 → 동작 → 결과 해설"}
  ],
  "collapsed_ranges": [
    {"start": 130, "end": 140, "reason": "반복되는 준비 코드"}
  ]
}
```

Prism 번들에 없는 언어를 지정해도 코드는 보존되지만 구문 강조가 제한될 수 있다. 언어를 모르면 `language`를 생략한다.

### table

각 row의 cell 수는 `columns` 수와 같아야 한다.

```json
{
  "type": "table",
  "heading": "비교 제목",
  "caption": "선택 설명",
  "columns": ["기준", "A", "B"],
  "rows": [["비용", "낮음", "높음"]]
}
```

### callout

```json
{
  "type": "callout",
  "tone": "info | success | warning | danger",
  "title": "중요한 결론",
  "body": "본문 흐름 안에서 강조할 설명"
}
```

### quote

```json
{
  "type": "quote",
  "quote": "정확히 보존한 원문",
  "attribution": "출처 또는 화자"
}
```

### image

`src`는 생성되는 HTML 기준 상대 경로, `http(s)` URL, 또는 base64 `png/jpeg/gif/webp/svg+xml` data URL이다. 상대 이미지를 쓰면 HTML만 옮겼을 때 이미지가 깨지므로 반드시 함께 이동해야 한다.

벡터 도식은 PNG로 강등하지 말고 `data:image/svg+xml;base64,`로 내장하면 단일 파일을 유지하면서 확대해도 선명하다. 내장 SVG는 검증 단계에서 위생 검사를 거치며, 다음 중 하나라도 포함하면 거부된다.

- `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`
- `onload=` 같은 inline 이벤트 핸들러 속성과 `javascript:` URL
- `<!DOCTYPE>` 또는 `<!ENTITY>` 선언
- 문서 내부 fragment(`#id`) 또는 self-contained `data:image/png|jpeg|gif|webp;base64,`가 아닌 `href`·`xlink:href`, 그리고 `url(#fragment)`이 아닌 `url()` 참조
- base64·UTF-8 디코드 실패, 잘 형성되지 않은 XML, 또는 `<svg>`가 아닌 루트 요소

래스터와 벡터를 포함해 `<img>`로 렌더된 도식은 내부 텍스트를 브라우저에서 검색·선택할 수 없으므로 `alt`가 유일한 텍스트 대체물이다. SVG 내장은 확대해도 선명하고 단일 파일을 유지하는 데만 이점이 있다. 도식의 `alt`에는 핵심 라벨과 흐름 방향을 담아 이미지를 보지 못해도 같은 정보를 얻게 하고, `caption`은 출처와 맥락만 짧게 쓴다.

```json
{
  "type": "image",
  "src": "assets/flow.png",
  "alt": "이미지를 볼 수 없어도 의미가 전달되는 설명",
  "caption": "출처와 맥락"
}
```

### links

링크는 상대 경로, `http(s)`, `mailto`만 허용한다.

```json
{
  "type": "links",
  "heading": "원자료",
  "items": [
    {"label": "공식 문서", "url": "https://example.com", "note": "확인 시점"}
  ]
}
```

## verification

```json
{
  "status": "verified | failed | not_run | partial",
  "label": "검증 이름",
  "detail": "실행한 명령, 관측한 결과, 또는 미실행 이유"
}
```

리포트 JSON 자체의 validation/compile 성공은 여기에 적지 않는다.

상태 선택 기준:

- `verified`는 실제 대상을 직접 관측한 경우에만 쓴다.
- mock, stub, fake, 고정 fixture로만 통과했다면 `partial`을 쓰고, `detail`에 무엇을 대체했고 따라서 무엇이 증명되지 않았는지 적는다.
- `failed`는 실행했으나 기대 결과가 아닌 경우, `not_run`은 실행하지 않은 경우에 쓰고 이유를 남긴다.
- `detail`에는 실행한 명령과 관측 결과를 남긴다.

# 산출물 계약

번들은 네 가지 신뢰 계층으로 구성된다.

- `source.diff`: 빠짐없이 보존한 원본
- `source.json`: 파싱한 줄, 전역 근거 ID, chunk, 힌트, 원본 hash
- `review-plan.json`: 에이전트가 선택한 읽는 순서, 표시 수준, 설명과 근거
- `review.json`: 검증 후 Markdown과 HTML 렌더러가 사용하는 결과

`inspection.json`은 inspector로 실제 표시한 chunk를 기록한다. 모든 의미적 결과를 이해했다는 증명은 아니다. HTML은 선택된 읽기 화면이므로 원본의 모든 파일을 포함하지 않아도 된다.

## Plan v3

```json
{
  "schema_version": 3,
  "source_sha256": "source.json에서 복사",
  "title": "변경 목적이 드러나는 제목",
  "summary": "최종적으로 달라지는 결과",
  "overview": [
    "상세 코드를 읽기 전에 알아야 할 결과"
  ],
  "attention": [
    {
      "type": "fix",
      "title": "먼저 판단할 문제",
      "body": "발생 조건, 코드 동작, 영향",
      "evidence": ["D000012"]
    }
  ],
  "sections": [
    {
      "id": "delivery-flow",
      "title": "알림을 받을 대상을 고르고 발송한다",
      "summary": "대상을 고르는 조건과 발송 효과를 설명한다.",
      "default_open": true,
      "evidence": ["D000010", "D000014"],
      "files": [
        {
          "file_id": "F004",
          "view": "detail",
          "note": "대상 선택과 발송을 연결한다.",
          "focus": [
            {"start": "D000010", "end": "D000014", "reason": "구독 중이고 알림을 허용한 회원만 발송 대상에 남깁니다."}
          ],
          "collapse": [
            {"start": "D000020", "end": "D000040", "reason": "발송 조건을 검증하는 데 쓰는 모듈"}
          ]
        },
        {
          "file_id": "F005",
          "view": "summary",
          "note": "같은 계약을 API 타입에 반영한다.",
          "focus": [],
          "collapse": []
        }
      ]
    }
  ],
  "omitted_files": [
    {
      "file_id": "F009",
      "reason": "손으로 작성한 스키마와 같은 내용을 담는 생성 타입"
    }
  ],
  "unreviewed_file_ids": [],
  "verification": [
    {
      "name": "focused unit test",
      "status": "passed",
      "evidence": "pnpm test path/to/test"
    }
  ]
}
```

## 검증 규칙

- `schema_version`은 `3`이어야 한다.
- `source_sha256`은 현재 번들과 일치해야 한다.
- `overview`는 1~5개의 비어 있지 않은 문자열이어야 한다.
- 변경이 있는 문서에는 section이 하나 이상 있어야 한다.
- section `id`는 소문자 영문·숫자·hyphen만 쓰며 중복할 수 없다.
- section은 제목, summary, `default_open`, 하나 이상의 파일, 하나 이상의 근거가 필요하다.
- section 파일의 `view`는 `detail` 또는 `summary`다. `summary` 파일은 focus와 collapse를 가질 수 없다.
- section과 attention의 근거는 HTML에서 이동할 수 있도록 같은 section의 `detail` 파일을 가리켜야 한다.
- 검토한 파일은 section 또는 `omitted_files` 전체에서 정확히 한 번만 등장해야 한다.
- `omitted_files`에는 HTML에서 생략해도 되는 이유가 필요하다.
- 아직 읽지 못한 파일은 `unreviewed_file_ids`에만 있어야 한다. 모든 원본 파일은 section, 생략, 미검토 중 정확히 한 곳에 있어야 한다.
- section 또는 생략 목록에 넣은 파일이 속한 모든 chunk는 inspector로 읽었어야 한다.
- 모든 attention은 `fix`, `caution`, `confirm` 중 하나이며 근거가 필요하다.
- `focus`와 `collapse` 범위는 한 파일 안에 있어야 하고 서로 겹칠 수 없다.
- `collapse`는 같은 hunk 안의 두 줄 이상이어야 하며 파일·hunk metadata를 숨길 수 없다.
- 검증 상태는 `passed`, `failed`, `not_run`, `unknown` 중 하나다.
- `verification`은 대상 코드의 테스트·정적 검사·CI·관련 소스 대조·실행 결과만 담는다. Easy Review 자체의 diff 열람, hash·schema·근거 ID·coverage·렌더링 검사는 넣지 않는다.

## 렌더링 규칙

- 화면은 카드 모음보다 편집형 기술 문서에 가깝게 구성한다. 위계는 타이포그래피·간격·가는 구분선으로 만들고, 둥근 모서리와 배지는 실제 상태를 구분해야 할 때만 제한적으로 사용한다.
- 긴 경로와 근거 링크는 파일명을 먼저 보여주고 전체 경로는 보조 정보나 접근 가능한 설명으로 남긴다. 작은 화면에서도 제목, 파일 설명, 코드가 서로 폭을 빼앗지 않게 재배치한다.
- `detail`은 diff를 표시한다. focus reason은 해당 코드 바로 위에 나타난다.
- `summary`는 파일 경로와 역할만 표시하고 코드 diff는 만들지 않는다. section의 `detail` 파일 뒤에 기본으로 닫힌 `보조 변경` 묶음으로 모은다.
- `omitted_files`는 HTML 본문과 미니맵에 표시하지 않는다. 생략 개수와 전체 원본 링크만 기술 정보에 남긴다.
- `verification`이 비어 있으면 `확인한 내용` 섹션과 테스트를 실행하지 않았다는 자리표시 문구를 만들지 않는다.
- 파일 header metadata는 자동으로 접는다. agent가 지정한 collapse는 코드 안에 요약 행으로 나타난다.
- 언어를 식별할 수 있는 파일은 번들된 Prism으로 구문 강조한다. 네트워크 요청은 하지 않는다.
- 넓은 화면에서는 우측 미니맵을 고정하고, 좁은 화면에서는 현재 section과 문서 위치가 보이는 하단 플로팅 바로 바꾼다. 두 형태 모두 현재·지난·남은 section을 구분한다.
- HTML 문서는 Python 표준 라이브러리의 element tree로 구성한다. 계획과 diff에서 온 값은 text 또는 attribute로만 넣어 자동 이스케이프하고, 문자열 HTML 조각이나 범용 `replace()`로 동적 데이터를 삽입하지 않는다.
- CSS, Prism, 동작 스크립트는 읽기 전용 정적 자산으로만 삽입한다. 스크립트 자산에 `</script>`가 있으면 컴파일을 중단한다.

## Chunk 동작

Chunk는 표시 창이지 독립 diff가 아니다. 캡처 단계에서 전체 diff 힌트를 먼저 계산하고 전역 `D...` ID를 한 번만 붙인 뒤, 가능한 경우 파일과 hunk 경계에서 나눈다. 큰 hunk는 표시만 분할하며 앞쪽 hunk header와 소량의 source 문맥을 반복한다.

최종 renderer는 항상 분할되지 않은 `source.diff`를 기준으로 컴파일한다. 그래서 chunk를 합치는 과정에서 줄 번호가 바뀌거나 일부 원문이 사라지지 않는다.

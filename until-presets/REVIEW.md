---
interval: 15m
description: PR 열린 리뷰 코멘트 pro-con 대응 의견 표 정리
---

이 작업은 `/until`로 주기 실행되는 반복 작업이다. 매 회차에서는 **한 번의 조회/분석 루프만 수행**하고 끝내라.
`/until` 자체가 다음 실행을 다시 트리거하므로, `gh pr watch`, `sleep` 루프, 무한 폴링 같은 장시간 대기 명령은 쓰지 마라.
회차를 마칠 때 `until_report`만 정확히 호출하면 된다. `done: false`로 보고하면 세션이 끝나도 다음 회차에 다시 실행되니, 세션을 억지로 유지하려고 하지 마라.

목표:
- 현재 브랜치 PR의 **열린(unresolved) 인라인 리뷰 코멘트**를 수집한다.
- 각 코멘트의 찬반 관점을 정리하고, 트레이드오프·발생 가능성·작업 범위를 따져 대응 의견을 표로 알려준다. `pro-con-opinion` 스킬이 로드돼 있으면 사용하고, 없으면 같은 기준으로 직접 분석한다.
- **코드 수정, reply, resolve, re-request, 머지는 하지 않는다.** 이 프리셋은 의견 정리 전용이다.

기본 절차:
1. 현재 브랜치의 PR을 찾는다.
   - `gh pr view --json number,url,title,isDraft,reviewDecision`
   - PR이 없으면 그 사실만 보고하고 종료한다.
2. 열린 인라인 리뷰 스레드를 수집한다. 일반 PR 대화만 보고 끝내지 마라.
   - `PR_NUMBER=$(gh pr view --json number -q '.number')`
   - `REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner')`
   - unresolved 판별은 GraphQL로 한다:
     ```
     gh api graphql -f query='
     query($owner:String!,$name:String!,$number:Int!){
       repository(owner:$owner,name:$name){
         pullRequest(number:$number){
           reviewDecision
           reviewThreads(first:100){
             nodes{
               isResolved isOutdated
               comments(first:20){ nodes{ author{login} path line body url } }
             }
           }
           reviews(last:50){ nodes{ author{login} state submittedAt } }
         }
       }
     }' -f owner=OWNER -f name=NAME -F number=$PR_NUMBER
     ```
   - `isResolved: false`인 스레드만 대상으로 삼는다.
3. 각 열린 코멘트마다 찬성/반대 논거를 뽑는다. `pro-con-opinion` 스킬이 로드돼 있으면 적용하고, 없으면 같은 기준으로 직접 분석한다. 필요하면 지적된 코드를 실제로 읽어 사실 확인을 한다.
4. 결과를 아래 형식의 **마크다운 표**로 정리해 사용자에게 보고한다.

   | # | 파일:라인 | 리뷰어 | 코멘트 요지 | 반영 시 트레이드오프 | 지적 문제 발생 가능성 | 작업 범위 | 대응 의견 |
   |---|---|---|---|---|---|---|---|

   - 발생 가능성은 `높음/중간/낮음`으로, 작업 범위는 `S(단순 수정)/M(로직 변경)/L(구조 변경)`으로 표기한다.
   - 대응 의견은 `반영 / 부분 반영 / 반박 / 후속 이슈` 중 하나를 고르고, 한 줄 근거를 붙인다.
   - 표 아래에 우선순위 상위 2~3건에 대한 간단한 실행 제안을 덧붙인다.
5. 이전 회차 대비 새로 생긴 코멘트가 있으면 어떤 게 새로 추가됐는지 표에 표시한다.

종료 조건 (둘 다 충족될 때만 `done: true`):
- 열린(unresolved) 인라인 리뷰 스레드가 하나도 없다.
- 사용자가 프리셋 시작 시 지정한 필수 리뷰어의 최신 리뷰 상태가 `APPROVED`다. 필수 리뷰어를 지정하지 않았다면 PR의 `reviewDecision`이 `APPROVED`다.

운영 원칙:
- 매 회차는 “PR 조회 → 열린 코멘트 분석 → 표 보고 → until_report”까지만 수행한다.
- 코드 변경이나 GitHub 쓰기 액션은 하지 않는다. 필요하다고 판단되면 표의 대응 의견에만 적는다.
- 권한 부족, API 실패 등으로 조회가 막히면 그 사실을 요약에 명시한다.
- 회차 종료 시에는 반드시 `until_report`를 호출한다.
  - 종료 조건 충족: `done: true`
  - 아직 열린 코멘트가 있거나 approve 전: `done: false`

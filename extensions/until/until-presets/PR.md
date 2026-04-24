---
interval: 5m
description: PR 리뷰 대응 + CI 확인 + 머지
---

이 작업은 `/until`로 주기 실행되는 반복 작업이다. 매 회차에서는 **한 번의 점검/대응 루프만 수행**하고 끝내라.
`/until` 자체가 다음 실행을 다시 트리거하므로, `gh pr watch`, `gh run watch`, `sleep` 루프, 무한 폴링 같은 장시간 대기 명령은 쓰지 마라.
회차를 마칠 때 `until_report`만 정확히 호출하면 된다. `done: false`로 보고하면 세션이 끝나도 다음 회차에 다시 실행되니, 세션을 억지로 유지하려고 하지 마라.

목표:
- 현재 브랜치의 PR 상태를 확인한다.
- 리뷰 코멘트와 CI 실패를 처리한다.
- 모든 승인 조건이 충족되면 머지한다.
- 막히면 슬랙 DM으로 알린다.

기본 절차:
1. 현재 브랜치의 PR을 찾고 기본 상태를 확인한다.
   - `gh pr view --json number,url,title,isDraft,reviewDecision,mergeStateStatus`
   - draft PR이면 요약만 남기고 종료한다.
2. CI 상태는 매 회차 스냅샷 조회만 한다.
   - `gh pr checks --json name,state,startedAt,completedAt,link`
   - 필요하면 실패 로그/원인을 추가 조사하고, 수정 가능하면 고친 뒤 push한다.
3. 리뷰/코멘트는 반드시 **인라인 코멘트까지 포함해서** 확인한다.
   - 일반 PR 대화만 보고 끝내지 마라.
   - 예시:
     - `PR_NUMBER=$(gh pr view --json number -q '.number')`
     - `REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner')`
     - `gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate`
   - unresolved thread 확인이 필요하면 `gh api graphql`로 `reviewThreads`와 `isResolved`를 조회해도 된다.
4. 각 리뷰 코멘트는 타당성을 검토한 뒤, 반영할 내용이 있으면 코드 수정 → 테스트/검증 → push 순서로 처리한다.
5. 답변은 가능하면 **해당 인라인 리뷰 스레드에 직접 reply** 한다.
   - 뭉뚱그린 일반 PR 코멘트로 대체하지 마라.
   - 예시:
     - `gh api -X POST "repos/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies" -f body='반영 내용과 근거'`
   - 답변에는 무엇을 바꿨는지, 왜 그렇게 했는지, 남은 제약이 있으면 무엇인지 구체적으로 적어라.
6. 인라인 코멘트 대응을 마쳤다면, 필요한 리뷰어에게 **review re-request**도 해야 한다.
   - 단순히 reply만 남기고 끝내지 마라.
   - 기존 리뷰어가 다시 검토할 수 있도록 GitHub에서 re-request review 상태로 만들어라.
   - 어떤 리뷰어에게 다시 요청했는지도 요약에 포함해라.
7. **리뷰 코멘트/스레드를 직접 resolve 하지 마라.**
   - 코드는 수정하고 인라인 reply는 남기되, resolve 액션은 하지 않는다.
   - unresolved 상태라면 사람이 확인/resolve 할 때까지 기다린다.
8. 아래 조건이 모두 충족될 때만 머지한다.
   - draft 아님
   - 필요한 리뷰어가 모두 approve
   - 직접 처리할 수 있는 리뷰/CI 액션이 더 이상 없음
   - unresolved thread가 남아있지 않음
   - CI가 전부 통과

운영 원칙:
- 매 회차는 “상태 확인 → 필요한 수정/답변 → until_report”까지만 수행한다.
- 장시간 watch/polling은 금지한다. 반복 스케줄링은 `/until`이 담당한다.
- 같은 실패가 반복되거나, 권한 부족/머지 충돌/판단 애매함으로 막히면 슬랙 DM으로 바로 알린다.
- 회차 종료 시에는 반드시 `until_report`를 호출해 현재 상태를 요약한다.
  - 조건 충족 시: `done: true`
  - 아직 기다려야 하면: `done: false`

# Human–Agent Collaboration Roadmap — 계획 검토 보고서

Status: Historical review — superseded by the review-integrated roadmap
Date: 2026-07-12
Target: `doc/plans/2026-07-12-human-agent-collaboration-roadmap.md`
Method: 6개 관점(코드베이스 실측 대조 · 스키마 설계 · 테스트 전략 · 문서 정합성 · 프로그램 구성 · 보안/운영) 병렬 리뷰 → 지적사항별 적대적 검증(계획 원문 재확인 + 인용 코드 실측 + 중대성 판정) → 완결성 비평. 63건 중 60건 확정, 비평가 추가 5건, 기각 3건. 아래는 중복 통합 후 목록.

---

## 0. 요약 — 반복되는 6가지 패턴

1. **기존 메커니즘과의 미조정이 최대 리스크.** 계획이 새로 제안하는 개념 다수가 이미 코드베이스에 유사/동명 메커니즘을 갖고 있다: handoff(successful-run-handoff), trust(trust preset/quarantine), 자동 통과(executionPolicy.mode=auto·watchdog), 게이트(executionPolicy stages), 리뷰 verdict(work product review state), 승인(change-consent-gate), 타임아웃(monitor recoveryPolicy·recovery·watchdog). "Thin core / 병렬 시스템 금지"가 계획의 하드 제약인데, 정작 어떤 기존 기계를 재사용하는지 명시가 빠진 곳이 많다.
2. **존재하지 않는 인프라를 전제한 서술.** company 단위 experimental flag, injectable clock, main/nightly CI 레인, action-class taxonomy, Response Policy 저장소·타임존·severity 축 등은 신규 구축 작업인데 어느 epic에도 스코프되어 있지 않다.
3. **권한 모델 공백.** resolve 권한(현재 비-viewer 전원), steer 게시 권한(§8.2 내 상호 모순), participant 역할 매트릭스, low-trust 게이팅이 미규정. 새 API가 격리·승인 경계를 우회하는 회귀가 구조적으로 가능하다.
4. **회귀 게이트 서술의 사실관계 오류.** `pnpm test:e2e`는 multi-user suite를 실행하지 않고, Storybook 시각 회귀 게이트가 체크리스트에서 빠졌으며, work_mode는 4종(skill_test 포함)이다.
5. **타임아웃 행위자 이원화 위험.** silentDefault(Stage 1) / SLA worker(Stage 4) / task watchdog / recovery가 같은 pending 상태에 각자 발화할 수 있는데 "one owner of timeout actions"는 완화 문구만 있고 결정·산출물이 없다.
6. **산출물 누락.** CLI 패리티, 운영자 문서(docs/)·OpenAPI, 메트릭 소스 매핑과 베이스라인 수집, 롤백/데이터 호환 정책, 스킬 배포↔flag 정합성.

---

## 1. 우선 반영 (High)

### H-1. `pnpm test:e2e`는 multi-user suite를 실행하지 않음 — §2.2
`tests/e2e/playwright.config.ts:24`가 `multi-user.spec.ts`, `multi-user-authenticated.spec.ts`를 `testIgnore`로 제외한다. authenticated용은 `pnpm test:e2e:multiuser-authenticated`가 따로 있고, plain multi-user용 루트 스크립트는 아예 없다. §2.2가 "multi-user configs as applicable"을 `pnpm test:e2e`에 귀속시켜, Stage 3(participants/pair)처럼 auth/membership을 건드리는 PR에서 약속된 회귀가 실제로는 돌지 않는다.
**보완**: §2.2 표에 multi-user 전용 행(정확한 명령 포함)을 추가하고, Stage 3·5 검증 계획에 트리거 조건과 함께 명시. plain multi-user용 루트 스크립트 추가를 Stage 0 epic에 포함.

### H-2. HandoffPackage `decisionOptions`가 기존 resolve 동사 체계와 매핑되지 않음 — §6.2–6.3
기존 interaction resolve 표면은 accept/reject/respond/verdicts/cancel(`server/src/routes/issues.ts:8992+`)이고 `RequestConfirmationResult.outcome`은 accepted/rejected/superseded_by_comment/stale_target뿐이다. `request_changes`는 execution decision 도메인에만, `reassign`은 어느 도메인에도 없다. 매핑 없이는 구현이 결국 새 resolve 동사(=계획이 금지한 병렬 승인 시스템)를 만들게 된다.
**보완**: §6.2에 옵션별 매핑 표 추가 — 각 옵션이 종결되는 엔드포인트/status/outcome, 부수효과(reassign은 원자적 부수효과인지 별도 PATCH인지, request_changes는 reject+reason+wake인지), continuationPolicy 발화 여부. reassign은 권한·단일 assignee 불변식과 함께 정의하거나 Stage 1에서 제외 명시.

### H-3. 'handoff' 명칭·메커니즘이 기존 successful-run-handoff와 충돌 — §6.2
`SuccessfulRunHandoffState`(`packages/shared/src/types/issue.ts:520`), `server/src/services/recovery/successful-run-handoff.ts`, activity `issue.successful_run_handoff_resolved`가 이미 존재하며 정확히 '사람 disposition이 필요한 순간'을 다룬다. 새 HandoffPackage와의 관계(required 상태 해소 여부, attention 이중 항목, activity 네임스페이스)가 미정의.
**보완**: Stage 1 절에 관계 정의 추가 — (a) handoff-bearing pending interaction이 successfulRunHandoff.state=required의 유효 disposition 경로인지, (b) activity 명칭 분리(예: `issue.structured_handoff_created`), (c) attention dedup 규칙.

### H-4. DecisionContract의 버전·진행 중 수정·편집 권한 규칙 부재 — §7.2–7.4
스케치에 contract 자체의 version/revision이 없고, in_progress 중 누가(assignee 에이전트가 자기 DoD를 약화할 수 있는가?) 수정 가능한지, 수정 시 이미 발화된 before_done 게이트가 어떻게 되는지 미정의. 기존 stale-target 만료 기계(`RequestConfirmationResult.outcome "stale_target"`, `issue-thread-interactions.ts:800,1772`)가 정확히 이 문제를 풀지만 revision 있는 대상에만 적용 가능하다.
**보완**: contractVersion 필드 + 편집 권한 매트릭스 + '계약 수정 시 게이트 confirmation 자동 stale 만료' 규칙을 §7.2에 추가. §7.5 서버 테스트에 '계약 수정 후 이전 게이트 승인으로 done 불가' 케이스.

### H-5. workers:1 직렬 실행 하에서 스위트 증가량 대비 CI 예산 분석 부재 — §3.4/11.3/14
Stage 1~5가 신규 spec 약 14개 + flag off/on 이중 커버리지를 추가하는데, 기본 e2e는 인스턴스 플래그 변이 때문에 `workers: 1`이고 PR CI e2e job은 install+build 포함 `timeout-minutes: 30`(`.github/workflows/pr.yml:361`). 서버 vitest는 같은 문제로 3-way 샤딩 중인데 e2e에는 샤딩·레인 분리 계획이 없다.
**보완**: §11.3에 e2e 런타임 예산과 초과 시 대응(collab 전용 config/job 분리, `--shard`, company-scoped flag로 workers:1 제약 완화)을 명시. '스위트 분할 기준' 결정을 Stage 0에 포함.

### H-6. Handoff 해결 권한 — 기존 resolve 엔드포인트는 비-viewer 멤버 전원에게 열려 있음 — §6.3/7.2
accept/reject의 권한 검사는 `assertCompanyAccess + assertBoard`뿐(`issues.ts:9002,9110`)이라 operator를 포함한 모든 활성 비-viewer 멤버가 임의 interaction을 해결할 수 있고, 수락은 즉시 continuation wake(비용 발생)를 유발한다. Stage 2의 `role: board | assignee_user | named_approver`를 오늘의 이분법 권한 모델로 어떻게 집행할지 계획에 없다.
**보완**: handoff에 approver 지정 필드가 있으면 resolve 시 actor 검증(불일치 403)을 Stage 1 규칙으로 명시. humanGates role 집행 로직과 부정 테스트(비승인자 resolve → 403)를 §6.5/§7.5에 추가.

### H-7. low-trust preset·agent key scope 게이팅이 계획 전반에서 누락 — §2.1/3.2 외
기존 interaction 생성은 low-trust 에이전트를 차단하고(`assertLowTrustControlPlaneDenied`, `issues.ts:8954`) heartbeat 컨텍스트는 low-trust 산출물을 리댁션하지만, 계획의 불변식(§2.1)과 시나리오 매트릭스(§3.2)에는 trust boundary가 없다. handoff 생성, steer 소비, playbook 초안, alignment 등 새 표면이 격리 경계를 우회할 수 있다.
**보완**: §2.1에 불변식 추가("low_trust_review 경계는 신규 collab API에서도 유지"), §3.2에 C5(low-trust 접근 거부) 클래스 추가 후 각 스테이지 E2E에 1개 이상 반영. playbook은 low-trust 초안 생성 금지 명시.

### H-8. Trust ladder 성공 카운터의 무결성·저장·감쇠 미규정 — §9.2
'success counters'의 성공 판정·저장 위치·증가 권한이 미정의. 에이전트는 이슈를 스스로 생성하고 run 헤더로 전이도 수행하므로, 성공 정의가 느슨하면 자기 생성 이슈 farming으로 임계값을 넘겨 auto-pass를 스스로 해제할 수 있다 — §15의 "auto-approvals = 0"이 지키려는 경계를 하위 클래스에서 무력화.
**보완**: (1) 성공 이벤트는 서버 파생·자기 보고 불가(사람이 accept한 handoff/contract 충족 done만 집계, 자기 생성·완료 제외), (2) 저장 위치·회사 스코프, (3) 시간 감쇠·실패 강등·board 리셋 API, (4) farming 시 auto-pass 미해제 검증 시나리오.

### H-9. Storybook 시각 회귀·스토리 산출물 의무가 게이트에서 누락 — §2.2/12
`doc/design/CHANGING-THE-UI.md`는 '새 시각 표면 = 새 스토리', 'baseline-manifest 갱신 없는 시각 변경 PR은 불완전'을 규정하고 `pnpm test:storybook-visual`(package.json:53)이 존재하는데, §2.2와 §12에는 token-gates만 있다. Stage 1~5는 handoff 카드·리뷰 워크벤치·steer 컨트롤·아바타·composer 등 대량의 새 시각 표면을 만든다. 스토리 의무가 빠지면 addon-a11y 기반 접근성 커버리지도 함께 사라진다.
**보완**: §2.2 표에 Storybook visual 행 추가, §12에 '스토리 추가 + baseline manifest 갱신 + a11y 위반 없음' 항목 추가, 각 스테이지 UI slice에 스토리를 명시적 deliverable로.

---

## 2. 공통 기반·검증 전략 (§2–3, §11)

- **company 단위 flag 인프라 부재** (§3.4/5.2): experimental flag는 인스턴스 싱글톤 `InstanceExperimentalSettings`의 typed boolean뿐이고 companies에 settings 컬럼이 없다. company 스코프를 원하면 스키마+API+UI 신규 작업 — 어느 스테이지에도 스코프 안 됨. → flag 스코프를 확정하고, company 단위가 필요하면 Stage 0 epic의 명시적 이슈로 분리.
- **flag off/on 이중 커버리지 실행 방식 미정의** (§3.4): 전체 spec이 단일 서버를 공유하고 인스턴스 플래그 오염 전례(enableConferenceRoomChat) 때문에 workers:1이 된 역사가 있다. → collab 플래그는 가급적 company-scoped로 설계해 spec별 회사 생성으로 격리, 'flag-off 커버리지 = 기존 baseline 스위트 자체'라는 기준 명시(이중 실행 금지).
- **flag-off 롤백 시 데이터 호환·킬스위치 부재** (§3.4/12): flag-on에서 영속화된 handoff payload·`work_mode=collaborate` 레코드가 flag-off 후 렌더/해결/PATCH 가능한지 미정의. → 시나리오 매트릭스에 D1(데이터 호환) 클래스 추가, §12에 graceful degradation 문서화 항목, local_trusted 외 배포 모드의 기본값·킬스위치 절차 명시.
- **동시 해결(race)·멱등 재시도 시나리오 클래스 부재** (§3.2): 서버는 이미 double-resolve에 409를 던지고 idempotency key 충돌 처리가 있다. pair mode가 복수 인간을 만들면 동시 accept는 정상 UX 경로가 된다. → C5(동시 해결: 한쪽 409 + UI 갱신), R3(멱등 재시도) 클래스 추가.
- **membershipRole별 권한 매트릭스 시나리오 부재** (§3.2): owner/admin/operator/viewer × 신규 mutating 엔드포인트의 허용/거부 검증이 없다(C4는 company boundary만). → P1 클래스 추가, vitest 계층 한정으로 런타임 부담 회피.
- **handoff 이후 wake 실패·agent 크래시 시나리오 부재** (§3.2/6.5): continuation wake는 fire-and-forget(`issues.ts:9066,9085`)이고 회복은 주기 recovery에 위임된다. resolve 후 wake 실패 시 invariant 2.1.6(next-action owner) 유지 검증이 없다. → R4(wake 실패/크래시 회복) 추가, 서버 통합 테스트로 지정.
- **§11.3 CI 정책이 존재하지 않는 레인을 전제** (§11.3/5.4): e2e는 이미 모든 PR에서 실행되고(선별 개념 무의미), master push e2e 워크플로 없음(e2e.yml은 workflow_dispatch 전용), schedule/cron 워크플로 0건(nightly 부재), @collab grep 배선 없음. 'green for 2 consecutive CI runs'도 측정 방법 미정의. → main/nightly 워크플로 신설을 Stage 0 deliverable로, exit criterion을 측정 가능한 정의로 교체.
- **attention 피드 볼륨·페이지네이션 시나리오 부재** (§3.2/9.4, low): U1은 단일 항목만 검증. → V1(볼륨: 30+ pending 시드 후 정렬·그룹핑·페이지네이션) 추가, 서버 통합 테스트 위주.

---

## 3. Stage 1 — Structured Handoff (§6)

- **watchdog의 plan-confirmation 자동 해결과 handoff의 충돌 미규정** (§6.2/6.4, 3개 관점에서 독립 확인): watchdog은 eligible task-level `request_confirmation` plan confirmation을 자동 accept할 수 있고(SPEC-implementation §9.9, TASK-WATCHDOG.md:136), eligibility 조건에 handoff 개념이 없다. §6.4의 완화("governed actions stays board-only")는 governed 케이스만 커버 — 비-governed handoff-bearing plan confirmation은 현행 계약상 watchdog-eligible이어서, 사람이 결정하도록 만든 패키지를 watchdog이 자동 수락할 수 있다('Humans decide' 북극성 위반). → handoff 블록 존재 = SPEC §9.9의 human-reservation으로 간주(또는 `humanOnly` 플래그 기본 true) 규칙을 추가하고, SPEC §9.9 갱신을 Stage 1 epic 산출물로. E2E에 'watchdog이 handoff-bearing confirmation resolve 시도 → 거부' 케이스.
- **silentDefault의 시간 기반 만료가 기존 수명주기·스키마에 없는 개념** (§6.2): 기존 만료는 전부 이벤트 구동(supersede/stale-target)이고 `issue_thread_interactions`에 expiresAt류 컬럼이 없다. payload jsonb에만 넣으면 SLA 워커가 전 회사 pending jsonb를 스캔해야 하고(인덱스 불가), 'escalate'는 대응 종결 status가 없으며 'pause' 대상(이슈? 회사?)도 미정의. → 마감시각의 일급 컬럼 승격 여부(partial index 포함), 액션별 종결 status 매핑, silentDefault vs 회사 SLA 우선순위를 Stage 1 스키마 확정 전에 결정.
- **requiredArtifactIds 참조 무결성·id 네임스페이스** (§6.2/6.5): work product와 attachment 모두 DELETE 라우트가 있는데 생성 시 검증만 계획됨. 두 테이블 id를 한 배열에 혼용해 구분 불가 — 기존 관례는 타입 태그 참조(RequestConfirmationTarget). → `{type: "work_product"|"attachment", id}` 구조로 변경, pending handoff 참조 artifact 삭제 정책(409 거부 또는 결손 마킹)을 §6.4에 추가.
- **Stage 1–3 구간의 handoff/steer 남용 한도 부재** (§6.5/8.4/14): 'Attention feed overload'의 완화책이 전부 Stage 4 기능이고, 그 question budget도 `ask_user_questions`만 대상. 현재 rate limit은 회사 검색 한 곳뿐. → per-issue pending handoff 상한, 페이로드 크기 한계(reason 길이, artifactIds 개수, afterMinutes 하한)를 Stage 1 검증에 포함, steer 빈도 한도·coalescing 윈도를 수치로 명시.

---

## 4. Stage 2 — Decision Contracts + Review (§7)

- **저장소 3안 유보가 안전하지 않음** (§7.2): (a) execution_policy 확장 — `issueExecutionPolicySchema`는 비-strict라 스키마 확장 전에는 PATCH 왕복에서 contract가 조용히 유실되고, low-trust 계약 계획(2026-06-03)이 이 JSONB를 'validator-locked, free-form 금지'로 확정했으며, 기존 `mode:"auto"`와 autoPass가 의미 중첩. (b) issue_documents — 본문이 markdown text라 기계 검증 불가, 단 revision·annotation 기계는 이 안만 공짜. (c) 전용 jsonb — 검증 쉬우나 revision 이력 없음. → 결정 기준 표(서버측 검증 가능성, revision 필요성, agent GET 노출, PATCH 유실 위험)와 각 안의 배제 조건을 명시하고 Stage 2 epic 1의 선행 결정으로 기록.
- **humanGates가 executionPolicy 스테이지와 중복되는 제2의 게이트 표현** (§7.2): 기존 stages는 이미 participant{agent|user}와 stageType(review|approval)으로 게이트를 모델링. humanGates는 다른 role 어휘를 쓰고 named_approver의 대상 id 필드도 없으며, `before_in_progress`는 기존 스테이지 실행 시점 밖(체크아웃 가드와의 상호작용 미정의). → 런타임 단일화: humanGates를 저작 표현으로만 두고 저장 시 executionPolicy 스테이지로 컴파일하거나, 스테이지만 확장하고 humanGates 제거.
- **autoPass가 자동 통과 메커니즘 3~4개와 중복** (§7.2/9.2): contract autoPass / trust ladder / `executionPolicy.mode="auto"` / watchdog 자동 resolve의 우선순위·조합 규칙이 없다. → 단일 평가 지점 정의(autoPass는 선언, ladder는 활성화 조건, mode=auto와의 우선순위), watchdog 범위와의 비충돌을 불변식 테스트에 추가.
- **리뷰 워크벤치와 기존 work product review state 머신의 관계 미정의** (§7.2/7.3): `IssueWorkProductReviewState`(none/needs_board_review/approved/changes_requested)와 signoff policy가 이미 존재(ROADMAP상 완료 마일스톤). annotation/decision이 제2의 verdict 저장소가 될 위험 — 'Thin core' 제약과 충돌. → 승인/변경요청 액션의 단일 기록 소스((a) reviewState 전이 (b) 스테이지 결정 (c) 신규 annotation 중) 지정, '이중 기록 없음' 어서션 추가.
- **`pr_link`는 존재하지 않는 work product type** (§7.2, low): 실제 enum은 `pull_request` 등 7종(`work-product.ts`). → 예시를 실제 값으로 교체하고 `requiredWorkProductTypes`를 `issueWorkProductTypeSchema` 참조로 명시.

---

## 5. Stage 3 — Steer + Pair + collaborate (§8)

- **steer 권한 모델이 §8.2 내에서 상호 모순 + 프롬프트 주입 표면 미규정**: "Board posts a steer directive" vs "Pair human can steer" vs H2 테스트(pair user 200). 현행 권한은 board/agent 이분법 + viewer 쓰기 차단뿐이라 구현 기본값은 '모든 비-viewer가 실행 중 에이전트에 지시 주입 가능'이 된다. steer 텍스트는 wake payload로 에이전트 컨텍스트에 직접 주입되는 사실상의 즉석 instruction 채널인데(기존 instruction 변경은 change-consent-gate로 diff 표시 강제), 출처 라벨 요구사항이 없다. → 게시 권한 표 확정(membershipRole 기준 + pair 허용 여부, 필요 시 `tasks:steer` 권한 키), steerDirectives[] 항목에 서버 부여 출처 메타데이터(actorUserId, role, createdAt) 스키마 요구, 어댑터/스킬 문서에 신뢰 구분 지침.
- **steer 저장소 후보 둘 다 부적합 + consumed 추적 부재** (§8.2): `issue_execution_decisions`는 stageId/stageType/outcome NOT NULL인 스테이지 결정 전용, comment metadata는 프레젠테이션 행 모델. 어느 run이 어느 directive까지 소비했는지(deliveredAt/consumedByRunId)와 순서·supersede 컬럼이 어느 후보에도 없다. → 전용 경량 테이블을 1안으로 승격하고 기존 후보 배제 근거 문서화, 병합 의미론을 스키마 수준에서 정의.
- **steer가 execution-semantics의 comment interrupt/wake 계약과 미조정** (§8.2/8.3): execution-semantics는 board 코멘트 wake와 interrupt/ownership/wake를 이미 엄격 구분(:288, :303–319). steer가 interrupt인지 비중단 wake인지, coalescing이 코멘트당 1 wake 규칙과 어떻게 상호작용하는지 미정의. → steer = 비중단 wake(기존 board-comment wake 경로 재사용)를 기본으로 명시, 중단형은 기존 interrupt 계약 준수.
- **pair/observer/approver 권한 매트릭스 부재** (§8.2): observer·approver의 능력이 미정의이고, viewer 멤버가 participant로 추가되면 쓰기가 가능해지는지(membershipRole 상한 여부), participant approver ↔ Stage 2 named_approver 관계, 추가/제거 권한이 전부 미정. → 'participant role × membershipRole × 행위' 매트릭스 문서+서버 테스트를 Stage 3 산출물로. 최소 결정: 멤버십이 상한, 추가/제거는 tasks:assign 또는 board.
- **pair mode E2E는 기본 구성에서 불가능** (§8.5): 별도 사용자 신원이 필요한데 기본 e2e는 local_trusted 단일 암묵 사용자, multi-user 구성은 testIgnore + webServer 없음(수동 부트스트랩) + CI 미배선. → 실행 구성 명시: authenticated multi-user 구성에 webServer 자동화+CI 레인 신설(Stage 3 epic 포함), 또는 H2를 local_trusted 검증 가능 범위로 축소하고 신원 구분은 서버 통합 테스트로 이관.
- **work_mode 서술이 코드와 불일치** (§2.1.7/8.2/8.4, 3개 관점에서 독립 확인): 실제 `ISSUE_WORK_MODES`는 `skill_test` 포함 4종(constants.ts:216)이고, `issues.work_mode`는 pg enum이 아닌 text 컬럼이라 "migration default remains standard"는 부정확 — DB 마이그레이션 자체가 불필요하고 실제 표면은 shared z.enum + heartbeat 프롬프트 분기 + UI 뱃지. 미지 모드는 현재 standard로 조용히 흘러간다. → 모드 목록에 skill_test 추가(회귀 범위 포함), 8.4 문구를 실제 변경 표면 열거로 교체, collaborate 의미론의 분기 지점 목록을 epic에 명시.
- **single-assignee XOR는 서비스 레이어 검증만 존재** (§8.4): DB CHECK constraint 없음, `createIssueSchema`에 XOR superRefine 없음(suggestedTaskDraftSchema에만 존재). 계획의 'DB constraint' 완화책은 hot table 신규 마이그레이션 작업. → 완화책을 현재 상태 기준으로 수정, constraint 추가와 shared validator 보강을 Stage 0/3 이슈로 배정.
- **Stage 2/3 병행 구간이 동일 파일을 수정** (§4): review layout(Stage 2)과 LiveRun steer 컨트롤·participants 아바타(Stage 3)가 모두 `IssueDetail.tsx`(5,082줄)·`IssueChatThread.tsx`(5,039줄)를 수정. → 병행 범위를 Stage 3 서버 측 slice로 한정하거나, IssueDetail 표면 분해 선행 이슈를 Stage 2 epic에 추가.

---

## 6. Stage 4 — SLA, Trust Ladder, Playbooks (§9)

- **타임아웃 행위자 4종의 소유권 미확정** (§6.3/9.2–9.3, 3개 관점에서 독립 확인): silentDefault worker(Stage 1, 소속 미결정) / SLA worker(Stage 4) / task watchdog(pending interaction 대기에 반응) / monitor recoveryPolicy·recovery 서비스(execution-semantics가 이미 bounded wait 타임아웃 소유권 정의: timeoutAt/maxAttempts/wake_owner·create_recovery_issue·escalate_to_board)가 같은 대기 상태에 각자 발화 가능. 'pause'는 이슈 상태 머신에 없는 개념. §9.3의 "one owner" 완화 문구를 설계·구현하는 deliverable이 없다. → Stage 0 extension-points 문서에 'timeout-actor 우선순위 매트릭스'를 필수 절로 지정, silentDefault는 스키마만 Stage 1·집행은 Stage 4 단일 경로(기존 heartbeat tickTimers 확장)로 못 박고, 액션에 interaction id+정책 버전 멱등성 키와 '재시작 직후 중복 escalate 없음' 테스트 요구, 'pause'를 실제 상태 머신 용어로 치환.
- **시간 제어 전략이 현재 스케줄러 구조상 실행 불가능** (§9.4): injectable clock 인프라가 없고 주기 작업은 heartbeat 스케줄러 단일 setInterval에서 구동되며 tick 간격이 `Math.max(10000, ...)`으로 최소 10초 하드 클램프(config.ts:333). SLA 임계값을 50ms로 낮춰도 escalation은 10~30초 후 — spec timeout 60초 내 다중 케이스 누적 불가. → (1) SLA 스캔 주기를 별도 env로 분리, (2) e2e 전용 'tick now' 디버그 엔드포인트, (3) escalation 검증은 서버 vitest(now 파라미터 주입)로 한정하고 브라우저는 시드된 상태의 UI만 검증 — 중 하나를 선행 작업으로 명시.
- **Human Response Policy의 저장소·타임존·severity 축이 전부 미존재** (§9.2): companies에 settings jsonb 없음, 스키마 전체에서 timezone 컬럼은 routines.timezone 하나뿐, issues에는 priority만 있고 severity 없음. → 설정 스키마 결정(저장 위치, 타임존 소스, priority 재사용 vs severity 신설)을 선행 deliverable로 추가.
- **action-class taxonomy가 정의되지 않은 숨은 선행 작업** (§9.2): 'action class'는 이 계획 문서에만 존재하는 용어. 기존 분류는 APPROVAL_TYPES 4종과 governed action 나열뿐. → taxonomy 정의(클래스 목록·위험 등급·성공 판정 이벤트·저장 스키마)를 Stage 4 이전 별도 설계 이슈로 §13·§4 의존성 표에 등재.
- **'Trust Ladder'가 기존 trust preset/SourceTrust 격리 모델과 용어·의미 충돌** (§9.2): 코드에서 trust는 봉쇄 의미로 예약됨(`TRUST_PRESETS`, `SourceTrustDisposition: quarantined|promoted`). ladder는 반대 방향(자율성 확대) 메커니즘. → (1) ladder는 trustPreset/quarantine 경계를 어떤 임계값에서도 완화 불가 불변식, (2) low_trust_review 이슈 완료는 카운터 제외, (3) 명명 분리(예: 'autonomy ladder').
- **Playbook 발행이 기존 change-consent-gate·suggest-changes 경로 재사용을 명시하지 않음** (§9.2): skill/instructions 변경 전용 승인 게이트(diff 표시 강제 포함)와 `skills:suggest-changes` 권한이 이미 존재. 미참조 시 병렬 승인 플로우가 생겨 §6.2의 금지 원칙·불변식 2.1.4와 충돌. → 기존 타깃 키·권한 경로 재사용 명시, 초안에 생성 에이전트/run 출처 메타데이터 필수, diff 전문 표시 강제.
- **Playbook 캡처에 redaction·비밀정보 위생 단계 부재** (§9.2): 기존 피드백 파이프라인(feedbackVotes/Exports, 회사 동의, `sanitizeFeedbackText`)은 내보내기 전 리댁션을 강제하는데, 피드백→플레이북→스킬은 어댑터 syncSkills로 전 에이전트 워크스페이스에 무가공 복제된다. → feedback-redaction 계층 재사용과 비밀 스캔 단계 명시, '비밀 문자열 포함 피드백은 redaction 후 저장' E2E 케이스.
- **SLA worker 관측성 부재 — 현행 스택은 traces-only** (§9/15): observability.md가 '메트릭·로그는 범위 밖'을 명시, telemetry.ts는 옵트인 제품 텔레메트리. 워커 고착·오발화 감지 수단이 없다. → 메트릭 저장·노출 방식 결정 문서를 Stage 0에, SLA 워커 health(last-tick/처리 건수)와 타임아웃 액션 활동 로그 필수 기록을 Stage 4 exit criteria에 추가.
- **Stage 4는 독립 기능 4개가 묶인 사실상 복수 스테이지** (§4/9): 기능당 전용 E2E 파일·신규 스키마·백그라운드 워커 포함 3–4주는 비현실적(단일 기능 Stage 1이 2–3주). 의존성도 기능별로 상이. → 4a(SLA+Question Budget: 노이즈 감소)/4b(Trust Ladder+Playbooks: 자율성 확대)로 분할, 독립 flag·exit criteria 부여.

---

## 7. Stage 5 — Composer, Alignment, Bundles (§10)

- **Command Composer가 2026-03-11 chat 계획의 확정 결정 및 `issues.kind` 부재와 미조정** (§10.2/10.4): 선행 계획(2026-03-11-agent-chat-ui-and-issue-backed-conversations.md)이 이미 issue-backed chat, conversation-flavored issue, 'chat with CEO' 모델을 확정했는데 §10.2는 features.md만 인용. 전제하는 `issues.kind`(task|strategy|question|decision)는 실제 스키마에 없고(origin_kind/harness_kind만 존재) features.md enum에는 `alignment`도 없다 — '기존 primitive 확장'이 아니라 신규 스키마 작업. → 2026-03-11 계획을 참조로 추가하고 conversation-flavored issue 재사용 여부 명시, `issues.kind` 신설(또는 라벨)을 별도 스키마 결정 이슈로 분리.
- **conference-room E2E의 실제 내용이 계획의 가정과 다름** (§2.2/10.4, low): 존재하는 파일은 `conference-room-typing-intro.spec.ts` 1개이고 내용은 온보딩 랜딩 테스트(파일 주석이 chat intro는 BoardChat unit tests로 이전 명시). Stage 5가 의존하는 'flag isolation e2e'는 존재하지 않는다. 부수: §2.2의 `pnpm -r typecheck`도 리포 표준(`pnpm typecheck` = preflight 선행)과 다름. → baseline 목록 정정, §10.4 회귀 행을 'BoardChat unit tests + 신규 flag isolation 검증 필요'로 교체.

---

## 8. 프로그램 전반·산출물

- **메트릭 다수가 이벤트 소스 미정의 + 베이스라인 수집 단계 부재** (§15/5): 텔레메트리 계약에 collab 관련은 `interaction.resolved` 하나뿐(latency measure는 이미 존재하는 이벤트에 없음 — Stage 0 epic은 신규가 아닌 확장으로 구체화 필요). '% handoff', 'steer without cancel', 'orphaned waiting' 등은 소스가 없고, 'Track after Stage 2+'라서 ↓ 방향 메트릭의 사전 베이스라인 확보 불가. 텔레메트리는 익명·opt-out이라 fleet vs 로컬 DB 쿼리 계산 방식도 미정. → §15에 메트릭별 소스 매핑 열 추가, 각 스테이지 slice·§12에 텔레메트리 방출 작업 포함, §16에 'Stage 1 착수 전 N주 베이스라인 수집' 액션 추가.
- **CLI 패리티 deliverable 전무** (§12/13): CLI 패리티 PRD가 CLI를 'canonical external connection surface'로 규정하고 기존 interactions API도 CLI 커버 완료. 신규 표면(handoff/contract/steer/participants/SLA/playbook/bundle)의 CLI 커맨드가 전 스테이지에 하나도 없고 §12 계약 동기화 항목도 cli 제외. → §12를 'shared+db+server+ui(+cli)'로 수정, 에이전트 호출 API만이라도 스테이지 epic에 CLI 이슈 포함.
- **운영자/사용자 문서와 OpenAPI 갱신 부재** (§12): docs/ 사이트(board-operator·agent-developer 가이드, api 레퍼런스 13개)와 openapi.ts가 있는데 계획의 문서 산출물은 agent skill과 내부 design note뿐. → §12에 docs/ 갱신 + openapi.ts 등록 항목 추가, 스테이지별 사용자 문서 이슈 1건씩.
- **에이전트 스킬 배포·버전과 flag 상태 간 정합성 메커니즘 부재** (§6.3/12): 스킬은 인스턴스 전역 정적 번들 + 어댑터 syncSkills 복제 + versionId pin 가능 구조인데 새 API는 flag 게이트. flag-off 회사 에이전트가 4xx를 반복하거나 구버전 pin 에이전트가 새 프로토콜을 모르는 비정합이 구조적. → 스킬 버전 릴리스·pin 해제 전략 또는 capability 광고(/api/agents/me 또는 이슈 payload에 활성 기능 목록)를 스테이지별 필수 deliverable로.
- **검증 불가능한 주관적 exit criteria 다수** (§4/8.6/9.5/10.5, low): 'stable', 'does not create orphan runs'(테스트 미지정), 'defaults conservative', 'improve review' 등. → 각 criterion에 검증 수단 병기(테스트 파일명, 수치 정의).
- **presence·steer 실시간 전달 채널 미정 + live-events가 extension point 목록에서 누락** (§5.1/8.2, low): 회사 스코프 live-events WS 인프라가 이미 존재하나 presence 개념 없음. Stage 0 문서화 범위(5.1.4)가 interactions/attention/execution decisions만 나열. → extension-points 문서에 live-events 채널(이벤트 kind 추가 규칙·구독 권한) 포함, '기존 WS 확장 권장·신규 채널 금지'를 Stage 3 slice에 명시.
- **§1 로드맵 매핑 누락** (low): ROADMAP.md의 'Automatic Organizational Learning'(playbooks의 직접 대응)과 'CEO Chat'(composer의 직접 대응)이 매핑 표에서 빠짐. → Stage 4/5 행에 추가, §16.4 정렬 지시에도 포함.
- **'prior collaboration analysis' 참조가 실제 문서로 해석 불가** (Related, low): 저장소 어디에도 대응 문서 없음. → 실제 경로로 교체하거나 분석을 doc/design/ 아래로 커밋, 없으면 참조 제거.

---

## 9. 검증에서 기각된 지적 (참고)

다음 3건은 적대적 검증에서 기각되었다(계획이 이미 다루고 있거나 근거 불충분): ① issue_participants 테이블 vs metadata 유보 비판(구현 계획으로의 유보가 합리적 범위), ② §3.3 헬퍼 시그니처 `asAgent(token)` 인증 패턴 불일치(기존 패턴과 호환 가능), ③ in-flight 데이터 소급 적용 미정의(additive/opt-in 원칙으로 커버).

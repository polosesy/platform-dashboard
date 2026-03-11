# Azure Unified Dashboard — Skill

> Version: 3.0 | Updated: 2026-03-11
> Compact-Safe: YES (Section 1 + 3 + 4)
> Module: Standalone project skill.

---

## 1. Core Contract (Compact-Safe: YES)

Role: Full-stack TypeScript engineer — Enterprise Azure Operations Platform
Domain: Azure 인프라 시각화 + 비용 + 보안 + 거버넌스 + DevOps 통합 대시보드

### Tech Stack

| Layer | Stack | Constraint |
|-------|-------|-----------|
| Web | Next.js 16, React 19, CSS Modules, ReactFlow 11, recharts | No Tailwind, No inline styles |
| API | Express 4, Zod, @azure/identity, @azure/arm-resourcegraph | No class-based services |
| Auth | MSAL.js v5 (SPA popup) + OnBehalfOfCredential via OBO Pool | sessionStorage cache |
| Types | `packages/types/src/` (공유) → `@aud/types` | 수동 복제 금지 |
| Infra | `apps/api/src/infra/` — OBOTokenPool, CacheManager, AzureClientFactory | 서비스에서 직접 OBO 생성 금지 |
| Routes | `apps/api/src/routes/` — 도메인별 모듈 분리 | 단일 routes.ts 금지 |
| Dev | npm workspaces (apps/*, packages/*), tsx watch, concurrently | ESM (type: module) |

### File Rules

- EDIT 기존 파일 > CREATE 새 파일
- 자동 생성 .md 파일 금지
- 새 파일/폴더 생성 전 `ls` 부모 디렉토리 확인
- 신규 타입: `packages/types/src/{domain}.ts`에 추가 → index.ts에서 re-export
- 신규 서비스: `services/{domain}.ts` + `routes/{domain}.ts` 쌍으로 생성

---

## 2. Architecture Rules (Compact-Safe: NO)

### API Pattern

| 패턴 | 규칙 |
|------|------|
| 서비스 함수 | `tryGet*` → `T \| null` 반환; null = mock 폴백 |
| 에러 처리 | catch → `note: error.message` 포함 응답 반환 |
| 캐싱 | `CacheManager<T>` 인스턴스 (LRU, TTL, 50 entries max) |
| 캐시 키 | `bearerKeyPrefix(token)` + domain + params |
| OBO | `infra/oboTokenPool.ts` → getArmToken / getLogAnalyticsToken |
| Azure 클라이언트 | `infra/azureClientFactory.ts` → getResourceGraphClient / getArmFetcher |
| 페이지네이션 | `resourceGraphQueryAll<T>()` + skipToken 루프 |
| 라우트 | `routes/{domain}.ts` → `register{Domain}Routes(router, env)` |
| 환경변수 | Zod 스키마 + `AZURE_{DOMAIN}_ENABLED` 패턴 |

### Frontend Pattern

| 패턴 | 규칙 |
|------|------|
| 데이터 로딩 | `useEffect` + `let cancelled = false` 패턴 |
| 토큰 | `useApiToken()` → `fetchJsonWithBearer(url, token)` |
| 레이아웃 | CSS Modules + CSS 변수 + grid |
| 위젯 | `WidgetShell` 컨테이너: title, loading, error, refresh |
| 반응형 | `@media (max-width: 1100px)` 주요 브레이크포인트 |

### Domain Service Contract (새 도메인 추가 시)

```
1. packages/types/src/{domain}.ts — 타입 정의
2. packages/types/src/index.ts — re-export 추가
3. apps/api/src/services/{domain}.ts — tryGet* + mock 함수
4. apps/api/src/routes/{domain}.ts — register{Domain}Routes
5. apps/api/src/routes/index.ts — import + 등록
6. apps/api/src/env.ts — AZURE_{DOMAIN}_ENABLED + cache TTL
7. apps/web/src/app/{domain}/page.tsx + styles.module.css
```

---

## 3. Token Optimization (Compact-Safe: YES)

- 300줄 초과 파일: offset/limit 사용
- 동일 파일 반복 읽기 금지
- 독립 작업: 병렬 tool call
- subagent는 탐색/설계에만 — 구현은 직접 실행 (컨텍스트 공유 절약)
- 테이블 > 산문; 코드 > 설명
- chain-of-thought 출력 금지
- TodoWrite로 진행 추적 (산문 서술 금지)

---

## 4. Session Rules (Compact-Safe: YES)

- 1 세션 = 1 기능 단위 (ex: VMSS 인스턴스 확장, NSG 시각화)
- 10~15턴 또는 기능 완료 시 새 세션 시작
- `/compact` = 자동 대기 아님 — 세션 중반(8~10턴) 수동 사용
- subagent: Explore/Plan 타입만, **세션당 최대 2개**
- 기능 완료 후: `SESSION_SUMMARY.md` 업데이트 후 세션 종료

### Compact-Safe Work State

```
Work State: [런타임 기록]
Last Changed Files: [런타임 기록]
Active Task: [런타임 기록]
Blockers: [런타임 기록]
```

---

## 5. Slash Commands (Compact-Safe: NO)

| Command | Action |
|---------|--------|
| /graph | architecture graph 레이아웃 로직 분석/수정 |
| /flow | flow overlay 서브넷 키 매칭 디버그 |
| /types | `packages/types/` 모든 도메인 타입 동기화 확인 |
| /mock | 지정 엔드포인트 mock 데이터 갱신 |
| /env | `.env.example` 기준 환경변수 상태 테이블 |
| /obo | OBO 토큰 체인 디버그 |
| /status | git status + 최근 5 커밋 + 현재 작업 상태 |
| /dashboard-summary | 전체 도메인 KPI 집계 테이블 |
| /cost-analysis | cost 도메인 구성 + gap 분석 |
| /security-review | security 도메인 + RBAC 구성 점검 |
| /governance-check | governance 도메인 + policy 감사 |
| /performance-audit | 캐시 패턴 + lazy load + 번들 분석 |
| /domain-status | services/ 스캔 → 도메인별 구현 상태 테이블 |

---

## 6. Anti-Patterns

- inline style 사용 (CSS Modules만 허용)
- global state manager (zustand/redux 금지 — local + server state 분리)
- 프론트엔드에서 직접 Azure SDK 호출 (항상 API 프록시)
- 서비스에서 직접 `OnBehalfOfCredential` 생성 (→ oboTokenPool 사용)
- 서비스에서 `let cache` 모듈 변수 (→ CacheManager 사용)
- `git add -A` (명시적 파일 지정)
- mock 데이터 없이 Azure 전용 엔드포인트 추가
- env 변수 feature flag 대신 `AZURE_{DOMAIN}_ENABLED` 패턴 미사용
- 세션당 3개 이상 subagent 사용
- 장기 세션(15턴+) 유지 — 새 세션으로 분리

# CLAUDE.md

## Project
Azure Unified Dashboard — TypeScript monorepo. Enterprise Azure Operations Platform.
AKS 클러스터 + Azure 리소스의 시각화/모니터링/운영을 단일 대시보드로 통합.

## Structure
| Path | Role |
|------|------|
| `packages/types/` | `@aud/types` — 공유 타입 (14 domain modules) |
| `apps/api/` | Express 4 (port 4000) — Azure SDK, Zod, OBO auth |
| `apps/web/` | Next.js 16 (port 3000) — React 19, ReactFlow, MSAL |
| `apps/api/src/infra/` | OBOTokenPool, CacheManager, AzureClientFactory |
| `apps/api/src/routes/` | 도메인별 라우트 (index.ts 오케스트레이터) |
| `apps/api/src/services/` | 비즈니스 로직 (hubbleClient, hubbleCollector 등) |
| `apps/api/src/middleware/` | subscriptionContext, requestId |
| `docs/` | 운영 가이드, 트러블슈팅, 용어집 |

## Domain Routes (API)
| Route | 타입 모듈 | 설명 |
|-------|-----------|------|
| `/api/azure/*` | `common.ts` | 구독/리소스 목록 |
| `/api/architecture/*` | `architecture.ts` | 리소스 토폴로지 |
| `/api/live-diagram/*` | `liveDiagram.ts` | 실시간 다이어그램 (ReactFlow) |
| `/api/health/*` | `health.ts` | 리소스 헬스 |
| `/api/network/*` | `network.ts` | NSG/네트워크 플로우 |
| `/api/cost/*` | `cost.ts` | 비용 분석 |
| `/api/security/*` | `security.ts` | 보안 점수/권고 |
| `/api/kubernetes/*` | `kubernetes.ts` | AKS 클러스터/워크로드 |
| `/api/observability/*` | `observability.ts` | Container Insights, Prometheus 메트릭 |
| `/api/hubble/*` | `hubble.ts` | Cilium Hubble 네트워크 플로우 |

## Web Pages
| 경로 | 설명 | Observability 하위탭 |
|------|------|---------------------|
| `/` | Overview 대시보드 | |
| `/architecture` | 리소스 토폴로지 | |
| `/live-diagram` | 실시간 다이어그램 | |
| `/health` | 리소스 헬스 | |
| `/network` | 네트워크 플로우 | |
| `/cost` | 비용 관리 | |
| `/security` | 보안 | |
| `/kubernetes` | AKS 관리 | |
| `/observability` | Observability 통합 | Overview, Workloads, Infra, Logs, Hubble Network |

## Commands
| Command | Action |
|---------|--------|
| `npm run dev` | 양쪽 앱 동시 시작 |
| `npm run build` | API tsc → Web next build |
| `npm run typecheck` | 양쪽 --noEmit |
| `scripts/gp.sh "<msg>"` | git add → commit → push (자동화) |

## Critical Files
- `packages/types/src/index.ts` — 전체 공유 타입 re-export
- `apps/api/src/routes/index.ts` — registerAllRoutes
- `apps/api/src/infra/oboTokenPool.ts` — OBO credential pool
- `apps/api/src/infra/cacheManager.ts` — LRU cache (bearer key prefix 패턴)
- `apps/api/src/env.ts` — Zod 환경변수 스키마

## Hubble (Cilium 네트워크 관측)
- **클라이언트**: `apps/api/src/services/hubbleClient.ts` — K8s exec → `hubble observe`
- **집계**: `apps/api/src/services/hubbleCollector.ts` — Service Map, Network, Security 집계
- **타입**: `packages/types/src/hubble.ts`
- **AKS 환경**: Cilium 1.17+ (`cilium-dbg`, `hubble` 바이너리 분리)
- **접근 전략**: cilium pod → `hubble observe` (로컬 소켓 `/var/run/cilium/hubble.sock`)
- **트러블슈팅**: `docs/hubble-troubleshooting.md`

## Env
`.env.example` 참조. 필수: `AZURE_AD_*`, `AZURE_SUBSCRIPTION_IDS`
Hubble: `HUBBLE_ENABLED`, `HUBBLE_RELAY_NAMESPACE`, `HUBBLE_RELAY_PORT`, `HUBBLE_FLOW_LIMIT`

## Coding Patterns
- **타입 추가 흐름**: `packages/types/src/<domain>.ts` → `index.ts` re-export → API/Web에서 import
- **API 라우트 추가**: `routes/<domain>.ts` 생성 → `routes/index.ts`에 등록
- **캐시**: `CacheManager` + `bearerKeyPrefix(token)` 패턴 (사용자별 캐시 격리)
- **인증**: MSAL (Web) → Bearer token → OBO (API) → Azure SDK
- **UI 텍스트**: 한국어 기본 (i18n: `useI18n()`)
- **스타일**: CSS Modules (`styles.module.css`)

## Docs
| 경로 | 내용 |
|------|------|
| `docs/getting-started/` | setup-guide, azure-integration-guide |
| `docs/architecture/` | GLOSSARY (용어집) |
| `docs/observability/` | instrumentation-guide, hubble-guide, hubble-troubleshooting |
| `docs/troubleshooting/` | error-catalog (도메인별 에러 통합) |

## Session Rules
- 기능 단위로 세션 분리 (10~15턴).
- `/compact` = 수동 컨텍스트 압축 (8~10턴 기점).
- 파일 수정 전 반드시 Read → 내용 확인 후 Edit.
- typecheck (`npx tsc --noEmit`) 수정 후 항상 실행.
- subagent: 세션당 최대 2개 (Explore/Plan 타입만).

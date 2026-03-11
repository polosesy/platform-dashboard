# CLAUDE.md

## Project
Azure Unified Dashboard — TypeScript monorepo. Enterprise Azure Operations Platform.

## Structure
| Path | Role |
|------|------|
| `packages/types/` | `@aud/types` — 공유 타입 (11 domain modules) |
| `apps/api/` | Express 4 (port 4000) — Azure SDK, Zod, OBO auth |
| `apps/web/` | Next.js 16 (port 3000) — React 19, ReactFlow, MSAL |
| `apps/api/src/infra/` | OBOTokenPool, CacheManager, AzureClientFactory |
| `apps/api/src/routes/` | 도메인별 라우트 (index.ts 오케스트레이터) |
| `apps/api/src/middleware/` | subscriptionContext, requestId |

## Commands
| Command | Action |
|---------|--------|
| `npm run dev` | 양쪽 앱 동시 시작 |
| `npm run build` | API tsc → Web next build |
| `npm run typecheck` | 양쪽 --noEmit |

## Critical Files
- `packages/types/src/index.ts` — 전체 공유 타입 re-export
- `apps/api/src/routes/index.ts` — registerAllRoutes
- `apps/api/src/infra/oboTokenPool.ts` — OBO credential pool
- `apps/api/src/infra/cacheManager.ts` — LRU cache
- `apps/api/src/env.ts` — Zod 환경변수 스키마

## Env
`.env.example` 참조. 필수: `AZURE_AD_*`, `AZURE_SUBSCRIPTION_IDS`

## Session Rules
- `skill.md` 항상 로드. 기능 단위로 세션 분리 (10~15턴).
- `/compact` = 수동 트리거 (세션 중반 8~10턴 기점).
- 세션 종료 전 `SESSION_SUMMARY.md` 업데이트.
- subagent: 세션당 최대 2개 (Explore/Plan 타입만).

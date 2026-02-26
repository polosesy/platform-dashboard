# CLAUDE.md

## Project

Azure Unified Dashboard — TypeScript monorepo. Enterprise Azure Operations Platform.

## Structure

| Path | Role |
|------|------|
| `packages/types/` | `@aud/types` — 공유 타입 패키지 (11개 도메인 모듈) |
| `apps/api/` | Express 4 (port 4000) — Azure SDK, Zod, OBO auth |
| `apps/web/` | Next.js 16 (port 3000) — React 19, ReactFlow, MSAL |
| `apps/api/src/infra/` | OBOTokenPool, CacheManager, AzureClientFactory |
| `apps/api/src/routes/` | 도메인별 라우트 모듈 (index.ts 오케스트레이터) |
| `apps/api/src/middleware/` | subscriptionContext, requestId |

## Commands

| Command | Action |
|---------|--------|
| `npm run dev` | 양쪽 앱 동시 시작 (concurrently) |
| `npm run build` | API tsc → Web next build |
| `npm run typecheck` | 양쪽 --noEmit |

## Key Files

- `skill.md` — 프로젝트 skill 정의 (항상 먼저 로드)
- `packages/types/src/index.ts` — 전체 공유 타입 re-export
- `apps/api/src/routes/index.ts` — registerAllRoutes 오케스트레이터
- `apps/api/src/infra/oboTokenPool.ts` — OBO credential 중앙 풀
- `apps/api/src/infra/cacheManager.ts` — LRU 캐시 + bearerKeyPrefix
- `apps/api/src/infra/azureClientFactory.ts` — Azure SDK 클라이언트 팩토리
- `apps/api/src/env.ts` — Zod 환경변수 스키마

## Env

`.env.example` 참조. 필수: `AZURE_AD_*`, `AZURE_SUBSCRIPTION_IDS`

## Common-Skill

공통 skill 모듈: `c:\Users\User\workspace\common-skill\`
- Always load: `core/coding-standards.md`, `token-strategy/optimization.md`
- On-demand: `master-skill.md` Module Map 참조

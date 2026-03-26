# 에러 카탈로그

> 프로젝트 전체에서 발생한 주요 에러 케이스, 원인, 해결 방법을 도메인별로 정리한 문서입니다.
> 새로운 에러 발생 시 해당 도메인 섹션에 추가합니다.

---

## 목차

1. [Hubble (Cilium 네트워크)](#1-hubble-cilium-네트워크)
2. [Observability (Container Insights / Prometheus)](#2-observability)
3. [Azure 인증 / OBO](#3-azure-인증--obo)
4. [Kubernetes API](#4-kubernetes-api)
5. [프론트엔드 (Next.js / React)](#5-프론트엔드)

---

## 1. Hubble (Cilium 네트워크)

> 상세: [observability/hubble-troubleshooting.md](../observability/hubble-troubleshooting.md)

### HUB-001: exec 500 에러
- **에러**: `{"error":"service_map_failed","message":"exec failed: command terminated with exit code 1"}`
- **원인**: cilium-agent pod에서 `hubble observe --server relay:443` 실행 시 mTLS 인증 실패
- **해결**: 로컬 소켓(`/var/run/cilium/hubble.sock`) 경유 전략으로 변경

### HUB-002: `cilium hubble` 명령 불가
- **에러**: `unknown command "hubble" for "cilium-dbg"`
- **원인**: Cilium 1.17에서 CLI 리네이밍 (`cilium` → `cilium-dbg`, `hubble` 별도 바이너리)
- **해결**: `cilium hubble observe` → `hubble observe` 직접 호출

### HUB-003: TLS 플래그 미지원
- **에러**: `unknown flag: --tls-allow-server-name`
- **원인**: AKS 포함 hubble CLI 버전에 해당 플래그 없음
- **해결**: TLS 플래그 제거, 로컬 소켓 우선 전략

### HUB-004: flows 0건 (Hubble 활성 상태)
- **증상**: `Hubble: Ok, Flows/s: 43.63` 이지만 UI에 0건
- **원인**: `cilium hubble observe` 명령 에러가 stdout으로 출력 → JSON 파싱 실패 → 0건
- **해결**: `hubble observe` 직접 호출 + 파싱 에러 로깅 강화

### HUB-005: Source/Destination "unknown"
- **증상**: Flows 탭에서 source/destination이 "unknown"
- **원인**: Cilium reserved identity (host, world, remote-node)는 namespace/podName 없음
- **해결**: `parseEndpoint`에서 reserved identity 라벨 + `workloads` 배열로 이름 매핑

---

## 2. Observability

### OBS-001: KQL SEM0525 타입 불일치
- **에러**: `column_ifexists` 함수의 int/string coalesce 타입 에러
- **원인**: AMA agent 버전에 따라 ContainerLogV2 스키마가 다름 (일부 컬럼 int vs string)
- **해결**: `column_ifexists(colName, defaultValue)` 사용 시 동일 타입 기본값 지정

### OBS-002: Workspace 자동 탐색 실패
- **에러**: `Log Analytics workspace not found for cluster`
- **원인**: AKS 클러스터에 Container Insights 미연동 또는 `AZURE_OBSERVABILITY_ENABLED` 게이트
- **해결**: workspace 자동 탐색 로직 추가, `AZURE_OBSERVABILITY_ENABLED` 게이트 제거

### OBS-003: ContainerLogV2 스키마 호환성
- **에러**: KQL 쿼리 실패 (`column not found`)
- **원인**: AMA agent 유무에 따라 `ContainerLogV2` vs `ContainerLog` 테이블 차이
- **해결**: `ContainerLogV2` 우선 조회 → 실패 시 `ContainerLog` fallback

---

## 3. Azure 인증 / OBO

### AUTH-001: AADSTS65001 — 동의 누락
- **에러**: `AADSTS65001: The user or administrator has not consented to use the application`
- **원인**: API App Registration에 대한 admin consent 미완료
- **해결**: Azure Portal → App Registration → API Permissions → Grant admin consent

### AUTH-002: OBO 토큰 교환 실패
- **에러**: `AADSTS50013: Assertion failed signature validation`
- **원인**: API와 Web의 App Registration audience/scope 불일치
- **해결**: API의 `AZURE_AD_API_SCOPE`와 Web의 `loginRequest.scopes` 일치 확인

### AUTH-003: ECONNRESET
- **에러**: `read ECONNRESET` (Azure SDK 호출 시)
- **원인**: 네트워크 불안정 또는 Azure 서비스 일시적 장애
- **해결**: OBO token pool에 retry 로직 포함, 요청 타임아웃 설정

---

## 4. Kubernetes API

### K8S-001: Kubeconfig 획득 실패
- **에러**: `Failed to get cluster credentials`
- **원인**: Service Principal에 AKS `Azure Kubernetes Service Cluster User Role` 미할당
- **해결**: RBAC 역할 할당 확인 (`az role assignment list`)

### K8S-002: Pod exec 타임아웃
- **에러**: exec 명령이 30초 후 타임아웃
- **원인**: 대상 pod가 응답하지 않거나 컨테이너 이름이 잘못됨
- **해결**: 컨테이너 이름 자동 감지 로직 + 타임아웃 시 부분 결과 반환

---

## 5. 프론트엔드

### FE-001: 인증 토큰 fetch 패턴
- **증상**: API 호출 시 401 에러
- **원인**: `useApiToken` hook의 토큰 갱신 타이밍 이슈
- **해결**: `getApiToken()` → Bearer token 패턴으로 통일

### FE-002: Sidebar 메뉴 미등록
- **증상**: 새 페이지가 네비게이션에 표시되지 않음
- **원인**: `Sidebar.tsx`의 `sections` 배열에 항목 미추가
- **해결**: `Sidebar.tsx` sections 배열에 해당 href/label/icon 추가

---

## 에러 추가 가이드

새로운 에러 발견 시 아래 포맷으로 추가:

```markdown
### [도메인]-[번호]: 간략 제목
- **에러**: 에러 메시지 (코드 블록)
- **원인**: 근본 원인 1줄
- **해결**: 해결 방법 1줄
```

도메인 접두사: `HUB` (Hubble), `OBS` (Observability), `AUTH` (인증), `K8S` (Kubernetes), `FE` (프론트엔드), `NET` (Network), `COST` (Cost), `SEC` (Security)

---

*최종 업데이트: 2026-03-26*

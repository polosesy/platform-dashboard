---
status: current
owner: platform-auth
last-verified: 2026-10-30
---
# 수집하는 데이터

> **대상**: 고객 보안·개인정보 검토자 · **소요 시간**: 읽기 3분

## 7. 수집하는 데이터

| 원천 | 읽는 것 | 저장 |
|---|---|---|
| Resource Graph / ARM | 리소스 구성(이름·종류·위치·태그·네트워크 속성), 구독 이름 | API 메모리 캐시(기본 수 분) |
| Azure Monitor | 메트릭 값, 알림, Resource Health, 알림 규칙 | 메모리 캐시 |
| Log Analytics | Traffic Analytics 흐름 집계, Container Insights, 진단 로그(선택한 쿼리 결과만) | 메모리 캐시 |
| Defender for Cloud | 보안 점수·권고·경고·규정 준수 | 메모리 캐시 |
| Cost Management | 비용 집계·예산·예약 | 메모리 캐시 |
| AKS API | 클러스터 객체 목록, Pod 로그(운영자), Hubble 흐름 | 메모리 캐시(로그는 요청 시에만) |
| 공개 취약점 출처 (보안 › 긴급 취약점) | CVE.org 기록(CVE Services), CISA KEV 목록, NVD 점수(보조), nodejs.org·php.net 보안 공지와 릴리스 목록, OSV.dev 패키지 대조 결과 | 메모리 캐시(피드 6시간, CVE.org·OSV·NVD 24시간) |

- **AKS 보안 점검 › 네트워크 노출**(관측 트래픽의 목적지 이름 붙이기): Resource Graph로 Private Endpoint와 그 NIC의 사설 IP, PaaS의 공용 액세스·네트워크 규칙·키 인증 설정을 읽고, 규칙이 하위 리소스에 있는 유형(PostgreSQL·MySQL·SQL·Redis·Mongo vCore 방화벽 규칙, Event Hubs·Service Bus 네트워크 규칙 세트, Azure Managed Redis 데이터베이스)은 ARM GET으로 읽습니다(공용 액세스가 꺼진 리소스는 읽지 않음, 최대 40개). 응답에는 **규칙 개수와 허용 VNet의 `vnet/서브넷` 이름만** — 허용 IP 값은 보내지 않습니다. 이름이 없는 공용 IP는 Microsoft **서비스 태그**(ARM Service Tag Discovery API, 클러스터 리전)로만 이름을 붙입니다 — Microsoft 공개 데이터라 리전별로 24시간 공유 캐시
- **AKS 모니터링 › 노드 · 라이브 다이어그램 AKS 패널**(노드 유지 보수): 클러스터 리소스 그룹과 노드 리소스 그룹의 **Activity Log**(작업 이름·상태·시각·대상 리소스, 최대 30일)와 클러스터의 자동 업그레이드 채널·노드 풀·`maintenanceConfigurations`를 읽습니다. 작업한 사람·앱의 이름은 응답에 넣지 않고 **종류만**(AKS 자동·사용자·앱) 보냅니다. 노드 cordon·NotReady·재등록·커널/kubelet 버전과 다시 시작된 파드 수는 클러스터의 Azure Monitor 작업 영역(kube-state-metrics)에서 읽습니다.
- **Azure 데이터는 저장소에 쓰지 않습니다.** API를 재시작하면 캐시는 사라집니다. 라이브 다이어그램 스펙은 메모리에 사용자별로 보관됩니다.
- **예외 — 팀 배치**: `AUD_ARRANGEMENT_DIR`을 설정하면 인프라 구성도의 게시된 배치가 구독마다 `<subscriptionId>.json` 하나로 저장됩니다(순서·칸·연결선 — 리소스 ID·이름을 담고 메트릭은 없음, 작성자는 표시 이름만). 설정하지 않으면 메모리.
- **예외 — 이슈 상태**(통합 위험 › 이슈 목록): 팀이 정한 상태만 구독마다 `<subscriptionId>.json` 하나로 저장됩니다 — 이슈 키(출처·`리소스 그룹/클러스터`·점검 ID), 상태(열림·진행·예외·해결 표시), 메모·담당(자유 텍스트, 500·100자), 예외 끝나는 날, 변경 기록 20개(시각·**표시 이름**, 개체 ID 아님). 이슈 내용·Azure 데이터는 저장하지 않습니다(매번 출처에서 다시 계산). 위치 `AUD_ISSUE_STATE_DIR` → 없으면 `<AUD_ARRANGEMENT_DIR>/issues` → 없으면 메모리.
- **캐시 공유 범위**: 플랫폼 자격 증명으로 읽은 데이터는 **같은 연결 집합을 쓰는 사용자끼리** 공유됩니다(`c:home,custa` — 같은 자격 증명으로 읽은 같은 데이터이므로). `delegated`(OBO) 연결이 섞이면 사용자별로 분리합니다(`u:{tid}:{oid}`).
- **응답에서 가리는 것**: 오류 메시지의 구독 ID·GUID, AAD 추적 ID, 앱 이름은 응답·화면에 나가지 않습니다. 화면에는 테넌트·구독 GUID 대신 연결 키·표시 이름을 씁니다.
- **밖으로 나가는 것(긴급 취약점)** — 고정된 공식 주소만, https, 다른 주소로 리디렉션되면 거부:
  - `www.cisa.gov`·`nodejs.org`·`www.php.net`: GET만, 보내는 값 없음
  - `cveawg.mitre.org`(CVE.org)·`services.nvd.nist.gov`: **CVE 번호**만
  - `api.osv.dev`(OSV): **패키지 이름·버전 목록** — 이 대시보드의 npm·OS 패키지, 클러스터의 Kubernetes 버전, 알려진 오픈소스 이미지(cilium·argo-cd 등)의 Go 모듈·버전. 고객 앱 이미지 이름·테넌트·리소스 이름은 보내지 않습니다. 이것만 끄려면 `AUD_ADVISORY_OSV=false`(이 탭이 비고 공지·KEV는 그대로)
  - 폐쇄망은 `AUD_ADVISORY_FEEDS=false`(차트 `features.advisoryFeeds: false`) — 모두 끄고 Defender 결과와 대시보드 자체 버전만으로 판정
  - 로그인한 사용자에게만 정확한 버전(실행 환경·구성 요소 목록)을 보여 줍니다.
- **감사 로그**(`AUD_AUDIT_LOG=stdout`, 프로덕션 기본): 요청마다 시각·요청 ID·사용자 `oid` 마지막 4자리·역할·연결 키·경로·상태 코드. 토큰·쿼리 문자열·본문·전체 GUID는 남기지 않습니다.

> **5살 비유**: 창고를 들여다보고 칠판에 잠깐 적어 둘 뿐, 공책에 옮겨 적지 않아요. 칠판은 몇 분마다 지워지고, 놀이공원 문을 닫으면 전부 지워져요.

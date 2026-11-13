---
status: current
owner: platform
last-verified: 2026-11-13
covers: [deploy/helm/aud-dashboard, deploy/kubernetes, docs/integrations/azure/templates/aks]
---
# Kubernetes(AKS) 배포 — 클러스터 안 네임스페이스

대시보드를 **관찰 대상 AKS 클러스터 안**(자기 네임스페이스 `aud-dashboard`)에 둡니다. 프라이빗·Entra 전용 클러스터에서도 네트워크 공사 없이 API 서버에 닿고(같은 VNet·DNS), 비밀 값 없이 Azure를 읽습니다(워크로드 ID 페더레이션). 온프레미스 Docker([container.md](./container.md))와 같은 이미지·같은 파드 구성입니다.

> **5살 비유**: 클러스터는 담장 안 놀이터예요. 대시보드를 담장 밖에 두면 문(API 서버)을 못 찾아요. 그래서 놀이터 안에 **자기 방(네임스페이스)**을 하나 받고, 비밀번호 대신 **얼굴 인식(페더레이션)**으로 출입증을 받아요. 놀이터 규칙(Gatekeeper·네트워크 정책)은 그대로 지켜요.

## 1. 개요

| 무엇 | 어디 |
|---|---|
| Helm 차트 (원본) | [`deploy/helm/aud-dashboard`](../../deploy/helm/aud-dashboard/) — 값은 모두 자리표시자, 의존성 없음(오프라인 설치) |
| 평문 매니페스트 (생성물) | [`deploy/kubernetes/aud-dashboard.yaml`](../../deploy/kubernetes/aud-dashboard.yaml) = 차트 렌더 (`scripts/render-k8s.sh`) + [`namespace.yaml`](../../deploy/kubernetes/namespace.yaml) |
| 클러스터 읽기 권한 | [`templates/aks/aud-dashboard-reader.yaml`](../integrations/azure/templates/aks/aud-dashboard-reader.yaml) (list만 — 코드에서 생성, 차트에 넣지 않음) |
| 서비스 계정·페더레이션 주체 | [`templates/aks/aud-dashboard-serviceaccount.yaml`](../integrations/azure/templates/aks/aud-dashboard-serviceaccount.yaml) |

차트가 원본이고 평문 매니페스트는 렌더 결과입니다 — 둘이 어긋나면 `apps/api/test/deployChart.test.ts`가 실패합니다(helm이 있을 때).

## 2. 동작 방식

```
브라우저 ─HTTPS─▶ (Front Door/WAF) ─▶ 게이트웨이 HTTPRoute ─▶ Service :80 ─▶ 파드 web :3000
                                                                          └─ /api ─▶ api 127.0.0.1:4000
api ─ 서비스 계정 토큰(웹후크가 api 컨테이너에만 투영) ─▶ Entra
     ├ 홈 테넌트 플랫폼 신원 (AUD_PLATFORM_CREDENTIAL=workloadIdentity)
     └ 고객 연결 앱/관리 ID (connections.json federation:{kind:"kubernetes"})
api ─▶ ARM listClusterUserCredential ─▶ privateFQDN(클러스터 DNS) ─▶ API 서버 (list 전용 ClusterRole)
```

- **페더레이션 주체는 하나**: `system:serviceaccount:aud-dashboard:aud-dashboard`. 차트가 `AUD_PLATFORM_FEDERATION_SUBJECT`로 같은 값을 넣고, 연결 점검(관리자)이 고객 앱용 FIC JSON을 이 값으로 보여 줍니다.
- 클러스터 테넌트가 홈 테넌트와 다르면(고객 클러스터) FIC가 **두 개**: 홈 플랫폼 신원 + 고객 연결 신원. 같은 테넌트면 플랫폼 신원 하나로 충분합니다.

## 3. 준비물

| 누가 | 무엇 |
|---|---|
| 클러스터 소유자 | OIDC 발급자·워크로드 ID 켜기(`--enable-oidc-issuer --enable-workload-identity`), 네임스페이스 생성([`namespace.yaml`](../../deploy/kubernetes/namespace.yaml), PSA restricted) |
| 이미지 담당 | 이미지를 클러스터가 쓰는 레지스트리에 — 런타임 기본 이미지는 고객 하드닝 이미지(`--build-arg NODE_BUILD_IMAGE/NODE_RUNTIME_IMAGE`), 태그는 정확히(`<semver>-<sha7>`, digest 고정) |
| 홈 테넌트 관리자 | 플랫폼 신원(aud-api 앱 또는 홈 구독의 사용자 할당 관리 ID)에 FIC, SPA 리디렉션 URI `https://<host>/`, 사용자 앱 역할(`AUD.*`) |
| 고객 테넌트 관리자 | 연결 신원(앱 또는 관리 ID) + FIC + Azure 역할([permissions.md](../integrations/azure/permissions.md)) |
| 클러스터 소유자 (GitOps) | `aud-dashboard-reader` ClusterRoleBinding(주체 = 연결 신원 **개체 ID**) |
| 네트워크 담당 | 게이트웨이 경로·호스트 이름, 송신 허용(아래 §6) |

## 4. 설정 — GitOps

차트 그대로 쓰는 경우: 환경별 `values-<env>.yaml`에 실제 값을 넣고 `helm template`/ArgoCD로 배포합니다. 키는 [`values.yaml`](../../deploy/helm/aud-dashboard/values.yaml) 주석에 있습니다.

| 값 | 내용 |
|---|---|
| `image.repository`·`tag`·`digest` | 클러스터 레지스트리의 정확한 이미지 |
| `serviceAccount.clientId`·`tenantId` | **홈** 플랫폼 신원 (`tenantId`가 없으면 웹후크가 클러스터 테넌트를 넣음) |
| `sso.*`·`host` | 로그인 앱·API 앱·호스트(https 리디렉션·CORS) |
| `homeSubscriptionIds` | 홈 연결 구독만 — 고객 구독은 `connections`에 (중복 거부) |
| `platform.oidcIssuer` | 표시용 — 연결 점검의 FIC JSON |
| `connections` | 연결 파일 JSON (ID·이름만) |
| `gateway.*`·`healthCheckPolicy` | HTTPRoute(선택 `frontDoorId` — `X-Azure-FDID` 헤더가 맞을 때만 통과)·AGC 헬스 프로브 |
| `networkPolicy.*` | CiliumNetworkPolicy — 처음엔 `enforce: false`(이름 `-audit`, 기본 거부 없음) |

**ArgoCD가 클러스터 레지스트리의 OCI 차트만 읽는 환경**(외부 Git·차트 저장소 차단): 이 차트를 고객 GitOps 저장소에 벤더링(래퍼 차트 + `charts/aud-dashboard-<ver>.tgz`, `repository: ""`)하거나 템플릿을 복사하고, 고객 파이프라인이 OCI로 게시합니다. 동기화 순서는 차트의 sync-wave(설정 −1 → 워크로드 0 → 경로 1), 네임스페이스·네트워크 정책·RBAC는 보통 고객 저장소의 아래 계층(정책 트랙)이 먼저 적용합니다.

## 5. 설정 — Portal / CLI

```bash
# 클러스터 OIDC 발급자 (FIC issuer)
az aks show -g <rg> -n <cluster> --query oidcIssuerProfile.issuerUrl -o tsv
# 홈 플랫폼 신원 FIC (사용자 할당 관리 ID 예)
az identity federated-credential create -g <home-rg> --identity-name <home-uami> -n fed-<cluster-alias>-aud-dashboard \
  --issuer <issuer> --subject system:serviceaccount:aud-dashboard:aud-dashboard --audiences api://AzureADTokenExchange
```

고객 연결 앱의 FIC는 [`fic.sh`](../integrations/azure/templates/service-principal/fic.sh)·[`fic.tf`](../integrations/azure/templates/service-principal/fic.tf)·[`fic-kubernetes.json`](../integrations/azure/templates/service-principal/fic-kubernetes.json) (같은 주체).

## 6. 권한·보안

- 파드: 65532, `runAsNonRoot`, 읽기 전용 루트, `drop ALL`, `allowPrivilegeEscalation: false`, seccomp RuntimeDefault, `automountServiceAccountToken: false`(Kubernetes API 토큰 없음 — 클러스터 읽기는 Entra 토큰), CPU 제한 없음(메모리 제한만). PSA restricted 통과.
- 비밀 값 없음: 연결 파일은 ID·이름만, 토큰은 웹후크가 api 컨테이너에만 투영(`skip-containers: web`).
- 클러스터 권한은 list만 — Secret·ConfigMap·exec·쓰기 없음. Pod 로그·Hubble exec는 opt-in([aks.md](../integrations/azure/aks.md)). exec 없이 Hubble 화면은 ACNS 흐름 로그 또는 Hubble 메트릭(Managed Prometheus)으로 동작 — 고객 연결 신원에 그 작업 영역의 Monitoring Data Reader, 흐름 로그는 Log Analytics Reader(클러스터 리소스 범위).
- 송신(443): `login.microsoftonline.com`·`management.azure.com`·`api.loganalytics.io`·`*.<region>.prometheus.monitor.azure.com`·`azure.status.microsoft`·`rssfeed.azure.status.microsoft` + 긴급 취약점 출처 `www.cisa.gov`·`services.nvd.nist.gov`·`nodejs.org`·`www.php.net`·`cveawg.mitre.org`·`api.osv.dev`(`features.advisoryFeeds`, 끄면 정책에서도 빠지고 `AUD_ADVISORY_FEEDS=false`; OSV로 패키지 목록을 보내는 것만 끄려면 `AUD_ADVISORY_OSV=false`) + kube-dns·API 서버. IMDS·레지스트리는 필요 없음. Kubernetes 클라이언트는 `HTTPS_PROXY`를 쓰지 않음.
- 사용자 접근: 게이트웨이 앞 WAF/IP 제한 + 앱 역할(역할 없으면 403 `no_platform_role`).
- DNS: 파드 `dnsConfig` `ndots: "1"`(값 `dnsConfig`, `null` = 클러스터 기본). 송신 이름이 모두 점 2개 이상인 외부 이름이라 그대로 먼저 물음 — 조회 1번에 질의 2개(A·AAAA). 기본 `ndots:5`는 검색 접미사 4개(`<ns>.svc.cluster.local`·`svc.cluster.local`·`cluster.local`·노드의 `*.internal.cloudapp.net`)를 먼저 붙여 질의 10개(8개 NXDOMAIN), 중간값 21ms → 7ms(2026-10-23 Hubble로 측정). 이름 끝에 점(`management.azure.com.`)은 대안이 아님 — ARM·Entra가 TLS를 끊음(ECONNRESET). IPv4 전용 클러스터는 `{ name: no-aaaa }`(glibc 2.36+)를 더할 수 있음(선택).
- API 서버 연결은 재사용하지 않음: `@kubernetes/client-node` 1.x가 쓰는 node-fetch 2는 살아 있는 소켓의 chunked(gzip) 응답에 거짓 "Premature close"를 냄 — keep-alive 에이전트 풀을 넣었다가 목록 5/20개가 비어 '클러스터 데이터 일부 누락'이 났음(2026-10-23, 되돌림). DNS 비용은 ndots 1로 낮게 유지, 일시 오류(연결 끊김·429·5xx)는 목록마다 한 번 재시도(`infra/k8sRetry.ts`).

## 7. 수집 데이터

온프레미스와 같습니다 — [data-collected.md](../integrations/azure/data-collected.md). 파드에 남는 것은 emptyDir(`/tmp`, Next 캐시)뿐이고 재시작하면 사라집니다(팀 배치·이슈 상태는 `AUD_ARRANGEMENT_DIR`·`AUD_ISSUE_STATE_DIR`이 없으면 메모리 — 화면에 '서버 메모리에만 저장' 경고).

## 8. 확인

```bash
kubectl -n aud-dashboard get deploy,po,svc,cm,sa,pdb
kubectl -n aud-dashboard logs deploy/aud-dashboard -c api | grep "platform credential"   # → workloadIdentity
kubectl auth can-i list pods --as <connection-object-id>          # yes
kubectl auth can-i get secrets --as <connection-object-id>        # no
```

화면: 설정 › Azure 연결 › 점검(관리자) — 자격 증명 '페더레이션', 클러스터 점검 reach·entra·clusterUserRole ok, 읽기 규칙 전부 ok, Secret·exec 경고 없음.

### 시험 배포 — 프라이빗 클러스터에 GitOps 없이 올리고 로컬 포트 포워딩으로 보기

정식 경로(GitOps)에 앞서 하루짜리 시험을 할 때의 순서입니다(실제로 해 본 절차 — 값은 자리표시자).

1. **이미지**: 레지스트리 방화벽이 허용 IP만 받으면 `az acr build`(ACR Tasks)는 거부될 수 있습니다(실행기 IP가 목록에 없음 — '신뢰할 수 있는 서비스 허용'은 Tasks를 포함하지 않음). 그때는 Docker 엔진이 있는 곳(온프렘 서버 `scripts/onprem.sh build`)에서 빌드 → `docker save`(OCI 레이아웃 tar) → **허용된 IP의 PC**에서 [`crane`](https://github.com/google/go-containerregistry) `push <폴더>` (토큰은 `az acr login --expose-token` → `crane auth login --password-stdin`, 임시 `DOCKER_CONFIG`에 두고 끝나면 삭제). 시험 이미지는 별도 경로(`test/aud-dashboard`)에.
2. **신원**: 고객 쪽 연결 = 사용자 할당 관리 ID + FIC(주체 `system:serviceaccount:aud-dashboard:aud-dashboard`) — 구독 Owner로 만들 수 있음(앱 등록 FIC와 달리 Entra 앱 관리자 불필요). 역할은 **필요한 리소스 그룹에만**(한 구독에 운영 리소스도 있으면 구독 전체 Reader 금지), 클러스터 Cluster User Role, 작업 영역 Log Analytics Reader. 시험에서 홈 연결을 쓰지 않으면 `homeSubscriptionIds: ""` + SA `client-id`·`tenant-id` = 고객 관리 ID(홈 읽기만 실패, 고객 클러스터 화면은 비밀 없이 동작).
3. **클러스터 적용**: PC가 프라이빗 API에 못 닿으면 `az aks command invoke --file`(관리자 그룹 멤버)로 `namespace.yaml` → `aud-dashboard-reader.yaml`(주체 = 관리 ID의 **principalId**) → `helm template … -f values-test.yaml` 결과(`--dry-run=server` 먼저). command invoke의 실행 계정은 impersonate 권한이 없어 `kubectl auth can-i --as`는 4번의 kubectl로 확인.
4. **로컬 포트 포워딩**: Bastion의 IP 연결 터널은 22·3389만 허용 → **점프박스를 SSH 경유지로**: `az network bastion tunnel --target-resource-id <점프박스> --resource-port 22 --port 2222` → `az ssh vm --ip 127.0.0.1 --port 2222 -- -N -L 8443:<API 서버 PE IP>:443`(VM Administrator/User Login) → kubeconfig 서버 `https://127.0.0.1:8443` + `--tls-server-name=<privateFQDN>` + `kubelogin convert-kubeconfig -l azurecli` → `kubectl -n aud-dashboard port-forward svc/aud-dashboard 3000:80`. 점프박스에는 아무것도 설치하지 않음.
   - 이 과정은 `scripts/aks-test.sh connect`(PowerShell: `.\scripts\aks-test.ps1 connect` — PowerShell은 `.sh`를 직접 못 돌려 Git for Windows bash로 실행)가 한 번에 함. `check` = 같은 터널로 `/readyz` 한 번 보고 닫음. 이름은 gitignore된 `.secrets/aks-test.env`(`AUD_AKS_RG`·`AUD_AKS_NAME`·`AUD_BASTION_NAME`·`AUD_BASTION_RG`·`AUD_JUMPBOX_VM` …, 스크립트 머리 주석), 작업 파일(kubeconfig·known_hosts·로그·렌더링한 values)은 `.secrets/aks-test/`. 3000번을 쓰는 온프렘 터널·개발 서버를 먼저 끔. Ctrl-C로 닫을 때 Windows 프로세스 트리째 끝냄(`kill`만으로는 az·ssh가 남아 포트를 쥠). Bastion이 가끔 SSH 세션을 끊으면(`ssh.log` `client_loop: send disconnect: Connection reset` → `lost connection to pod`) `connect`가 세 구간을 다시 엶 — 1분 안에 5번 연속 끊기면 멈춤. 조건부 액세스가 몇 시간 뒤 `az` 로그인을 끝내면(`bastion.log` AADSTS70043) 다시 열 수 없어 'Azure 로그인 만료 — az login' 한 줄로 멈춤 → `az login` 후 `connect`.
   - **새 이미지로 바꿀 때**(시험 배포 재배포): `scripts/aks-test.sh deploy`(`connect`가 열려 있어야 함) 한 번 — 빌드(`onprem.sh build`) → `onprem.sh save` → 푸시(`scripts/oci-push.mjs`, 레지스트리 v2 API·`az acr login --expose-token` 토큰은 stdin) → 값의 `tag`·`digest` 한 줄 → `helm template` → `kubectl apply` → 롤아웃 → `/healthz` 버전 → `scripts/smoke.mjs`. 아래 함정마다 스크립트가 검사하고 틀리면 멈춤. 함정 세 가지(2026-11-12 실제로 겪음): ① **푸시 전에 풀어 둔 이미지가 방금 빌드한 것인지 확인** — 작업 폴더에 지난 이미지가 남아 있으면 옛 이미지가 새 태그로 올라가고 롤아웃도 '성공'으로 끝남(이미지 설정의 `AUD_VERSION`이 빌드 태그와 같은지 비교, 폴더는 매번 비우고 시작) ② **롤아웃 뒤 `/healthz`의 `version`이 새 빌드인지 확인** — 파드 이미지 태그만 보면 ①을 못 잡음 ③ 레지스트리 푸시가 중간에 끊기면 같은 명령을 다시 실행(이미 올라간 레이어는 건너뜀). 시험용 태그는 매번 새로(같은 태그 덮어쓰기 금지 — `digest` 고정이라 값이 어긋남). 잘못 올린 태그는 정리 때 함께 삭제.
   - 운영 모드라 **예시 데이터는 꺼져 있음** — 로그인 전에는 로그인 안내만 보이는 것이 정상(차트에 `AUD_SAMPLE_DATA` 값은 아직 없음, 데모가 필요하면 온프렘 문서 9절).
5. **로그인**: 값 `publicUrl: "http://localhost:3000"`(등록된 SPA 리디렉션과 정확히 같게) — 리디렉션·CORS 둘 다. 운영 모드라 테스트 사용자에게 앱 역할(`AUD.*`) 필요.
6. **정리**: 네임스페이스·ClusterRole/Binding → 역할 할당 → FIC → 관리 ID → 시험 이미지 경로. `scripts/aks-test.sh cleanup`('yes' 확인 후, 이름은 `AUD_TEST_IDENTITY`·`AUD_TEST_FIC`·`AUD_TEST_ACR`). GitOps 밖 수동 객체라 ArgoCD가 지우지 않음 — 시험 당일 정리.

### 배포 뒤 확인 — `scripts/smoke.mjs`

```bash
node scripts/smoke.mjs http://localhost:3000 --version <빌드 태그>     # 익명: 버전·준비 상태·닫혀 있어야 할 것
AUD_SMOKE_TOKEN=<API 액세스 토큰> node scripts/smoke.mjs http://localhost:3000   # + 로그인 상태의 주요 API
```

- 토큰 없이: `/healthz` 버전, `/readyz`, `/metrics`가 밖으로 안 나오는지(404), 로그인 설정이 실렸는지, 익명 API 6개가 401인지(예시 모드 배포는 `--sample` — 예시 표시가 있어야 통과).
- 토큰과 함께: 내 역할·구독·비용·리소스 상태·보안·구성도·알림·클러스터(구성·히트맵·앱 런타임·SLO·이벤트·관측 스택·노드·정책)를 GET으로 한 번씩 — 200이 아니거나 **예시 데이터가 로그인 사용자에게 오면 실패**, 403·429·501은 경고, 걸린 시간과 `gaps`·상태를 한 줄씩.
- 토큰은 브라우저가 보내는 것과 같은 것(`Authorization: Bearer`, 범위 `Azure.Read.All`)이고 환경 변수로만 읽습니다(출력·저장 안 함). 로그인 앱이 다른 테넌트에 있으면 `az account get-access-token`으로는 못 받습니다(AADSTS500011) — 그 테넌트로 로그인하거나 브라우저 세션의 토큰을 씁니다. **토큰이 없으면 로그인 부분은 '건너뜀'으로 적히고 통과로 세지 않습니다.**
- 화면이 실제로 그려지는지(브라우저 테스트)는 아직 없습니다 — [platform-roadmap.md](../architecture/platform-roadmap.md) 1절.

### 플랫폼 자체 지표 — `/metrics`

API가 자기 상태를 Prometheus 형식으로 냅니다: `aud_http_requests_total{route, method, status}`·`aud_http_request_duration_seconds`(경로는 패턴 — ID 없음), `aud_upstream_requests_total{target, result}`·`aud_upstream_request_duration_seconds`(Azure 호출 — `result` = HTTP 상태·`timeout`·`error`, 스로틀 429가 여기서 보임), `aud_build_info{version}`, 프로세스·이벤트 루프(`nodejs_version_info`가 있어 AKS 모니터링의 앱 런타임에 Node.js로 잡힘). 테넌트 데이터는 없습니다.

- API 포트(파드 안 루프백)의 `GET /metrics`는 `/api` 밖이라 웹을 통해 나가지 않습니다.
- 수집하려면 값 `metrics.enabled: true` → 지표만 답하는 포트(기본 9464)·`prometheus.io/*` 파드 주석·`AUD_METRICS_PORT`. 네트워크 정책을 쓰면 `metrics.fromNamespaces: ["<수집기 네임스페이스>"]`로 그 포트만 엽니다. 기본은 꺼짐(렌더 결과 변화 없음).
- **수집기 쪽 조건**(2026-11-13 시험 환경 확인): 고객 Alloy는 `prometheus.io/scrape: "true"` 파드를 모든 네임스페이스에서 수집하고 지표 이름도 거르지 않지만, Alloy의 송신 네트워크 정책이 허용한 네임스페이스로만 나갈 수 있습니다. `aud-dashboard`가 그 목록에 없으면 켜는 순간 매분 수집 시도가 POLICY_DENIED 드롭으로 쌓입니다 — **먼저 수집기 정책에 `aud-dashboard` 네임스페이스 :9464 송신 규칙**을 넣고 켜세요. Azure Monitor 관리형 수집(ama-metrics)의 주석 기반 수집은 `podannotationnamespaceregex`와 지표 허용 목록(`podannotations`)에 `aud_.*`가 있어야 합니다.
- 켜지 않고 확인: `kubectl -n aud-dashboard port-forward pod/<파드> 14000:4000` → `curl http://127.0.0.1:14000/metrics`(API 포트는 파드 루프백 — 포트 포워딩은 닿음).
- 온프렘 Docker는 `api.env`에 `AUD_METRICS_PORT`(파드 공간 안에서만 열림 — 밖으로 내보내려면 compose 포트를 따로 엽니다).

## 9. 문제 해결

| 증상 | 원인 → 조치 |
|---|---|
| `connection_federation_mismatch` (AADSTS700213) | FIC의 issuer/subject가 다름 → `system:serviceaccount:aud-dashboard:aud-dashboard`·이 클러스터 발급자로 |
| API 시작 실패 '토큰 파일 없음' | 파드 라벨 `azure.workload.identity/use` 또는 SA `client-id` 주석 누락 → 웹후크가 토큰을 안 넣음 |
| `cluster_dns_unresolved` | 파드가 이 클러스터 밖(다른 VNet)에 있음 — 같은 클러스터에 두거나 DNS 영역 링크 |
| `aks_rbac_forbidden` | ClusterRoleBinding 주체가 앱 ID(clientId) — **개체 ID**여야 함 |
| 브라우저 로그인 루프 | SPA 리디렉션 URI·`host` 불일치, 또는 http(MSAL은 https 필요) |
| 네트워크 정책 강제 후 끊김 | 관찰본(`-audit`)은 아무것도 버리지 않아 DROPPED로는 알 수 없음 → 아래 '관찰 → 강제' 목록이 빌 때까지 빠진 FQDN·API 서버 /32 추가 |
| 시작 직후 `getaddrinfo EAI_AGAIN` | DNS(또는 Cilium DNS 프록시)가 아직 준비 안 됨 — `dnsConfig`가 렌더링됐는지, Hubble DNS 기록 확인 |

### 관찰(`enforce: false`) → 강제 전환 판단

관찰본은 `enableDefaultDeny: false`라 Cilium이 '모두 허용(allow-any)' 규칙을 덧붙여 아무것도 버리지 않습니다. 일반 흐름(trace)에는 정책 일치가 없어 `policy-verdict:none`으로 보이고, 목적지 IP로 짐작하면 틀립니다. 대신 **새 연결마다 한 번 나오는 policy-verdict 이벤트**의 `egress_allowed_by`/`ingress_allowed_by`(Cilium 1.15+)를 봅니다(2026-10-23 AKS ACNS Cilium 1.19.8에서 확인):

| allowed_by | 일치 종류 | 강제하면 |
|---|---|---|
| 이름 있는 정책(`aud-dashboard-baseline-audit` …) | 2 (L3+L4) 등 | 통과 |
| `reserved:io.cilium.policy.derived-from=allow-any-egress`(또는 `-ingress`)만 | 4 (all) | **막힘** |
| `allow-localhost-ingress`(kubelet 프로브) | 1 | 통과(항상) |

화면: AKS 모니터링 › Hubble › 보안 '정책을 강제하면 막힐 연결'(Hubble exec가 켜진 연결만). exec가 꺼진 운영에서는 운영자가 직접:

```bash
for p in $(kubectl -n kube-system get po -l k8s-app=cilium -o name); do
  kubectl -n kube-system exec "$p" -c cilium-agent -- hubble observe --type policy-verdict     --namespace aud-dashboard --last 10000 -o jsonpb; done |
jq -r '.flow | select(.event_type.type==5) as $f
 | (if $f.traffic_direction=="EGRESS" then $f.egress_allowed_by else $f.ingress_allowed_by end) as $by
 | select($by != null and ($by|length)>0 and all($by[]; (.name//"")=="" and
     any(.labels[]?; test("derived-from=allow-any-(egress|ingress)$"))))
 | [$f.traffic_direction, ($f.source.workloads[0].name // $f.source.pod_name // $f.IP.source),
    (($f.destination_names//[])|join(",")), $f.IP.destination,
    (($f.l4.TCP.destination_port // $f.l4.UDP.destination_port)|tostring)] | @tsv' | sort | uniq -c | sort -rn
```

업무 주기 전체(배치·일일 작업 포함) 동안 결과가 비면 `networkPolicy.enforce: true`. 노드 버퍼는 새 연결만 담고 오래 열린 연결은 정책을 건 뒤 다시 열 때 판정되므로, 관찰본을 적용한 뒤 워크로드를 한 번 재시작하세요. DNS 이름이 비어 있는 world 목적지(하드코딩 IP)는 FQDN 규칙으로 허용할 수 없습니다. `allowed_by`가 아예 없으면 Cilium 1.15 미만 — 일치 종류(4 = 막힘)로만 추정합니다.

나머지는 [error-catalog.md](../troubleshooting/error-catalog.md).

## 10. 교체

새 이미지: `image.tag`·`digest`만 바꿔 동기화(롤링 업데이트 `maxUnavailable: 0`). 연결 파일 변경은 파드 주석 `checksum/connections`가 바뀌어 자동 재시작. 신원 교체는 새 FIC 추가 → 값 변경 → 옛 FIC 삭제.

## 11. 해제

애플리케이션 삭제 → 네임스페이스 삭제 → ClusterRoleBinding 삭제 → FIC 2개 삭제 → 역할 할당 제거. 셋(바인딩·Cluster User Role·FIC) 중 하나만 지워도 접근은 즉시 멈춥니다.

## 12. 보안 FAQ

- **관찰 대상 클러스터 안에 있어도 되나?** stg는 수용(클러스터가 멈추면 대시보드도 멈춤). 운영·다중 클러스터는 허브 VNet의 전용 실행 환경을 권장합니다.
- **`list pods`로 무엇이 보이나?** 파드 사양(환경 변수 리터럴 포함) — 앱은 비밀을 `secretKeyRef`로 두어야 합니다. Secret 자체는 읽지 않습니다.
- **단일 복제본인 이유?** 캐시·라이브 다이어그램이 메모리에 있습니다(재시작 시 다시 채움).

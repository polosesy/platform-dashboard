---
status: current
owner: platform-ops
last-verified: 2026-10-23
covers: [Dockerfile, deploy/docker, scripts/onprem.sh, apps/api/src/infra/lifecycle.ts]
---
# 컨테이너 배포 — 온프레미스 Docker → AKS

> **대상**: 플랫폼 운영자(온프레미스 서버), 고객 클러스터 담당자 · **소요 시간**: 30분(이미지 빌드 포함) · **필요한 것**: Docker Engine 24+ (Compose v2), 홈 테넌트 앱 등록 2개(웹 SPA·API), 플랫폼 신원 인증서

## 1. 개요

이미지 **하나**(`aud-dashboard:<tag>`)로 온프레미스 Docker와 AKS 파드를 모두 실행합니다. 환경마다 다른 값(로그인 앱 ID·호스트·연결 파일·인증서)은 이미지에 넣지 않고 실행할 때 줍니다.

> **5살 비유**: 도시락통(이미지)은 하나예요. 반찬(설정)은 먹는 곳(온프렘 서버·클러스터)에서 넣어요. 도시락통 안에는 칸이 두 개 있어요 — 손님이 보는 칸(웹 :3000)과 손님은 못 보는 안쪽 칸(API, 127.0.0.1:4000). 두 칸은 같은 뚜껑(네트워크 공간)을 써서 서로 바로 이야기해요.

## 2. 동작 방식

```
브라우저 ──https──▶ (nginx :8443, 선택) ──▶ web :3000 ──/api/*──▶ api 127.0.0.1:4000 ──▶ Azure (ARM·Log Analytics·Prometheus)
                                          └──────── 같은 네트워크 공간 (compose `pod` = 쿠버네티스 파드) ────────┘
```

| 컨테이너 | 명령 | 포트 | 하는 일 |
|---|---|---|---|
| `pod` | 대기 프로세스 | 3000 공개 | 네트워크 공간과 공개 포트를 가짐(쿠버네티스 pause 컨테이너 역할) — web·api가 재시작해도 공간이 유지됨 |
| `api` | `node /app/apps/api/dist/index.js` | 127.0.0.1:4000 (공개 안 함) | Azure 읽기·토큰 검증. 밖에서 직접 닿지 않음 |
| `web` | 기본 CMD (`node /app/web/apps/web/server.js`) | 0.0.0.0:3000 | 화면 + `/api/*`를 127.0.0.1:4000으로 넘김. 로그인 설정(`AUD_WEB_*`)을 **요청마다** 읽음 |

이미지 구조: `/app/apps/api/dist` + `/app/node_modules`(API 운영 의존성만) · `/app/web`(Next.js standalone). 모든 파일은 root 소유·읽기 전용, 실행 사용자 `65532:65532`.

## 3. 준비물

- Docker Engine + Compose v2 (Linux 컨테이너). Windows 개발 PC는 Docker Desktop 같은 엔진이 있어야 빌드됨(CLI만으로는 안 됨)
- Entra(홈 테넌트) 앱 등록 2개 — 웹 SPA(리디렉션 `https://<호스트>:8443/`, 개발은 `http://localhost:3000`), API(`api://<aud-api>`, 범위 `Azure.Read.All`, 앱 역할 AUD.Viewer·Operator·Admin) — [`../integrations/azure/sso.md`](../integrations/azure/sso.md)
- 플랫폼 신원 인증서(PEM, 개인 키 포함) — 비밀보다 권장. 역할 부여는 [`../integrations/azure/permissions.md`](../integrations/azure/permissions.md)
- HTTPS 인증서(사내 CA 가능) — **다른 PC에서 로그인하려면 필수**(MSAL은 https 또는 localhost에서만 동작)

## 4. 설정 — 자동 (온프레미스)

```bash
# 1) 이미지 (저장소 루트)
docker build -t aud-dashboard:$(git rev-parse --short HEAD) --build-arg AUD_VERSION=$(git rev-parse --short HEAD) .
node scripts/container-smoke.mjs --no-build --image aud-dashboard:$(git rev-parse --short HEAD)   # 12개 확인

# 2) 설정 (deploy/docker — *.env, config/, tls/ 는 gitignore)
cd deploy/docker
cp api.env.example api.env && cp web.env.example web.env      # 값 채우기
mkdir -p config tls
cp /secure/platform.pem config/platform.pem                    # 플랫폼 신원 인증서
cp /secure/connections.json config/connections.json            # 선택 — 없으면 홈 연결 하나
cp /secure/server.crt /secure/server.key tls/                  # HTTPS 인증서
sudo chgrp -R 65532 config tls && sudo chmod -R g+r config tls # 컨테이너 사용자(65532)가 읽을 수 있게

# 3) 실행
AUD_IMAGE=aud-dashboard:<tag> docker compose --profile tls up -d
docker compose ps                                              # pod·api·web·proxy 모두 healthy
```

| 변수 (compose 셸 환경) | 기본값 | 뜻 |
|---|---|---|
| `AUD_IMAGE` | `aud-dashboard:dev` | 실행할 이미지 |
| `AUD_HTTP_BIND` / `AUD_HTTP_PORT` | `127.0.0.1` / `3000` | 평문 http 공개 주소(기본은 서버 자신만 — 다른 PC는 https로) |
| `AUD_HTTPS_BIND` / `AUD_HTTPS_PORT` | `0.0.0.0` / `8443` | nginx(프로필 `tls`) |

## 5. 설정 — 작업 PC에서 원격으로 + 로컬 브라우저로 테스트 (SSH 터널)

**소스는 작업 PC에만 있습니다.** 작업 PC에서 [`scripts/onprem.sh`](../../scripts/onprem.sh) 하나로 빌드 → 기동 → 터널까지 하고, 서버에는 실행에 필요한 것(`~/aud-runtime`)만 남습니다. 서버에서 직접 운영할 때는 거기 설치되는 [`audctl`](../../deploy/docker/audctl)을 씁니다(`sudo ~/aud-runtime/audctl status`).

```
작업 PC (소스·git)                                   온프렘 서버
scripts/onprem.sh deploy ── tar 스트림(SSH) ──▶ ~/.aud-build.XXXXXX (0700, 임시)
                                                  │ sudo audctl build → docker build → aud-dashboard:<tag>
                                                  │ compose.yaml·nginx.conf·audctl → ~/aud-runtime
                                                  └ 임시 폴더 삭제 (trap — 실패·Ctrl-C에도)
                         ── sudo audctl up <tag> ─▶ ~/aud-runtime: compose up → readyz 확인 → 옛 이미지 정리
```

> **5살 비유**: 예전엔 서버에 **요리책(소스)**을 통째로 두고 요리했어요. 이제는 요리책은 집(작업 PC)에만 두고, 서버 부엌에 잠깐 빌려줬다가 **요리(이미지)가 끝나면 바로 회수**해요. 서버에는 완성된 요리와 **리모컨(audctl)**만 남아서, 서버에서도 리모컨으로 켜고·끄고·이전 요리로 되돌릴 수 있어요.

개발 PC에 Docker 엔진이 없어서 빌드는 서버에서 하지만, 빌드 재료는 임시 폴더(소유자만 읽기)에 몇 분만 있다가 지워집니다. 빌드 머신(Docker 엔진)이 생기면 거기서 빌드해 `docker save | ssh … docker load`로 이미지만 보내는 방식으로 바꿀 수 있습니다(서버에 빌드 재료가 아예 가지 않음).

> **PowerShell에서는** `.sh`를 직접 실행할 수 없습니다("'onprem.sh' 프로그램을 실행하지 못했습니다"). [`scripts\onprem.ps1`](../../scripts/onprem.ps1)이 Git for Windows의 bash로 같은 스크립트를 실행합니다 — 아래 `scripts/onprem.sh <명령>`은 PowerShell에서 `.\scripts\onprem.ps1 <명령>`으로 읽으세요(WSL의 `bash`는 경로·SSH 키가 달라 쓰지 않음).

> **5살 비유**: 서버의 가게(웹 3000)는 서버 안에서만 문을 열어요(127.0.0.1). SSH 터널은 내 PC에서 그 가게 문 앞까지 이어진 **비밀 통로**예요. 내 브라우저는 `localhost:3000`(내 집 주소)로 들어가는데, 실제로는 통로를 지나 서버 가게에 도착해요. 집 주소라서 로그인(MSAL)도 https 없이 허락돼요.

```
내 브라우저 ─▶ localhost:3000 ═══ SSH 터널(SSH 포트) ═══▶ 서버 127.0.0.1:3000 ─▶ web ─▶ api(127.0.0.1:4000)
```

**왜 터널인가**: 서버 방화벽·인증서를 바꾸지 않고, 웹이 서버 밖으로 열리지 않습니다(`AUD_HTTP_BIND` 기본 127.0.0.1). 그리고 Entra는 SPA 리디렉션에 `http://localhost`만 예외로 허용합니다 — 로컬 개발과 같은 `http://localhost:3000`을 그대로 씁니다.

**1) 연결 설정** — gitignore된 `.secrets/onprem.env` (또는 같은 이름의 환경 변수)

```bash
AUD_ONPREM_HOST=<서버 IP>
AUD_ONPREM_PORT=<SSH 포트>
AUD_ONPREM_USER=<계정>
AUD_ONPREM_KEY=.secrets/<개인 키>              # 키 로그인 (비밀번호 로그인은 쓰지 않음)
AUD_ONPREM_SUDO_PASSWORD_FILE=<파일>           # 선택 — 없으면 sudo가 터미널에서 물어봄
AUD_LOCAL_PORT=3000
```

**2) 배포** — 처음엔 **예시 데이터 모드**(서버에 비밀 값 없음, 로그인 꺼짐)

```bash
scripts/onprem.sh deploy        # 임시 폴더로 전송(추적 + 커밋 안 된 새 파일, gitignore 제외) → build(서버) → 임시 폴더 삭제 → up(예시 설정 자동 생성) → 준비 확인
scripts/onprem.sh status        # pod·api·web healthy, readyz {"ok":true}
```

**3) 터널 열고 브라우저로**

```bash
scripts/onprem.sh tunnel        # 그대로 둔 채(Ctrl-C로 닫음) 브라우저에서 http://localhost:3000
```

로컬 개발 서버가 3000을 쓰고 있으면 끄거나 `AUD_LOCAL_PORT=3100`(그 주소도 SPA 리디렉션에 등록 필요). Windows PowerShell에서 직접: `ssh -N -L 3000:127.0.0.1:3000 -p <SSH 포트> -i <키> <계정>@<서버>`.

**4) 실제 Azure 데이터 (로그인)** — 로컬 `.env`의 값으로 서버 설정을 만들어 올림

```bash
scripts/onprem.sh env           # api.env·web.env(+ connections.json) → 서버 ~/aud-runtime (600, 값은 화면에 안 나옴)
scripts/onprem.sh restart       # 새 설정으로 재기동
```

| 옮기는 것 | 옮기지 않는 것 (이유) |
|---|---|
| `AZURE_AD_*`(플랫폼 신원·토큰 대상), `AZURE_SUBSCRIPTION_IDS`, 작업 영역·기능 스위치, `AUD_CONN_*_SECRET`, 연결 파일 | `NEXT_PUBLIC_*`(웹은 `AUD_WEB_*`로 실행 시 읽음 — 자동 변환), `AZURE_PROMETHEUS_ENDPOINT`(모든 클러스터를 한 작업 영역에 고정 — 컨테이너는 클러스터마다 자기 작업 영역을 찾음), `AUD_DEFAULT_ROLE`(운영 모드 금지), `PORT`·`ARGOCD_*` |

- 운영 모드에서는 **앱 역할(AUD.Viewer/Operator/Admin)이 할당된 사용자만** 쓸 수 있습니다(없으면 403 `no_platform_role`). 역할 할당 전 임시 확인은 `scripts/onprem.sh env --test`(API를 `NODE_ENV=development`로, `.env`의 `AUD_DEFAULT_ROLE` 사용 — 시험용, 운영 금지).
- 서버의 플랫폼 신원이 비밀이면 연결 점검이 '페더레이션 권장'을 보여 줍니다. 인증서로 바꾸려면 `config/platform.pem`을 `~/aud-runtime/config/`에 두고 `AUD_PLATFORM_CERT_PATH=/etc/aud/platform.pem`.
- 프라이빗 AKS 클러스터 안쪽(객체·정책·노드)은 온프레미스에서 경로가 없어 `cluster_dns_unresolved`가 정상입니다(클러스터 배포 후 해결). 나머지 Azure 화면(구성도·리소스 상태·보안·비용·라이브 다이어그램)은 동작합니다.

**5) 운영**

작업 PC의 `scripts/onprem.sh <명령>`과 서버의 `sudo ~/aud-runtime/audctl <명령>`은 같은 일을 합니다(작업 PC 쪽이 SSH로 audctl을 부름).

| 명령 | 하는 일 |
|---|---|
| `deploy` (작업 PC만) | 코드 갱신 → 새 이미지(태그 = 커밋, 변경 있으면 `<sha>-dirty-<UTC 시각>`) → 재기동 |
| `status` | 지금·이전 이미지 태그, 컨테이너 상태, readyz |
| `logs api 200 [-f]` | api 로그 끝 200줄 (`web`·`pod` 가능, `-f` 따라가기) |
| `restart [api\|web]` | 재기동(설정 파일 바꾼 뒤) |
| `rollback [tag]` | 이전 이미지로 되돌림(다시 하면 새 이미지로 — 둘 사이를 오감) |
| `images` · `version` | 서버의 우리 이미지 목록 · 지금/이전 이미지 생성 시각 |
| `up [tag]` · `down` | 기동 · 중지(설정 `~/aud-runtime`은 남음) |

이미지 정리: 기동이 성공하면 **우리 태그만**(`aud-dashboard:<sha>[-dirty…]`) 최신 3개 + 지금·이전을 남기고 지웁니다(`AUD_KEEP_IMAGES`). 다른 팀 이미지가 있는 서버라 `docker image prune`·`system prune`은 쓰지 않습니다.

**서버 디렉터리** — `~/aud-runtime`(700, 소스 없음):

| 파일 | 내용 |
|---|---|
| `audctl` | 운영 스크립트(빌드마다 갱신) |
| `compose.yaml` · `nginx.conf` | 실행 구성(빌드마다 갱신) |
| `.env` | `AUD_IMAGE`·`AUD_HTTP_PORT` — `cd ~/aud-runtime && sudo docker compose ps`도 audctl 없이 동작 |
| `.image-tag` · `.image-tag.prev` | 지금·이전 이미지(되돌리기용) |
| `api.env` · `web.env` (600) · `config/` · `tls/` | 설정(`scripts/onprem.sh env`가 씀) |
| `state/arrangements` (65532) | 팀 배치(유일한 쓰기 마운트) |

**예전 방식에서 옮기기(한 번)**: 새 `deploy`로 `audctl`이 설치된 뒤 `scripts/onprem.sh cleanup-source` — 예전 소스 `~/aud-dashboard`를 지웁니다(내 소유의 일반 폴더이고 `.source-sha`·`compose.yaml`이 있을 때만, sudo 없이). 실행 중인 컨테이너는 compose 프로젝트 이름(`aud-dashboard`)이 같아 그대로 이어받습니다.

**남는 흔적**: BuildKit 빌드 캐시(`/var/lib/docker`, root만 읽기)에는 빌드 단계의 파일이 캐시 정리 전까지 남습니다. 공용 서버에서 `docker builder prune`은 다른 팀 캐시도 지우므로 쓰지 않습니다 — 완전히 없애야 하면 전용 빌더(`docker buildx create --name aud` → `buildx build --builder aud --load` → `buildx prune --builder aud -af`)를 씁니다.

**6) VS Code로 서버 열기 (Remote-SSH)** — 작업 PC의 `~/.ssh/config`에 별칭을 하나 두면 VS Code의 *Remote-SSH: Connect to Host…*에서 그 이름으로 접속합니다(확장 `ms-vscode-remote.remote-ssh`, 플랫폼 Linux).

```
Host aud-onprem
  HostName <서버 IP>
  Port <SSH 포트>
  User <계정>
  IdentityFile <저장소 경로>/.secrets/<개인 키>
  IdentitiesOnly yes
  ServerAliveInterval 30
```

서버가 VS Code 서버를 내려받지 못하면 설정 `"remote.SSH.localServerDownload": "always"`(PC가 받아 올림). 계정이 docker 그룹이 아니면 터미널에서 `sudo docker …`.

**수동으로 한다면**: compose 없이 `docker run`으로 같은 구성을 만들 수 있습니다 — [`scripts/container-smoke.mjs`](../../scripts/container-smoke.mjs)의 세 `docker run`(`--network container:<pod>`)이 그대로 예시입니다.

## 6. 권한·보안

| 항목 | 값 |
|---|---|
| 사용자 | `65532:65532`(이미지 `USER`, compose `user`) |
| 파일 시스템 | 읽기 전용 루트 + tmpfs `/tmp`, 웹 `.next/cache` |
| 권한 | `cap_drop: ALL`, `no-new-privileges` |
| 비밀 | 이미지·저장소에 없음. 인증서는 읽기 전용 마운트, 비밀을 쓴다면 `api.env`(gitignore) |
| 노출 | 웹만. API(4000)는 공개 포트가 없음 |

`NODE_ENV=production`에서는: 앱 역할이 없는 사용자는 403(`AUD_DEFAULT_ROLE` 금지), Hubble exec 꺼짐, 키 없는 공개 번역기 꺼짐(`AUD_TRANSLATOR_KEYLESS`), 처리 못 한 예외 = 프로세스 종료(재시작으로 깨끗한 상태 — 끊긴 소켓은 예외).

## 7. 수집 데이터

개발 실행과 같습니다 — [`../integrations/azure/data-collected.md`](../integrations/azure/data-collected.md). 컨테이너가 쓰는 디스크는 tmpfs와 팀 배치 쓰기 마운트(`state/arrangements` → `AUD_ARRANGEMENT_DIR=/var/lib/aud/arrangements`, 구독별 배치 JSON)뿐이고, 캐시·라이브 다이어그램은 메모리에 있어 재시작하면 사라집니다.

## 8. 확인

1. `docker compose ps` — 모두 `healthy`
2. `curl -k https://<호스트>:8443/readyz` → `{"ok":true}` (웹 + 옆의 API, Azure는 묻지 않음)
3. 브라우저 `https://<호스트>:8443/` → 로그인 → 설정 › Azure 연결 › 점검(관리자) — 자격 증명 `인증서`, 토큰·구독 통과
4. `docker compose logs api | grep "platform credential"` → `certificate`

## 9. 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| 화면에 'HTTPS가 필요합니다' | http로 다른 PC에서 접속 | `--profile tls`, `https://<호스트>:8443` |
| 로그인 팝업 `AADSTS50011` | SPA 리디렉션 URI 미등록 | 앱 등록에 `https://<호스트>:8443/` 추가(또는 `AUD_WEB_REDIRECT_URI`) |
| `/readyz` 503 `unreachable` | API가 안 뜸 | `docker compose logs api` — env 검증 오류(필수 값·인증서 경로)가 첫 줄에 나옴 |
| Azure 호출이 오래 걸리다 실패 | 사내 프록시 | `api.env`의 `HTTPS_PROXY`·`NO_PROXY=127.0.0.1,localhost,::1`·`NODE_USE_ENV_PROXY=1`(Node 내장 fetch는 이 값이 있어야 프록시 사용)·`NODE_EXTRA_CA_CERTS` |
| AKS 화면 `cluster_dns_unresolved` | 프라이빗 클러스터 API 서버에 경로·DNS 없음 | S2S/ExpressRoute + privatelink DNS 전달이 있어야 함. 없으면 정상 응답(클러스터 안 기능은 AKS 배포 후) — 쿠버네티스 클라이언트는 프록시를 쓰지 않음 |
| `EACCES` 인증서 읽기 | 파일 권한 | `chgrp 65532` + `g+r` |
| Service Health 번역 실패 | 키 없는 번역기는 운영에서 꺼짐 | `AZURE_TRANSLATOR_KEY`(+ 지역) |

## 10. 교체

- 새 이미지: `AUD_IMAGE=aud-dashboard:<새 tag> docker compose --profile tls up -d` (정지 신호에 5초 안에 정리 — 최대 10초)
- 인증서: `config/platform.pem` 교체 → `docker compose restart api`

## 11. 해제

`docker compose --profile tls down` → 서버의 `deploy/docker/config`·`tls`·`*.env` 삭제 → 앱 등록의 리디렉션 URI 제거.

## 12. AKS로 옮길 때 (다음 단계)

같은 이미지를 쓰고 바뀌는 것은 실행 설정뿐입니다 — 절차는 [kubernetes.md](./kubernetes.md), 원본은 Helm 차트 [`deploy/helm/aud-dashboard`](../../deploy/helm/aud-dashboard/)(평문 매니페스트 [`deploy/kubernetes/`](../../deploy/kubernetes/)는 그 렌더 결과).

| 항목 | 온프레미스 | AKS |
|---|---|---|
| 네트워크 공간 | compose `pod` 서비스 | 파드 |
| 플랫폼 신원 | 인증서 (`AUD_PLATFORM_CREDENTIAL=certificate`) | 사용자 할당 관리 ID + 워크로드 ID (`workloadIdentity`, 웹후크가 `AZURE_CLIENT_ID`·토큰 파일을 줌, 비밀 없음) |
| 기본 이미지 | `node:24.22.1-bookworm-slim` | 고객의 하드닝 이미지 미러(`--build-arg NODE_BUILD_IMAGE/NODE_RUNTIME_IMAGE`) — **같은 최소 버전(24.22.1) 이상**이어야 함 |
| HTTPS | nginx(`tls` 프로필) | 게이트웨이(고객 결정 — TLS 종료 지점) |
| 헬스 | compose healthcheck | 웹 `httpGet /healthz`·`/readyz`, API `exec`(루프백이라 httpGet 불가) |
| 연결 파일 | `config/connections.json` 마운트 | ConfigMap(`/etc/aud`) |

## 보안 패치 기준 (Node.js·Next.js)

- **최소 버전**: Node.js **24.22.1**([2026-10-21 보안 릴리스](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) — Brotli 해제기 원격 코드 실행 CVE-2026-111497, TLS 호스트 이름 검증 우회 CVE-2026-105483·106069, `dns.resolve` NUL 잘림 CVE-2026-105482 등 High 4건), Next.js **16.4.2**(rewrites의 HTTP 요청 밀반입 — 웹이 `/api`를 rewrites로 넘김). `apps/api/test/runtimeSecurity.test.ts`가 Dockerfile 기본 이미지·`next` 버전이 이 아래로 내려가면 실패합니다.
- **왜 우리에게 해당하나**: API의 HTTP 클라이언트(Node `fetch`·쿠버네티스 클라이언트의 node-fetch)는 Brotli를 요청하지 않지만 상대가 `content-encoding: br`로 보내면 그대로 풉니다(2026-10-23 실험) — Azure·쿠버네티스 API는 TLS지만 클러스터 안 Loki(`http://…:3100`)는 평문이라 그 응답 경로가 열려 있습니다. API 파드는 Azure 자격 증명(워크로드 ID)을 가지므로 원격 코드 실행은 곧 Azure 권한 탈취입니다.
- **해당 없음(설정 기준)**: Permission Model(`--permission`) 미사용, startup snapshot·SEA 미사용, HTTP/2 서버 없음(Next 표준 서버는 HTTP/1.1), Express `trust proxy` 미사용(proxy-addr), API에 `HTTPS_PROXY` 없음(프록시 자격 증명 노출 CVE-2026-48615 — 온프렘에서 프록시를 쓰면 URL에 자격 증명을 넣지 말 것).
- **새 보안 릴리스가 나오면**: 공지의 24.x 수정 버전으로 Dockerfile `ARG`와 위 테스트 상수를 올리고 → 온프렘 `scripts/onprem.sh deploy`, 클러스터는 고객 DHI 미러 이미지 버전도 함께 올린 뒤 GitOps 재배포. 실행 중인 버전 확인: `kubectl exec … -c api -- node -p process.versions.node` / 서버 `docker run --rm --entrypoint node aud-dashboard:<tag> -v`.
- **남은 의존성 경고**: `@azure/arm-resourcegraph` 4.x를 거친 `uuid`(moderate) — v3·v5·v6에 버퍼를 줄 때만 해당하고 옛 SDK는 `uuid.v4()`만 써서 우리 경로로는 닿지 않음. 주 버전 업그레이드(5.x) 또는 이미 있는 ARG fetcher로 교체가 후속 과제.

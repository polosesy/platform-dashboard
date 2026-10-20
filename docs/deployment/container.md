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

서버에 접속해 손으로 명령을 치지 않고, **작업 PC**에서 [`scripts/onprem.sh`](../../scripts/onprem.sh) 하나로 소스 전송 → 서버 빌드 → 기동 → 터널까지 합니다. 서버 쪽은 [`deploy/docker/onprem-remote.sh`](../../deploy/docker/onprem-remote.sh)가 sudo로 실행됩니다.

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
scripts/onprem.sh deploy        # push(추적 파일만) → build(서버) → up(예시 설정 자동 생성) → 준비 확인
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
scripts/onprem.sh up            # 새 설정으로 재기동
```

| 옮기는 것 | 옮기지 않는 것 (이유) |
|---|---|
| `AZURE_AD_*`(플랫폼 신원·토큰 대상), `AZURE_SUBSCRIPTION_IDS`, 작업 영역·기능 스위치, `AUD_CONN_*_SECRET`, 연결 파일 | `NEXT_PUBLIC_*`(웹은 `AUD_WEB_*`로 실행 시 읽음 — 자동 변환), `AZURE_PROMETHEUS_ENDPOINT`(모든 클러스터를 한 작업 영역에 고정 — 컨테이너는 클러스터마다 자기 작업 영역을 찾음), `AUD_DEFAULT_ROLE`(운영 모드 금지), `PORT`·`ARGOCD_*` |

- 운영 모드에서는 **앱 역할(AUD.Viewer/Operator/Admin)이 할당된 사용자만** 쓸 수 있습니다(없으면 403 `no_platform_role`). 역할 할당 전 임시 확인은 `scripts/onprem.sh env --test`(API를 `NODE_ENV=development`로, `.env`의 `AUD_DEFAULT_ROLE` 사용 — 시험용, 운영 금지).
- 서버의 플랫폼 신원이 비밀이면 연결 점검이 '페더레이션 권장'을 보여 줍니다. 인증서로 바꾸려면 `config/platform.pem`을 `~/aud-runtime/config/`에 두고 `AUD_PLATFORM_CERT_PATH=/etc/aud/platform.pem`.
- 프라이빗 AKS 클러스터 안쪽(객체·정책·노드)은 온프레미스에서 경로가 없어 `cluster_dns_unresolved`가 정상입니다(클러스터 배포 후 해결). 나머지 Azure 화면(구성도·리소스 상태·보안·비용·라이브 다이어그램)은 동작합니다.

**5) 운영**

| 명령 | 하는 일 |
|---|---|
| `scripts/onprem.sh logs api 200` | api 로그 끝 200줄 (`web`·`pod` 가능) |
| `scripts/onprem.sh down` | 중지·삭제(설정 `~/aud-runtime`은 남음) |
| `scripts/onprem.sh deploy` | 코드 갱신 → 새 이미지(태그 = 커밋, 변경 있으면 `-dirty`) → 재기동 |

서버 디렉터리: 소스 `~/aud-dashboard`(전송 때마다 교체) · 실행 설정 `~/aud-runtime`(api.env·web.env 600, config/, .image-tag — 유지). compose는 `--project-directory ~/aud-runtime`로 실행됩니다.

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

개발 실행과 같습니다 — [`../integrations/azure/data-collected.md`](../integrations/azure/data-collected.md). 컨테이너가 쓰는 디스크는 tmpfs뿐이고, 캐시·라이브 다이어그램은 메모리에 있어 재시작하면 사라집니다.

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

같은 이미지를 쓰고 바뀌는 것은 실행 설정뿐입니다 — 참고 매니페스트 [`deploy/kubernetes/`](../../deploy/kubernetes/) (`deployment.yaml`·`ciliumnetworkpolicy.yaml`).

| 항목 | 온프레미스 | AKS |
|---|---|---|
| 네트워크 공간 | compose `pod` 서비스 | 파드 |
| 플랫폼 신원 | 인증서 (`AUD_PLATFORM_CREDENTIAL=certificate`) | 사용자 할당 관리 ID + 워크로드 ID (`workloadIdentity`, 웹후크가 `AZURE_CLIENT_ID`·토큰 파일을 줌, 비밀 없음) |
| 기본 이미지 | `node:24.13.0-bookworm-slim` | 고객의 하드닝 이미지 미러(`--build-arg NODE_BUILD_IMAGE/NODE_RUNTIME_IMAGE`) |
| HTTPS | nginx(`tls` 프로필) | 게이트웨이(고객 결정 — TLS 종료 지점) |
| 헬스 | compose healthcheck | 웹 `httpGet /healthz`·`/readyz`, API `exec`(루프백이라 httpGet 불가) |
| 연결 파일 | `config/connections.json` 마운트 | ConfigMap(`/etc/aud`) |

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

## 5. 설정 — 수동

compose 없이 `docker run`으로 같은 구성을 만들 수 있습니다 — [`scripts/container-smoke.mjs`](../../scripts/container-smoke.mjs)의 세 `docker run`(`--network container:<pod>`)이 그대로 예시입니다.

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

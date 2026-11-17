---
status: current
owner: platform
last-verified: 2026-11-17
covers: [apps/api/src/services/opsLibrary.ts, apps/api/src/services/opsFeeds.ts]
---
# 공개 장애 사례 (참고 사례 라이브러리)

다른 회사가 직접 공개한 사후 분석(postmortem)을 **사례·런북 › 외부 학습 › 공개 사례**와 **찾기**(우리 사례와 함께 비교)에 넣은 목록입니다. 코드의 원본은 `apps/api/src/services/opsLibrary.ts`(이 문서와 같은 목록 — `opsLearning.test.ts`가 id·링크 일치를 검사).

**기준**: 그 회사의 원문 페이지를 2026-11-17에 직접 읽어 확인한 사실만(요약은 한국어). 원문으로 확인하지 못한 것은 넣지 않습니다 — Reddit 'Pi-Day outage'(2023, Kubernetes 1.24 업그레이드)는 원문이 자동 읽기를 막아 제외. Uber 글은 정식 사후 분석이 아니라 신뢰성 글(인프라 원인 세부 없음)이라 `partially-confirmed` 태그.

**왜 이 사례들인가** — 이 플랫폼(AKS·Azure·Kubernetes 운영)과 겹치는 실패 유형: 컨트롤 플레인 과부하와 DNS(OpenAI), 설정 전파·버전 차이(Azure Front Door ×2, Google Cloud, Cloudflare), 노드 OS 자동 업데이트와 Cilium 경로(Datadog), 용량·한도(AWS Kinesis·Slack), 사람의 명령(AWS S3), 클라우드 의존 DNS(AWS DynamoDB), 조용한 품질 저하(Anthropic), 재시도 폭주(Uber).

| id | 조직 · 날짜 | 무엇 | 원문 |
|---|---|---|---|
| `lib-openai-2024-12-telemetry-apiserver` | OpenAI · 2024-12-11 | 새 텔레메트리 서비스가 Kubernetes API 서버를 과부하 → DNS 서비스 디스커버리 실패 | [원문](https://status.openai.com/incidents/ctrsv3lwd797) |
| `lib-azure-afd-2025-10-29` | Microsoft Azure · 2025-10-29 | 호환되지 않는 설정 메타데이터가 엣지 데이터 플레인을 크래시, 'Last Known Good'까지 오염 (YKYN-BWZ) | [원문](https://azure.status.microsoft/en-us/status/history/?trackingId=YKYN-BWZ) |
| `lib-azure-afd-2025-10-09` | Microsoft Azure · 2025-10-09 | 6주 전 컨트롤 플레인 결함의 테넌트 메타데이터가 보호 시스템 우회 중 데이터 플레인을 크래시 (QNBQ-5W8) | [원문](https://azure.status.microsoft/en-us/status/history/?trackingId=QNBQ-5W8) |
| `lib-datadog-2023-03-systemd-cilium-routes` | Datadog · 2023-03-08 | OS 보안 업데이트로 systemd-networkd 재시작 → Cilium 경로 삭제, 수만 노드 동시 이탈 | [원문](https://www.datadoghq.com/blog/2023-03-08-multiregion-infrastructure-connectivity-issue/) |
| `lib-gcp-2025-06-service-control` | Google Cloud · 2025-06-12 | 기능 플래그 없는 새 정책 검사가 빈 필드에 널 포인터 → Service Control 전역 크래시 루프 | [원문](https://status.cloud.google.com/incidents/ow5i3PPK96RduMcb1SsW) |
| `lib-aws-2025-10-dynamodb-dns` | AWS · 2025-10-20 | DynamoDB DNS 자동화의 경쟁 상태로 리전 엔드포인트 DNS가 빈 레코드 | [원문](https://aws.amazon.com/message/101925/) |
| `lib-aws-2020-11-kinesis-threads` | AWS · 2020-11-25 | 프런트엔드 용량 추가가 OS 스레드 한도를 넘김 | [원문](https://aws.amazon.com/message/11201/) |
| `lib-aws-2017-02-s3-command` | AWS · 2017-02-28 | 플레이북 명령의 입력 오타로 서버를 너무 많이 제거, 서브시스템 콜드 재시작 | [원문](https://aws.amazon.com/message/41926/) |
| `lib-cloudflare-2025-11-feature-file` | Cloudflare · 2025-11-18 | DB 권한 변경으로 봇 관리 기능 파일이 두 배 → 한도 초과로 프록시 패닉 | [원문](https://blog.cloudflare.com/18-november-2025-outage/) |
| `lib-slack-2021-01-tgw-autoscale` | Slack · 2021-01-04 | 연휴 뒤 트래픽에 AWS Transit Gateway 확장 지연 → 패킷 손실, 자동 확장 폭주·파일 한도 | [원문](https://slack.engineering/slacks-outage-on-january-4th-2021/) |
| `lib-anthropic-2025-09-three-issues` | Anthropic · 2025-08-05 | 겹친 세 버그(컨텍스트 창 라우팅·TPU 설정·근사 top-k 컴파일)로 응답 품질이 간헐 저하 | [원문](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues) |
| `lib-uber-retry-storms` | Uber · 2025-11-18 | 깊은 호출 사슬의 서비스 저하가 재시도 폭주로 번지는 것을 '오류 소유'로 막음 (신뢰성 글 — 사후 분석 아님) | [원문](https://www.uber.com/us/en/blog/protecting-against-retry-storms/) |

## 사례별 요약

### OpenAI — 새 텔레메트리 서비스가 Kubernetes API 서버를 과부하 → DNS 서비스 디스커버리 실패

- id `lib-openai-2024-12-telemetry-apiserver` · OpenAI · 발생 2024-12-11 23:16 UTC → 2024-12-12 03:38 UTC
- **증상**: API·ChatGPT·Sora가 크게 저하되거나 중단(약 4시간). ChatGPT·Sora는 19:01 PST, API는 19:38 PST 회복.
- **원인**: 15:12 PST에 배포한 텔레메트리 서비스의 설정이 클러스터의 모든 노드가 Kubernetes API 서버에 무거운 요청을 보내게 함 → 대형 클러스터 대부분의 컨트롤 플레인 과부하. DNS 기반 서비스 디스커버리가 컨트롤 플레인에 기대어, 캐시 TTL이 끝나며 순차적으로 실패. 시험은 작은 클러스터라 못 잡았고 DNS 캐시가 증상을 늦춤.
- **조치**: 트래픽 이동, 동시에 세 갈래 — 클러스터 축소, Kubernetes 관리 API로의 네트워크 접근 차단, API 서버 확장. 많은 서비스가 한꺼번에 다시 읽으며 일부 클러스터는 회복이 느렸음.
- **교훈**: 컨트롤 플레인 건강을 보며 단계적 배포 · 어떤 부하에서도 API 서버에 들어갈 비상 접근(break-glass) · 데이터 플레인과 DNS 디스커버리를 컨트롤 플레인에서 분리, 컨트롤 플레인 없이 데이터 플레인을 시험하는 장애 주입.
- 원문: https://status.openai.com/incidents/ctrsv3lwd797

### Azure Front Door — 호환되지 않는 설정 메타데이터가 엣지 데이터 플레인을 크래시, 'Last Known Good'까지 오염 (YKYN-BWZ)

- id `lib-azure-afd-2025-10-29` · Microsoft Azure · 발생 2025-10-29 15:41 UTC → 2025-10-30 00:05 UTC
- **증상**: Azure Front Door·Azure CDN 연결 시간 초과·DNS 해석 실패 — Azure Portal, App Service, SQL Database, Communication Services 등 영향.
- **원인**: 두 컨트롤 플레인 빌드 버전에 걸친 정상 고객 설정 변경이 호환되지 않는 메타데이터를 만들어 잠재된 데이터 플레인 버그를 건드림. 엣지의 비동기 처리 중 크래시가 보호 시스템의 단계 확인을 통과한 약 5분 뒤에 나타나 대부분의 엣지로 퍼지고 'Last Known Good' 스냅샷에도 기록됨.
- **조치**: 15:43 변경 차단, 15:48 경고로 조사 시작. LKG에 나쁜 메타데이터가 있어 그대로 되돌릴 수 없어 최신 LKG에서 손으로 제거, 17:30 고객 설정 전파 차단, 17:40부터 고친 LKG 배포, 엣지가 차례로 다시 읽음.
- **교훈**: 운영 단계 전 완전 동기 설정 처리·더 긴 숙성(완료) · 컨트롤 플레인 버전 간 하위 호환 시험 · 설정 작업 프로세스 격리, 전파 45→약 15분, 데이터 플레인 복구 약 10분, '마이크로 셀' 격리.
- 원문: https://azure.status.microsoft/en-us/status/history/?trackingId=YKYN-BWZ

### Azure Front Door — 6주 전 컨트롤 플레인 결함의 테넌트 메타데이터가 보호 시스템 우회 중 데이터 플레인을 크래시 (QNBQ-5W8)

- id `lib-azure-afd-2025-10-09` · Microsoft Azure · 발생 2025-10-09 07:50 UTC → 2025-10-09 16:00 UTC
- **증상**: 주로 아프리카·유럽에서 지연·시간 초과(최대 실패율 아프리카 약 17%, 유럽 약 6%), Azure Portal 영향.
- **원인**: 약 6주 전 컨트롤 플레인 릴리스의 결함이 잘못된 테넌트 메타데이터를 만듦. 정리 작업 중 보호 시스템을 잠시 우회해 데이터 플레인에 닿아 크래시 — 유럽·아프리카 AFD 데이터 플레인 약 26%, 옮겨 간 부하로 남은 사이트도 한계를 넘음.
- **조치**: 09:08부터 자동 재시작, 11:59 Portal 장애 조치, 12:50 AFD 가용성 회복.
- **교훈**: 보호 시스템 우회 불가로 · 데이터 플레인 복제본으로 런타임 설정 검증 · Portal 장애 조치 자동화 확대.
- 원문: https://azure.status.microsoft/en-us/status/history/?trackingId=QNBQ-5W8

### Datadog — OS 보안 업데이트로 systemd-networkd 재시작 → Cilium 경로 삭제, 수만 노드 동시 이탈

- id `lib-datadog-2023-03-systemd-cilium-routes` · Datadog · 발생 2023-03-08 06:00 UTC → 2023-03-10 06:25 UTC
- **증상**: 5개 리전 전 서비스 — 웹 앱·API 접근 불가, 모니터 경고 중단, 수집 장애(백필 포함 완전 해소 3월 10일).
- **원인**: Ubuntu 22.04(systemd v249) VM에 systemd 보안 업데이트가 자동 적용 → systemd-networkd가 재시작하며 CNI(Cilium)가 관리하는 경로를 지움 → 06:00~07:00 UTC에 수만 노드가 오프라인. 기본 이미지에 옛 보안 업데이트 채널이 켜져 있고 업데이트 창이 같아 여러 리전이 동시에.
- **조치**: 약 3분에 내부 모니터링 경고, 약 18분에 높은 등급 선언. 컴퓨트를 평소 이상으로 늘려 복구 — 재부팅 대신 노드 교체가 클라우드 공급자의 속도 제한에 부담.
- **교훈**: 옛 업데이트 채널 끄고 다른 이미지도 점검 · systemd-networkd가 재시작 때 경로 테이블을 건드리지 않게 · 이 규모의 카오스 시험.
- 원문: https://www.datadoghq.com/blog/2023-03-08-multiregion-infrastructure-connectivity-issue/

### Google Cloud — 기능 플래그 없는 새 정책 검사가 빈 필드에 널 포인터 → Service Control 전역 크래시 루프

- id `lib-gcp-2025-06-service-control` · Google Cloud · 발생 2025-06-12 17:51 UTC → 2025-06-13 01:18 UTC
- **증상**: Google Cloud·Workspace·Security Operations의 외부 API 요청에 503(us-central1이 가장 늦게 회복).
- **원인**: 5월 29일 Service Control에 추가된 할당량 정책 검사에 오류 처리·기능 플래그가 없었음. 6월 12일 빈 필드가 있는 정책 변경이 Spanner에 쓰여 몇 초 만에 전역 복제 → 널 포인터 경로로 모든 곳에서 크래시 루프.
- **조치**: 2분 안에 분류, 10분 안에 원인. 약 25분에 '빨간 버튼'(킬 스위치) 준비, 40분 안에 전체 적용. us-central1은 무작위 지수 백오프 없이 재시작한 작업들이 Spanner를 과부하시켜 약 2시간 40분.
- **교훈**: 실패하는 검사는 열린 쪽으로(fail open), 중요한 변경은 기본 꺼진 기능 플래그 필수 · 전역 복제 데이터는 점진 전파·검증 시간 · 무작위 지수 백오프 점검.
- 원문: https://status.cloud.google.com/incidents/ow5i3PPK96RduMcb1SsW

### AWS us-east-1 — DynamoDB DNS 자동화의 경쟁 상태로 리전 엔드포인트 DNS가 빈 레코드

- id `lib-aws-2025-10-dynamodb-dns` · AWS · 발생 2025-10-20 06:48 UTC → 2025-10-20 21:20 UTC
- **증상**: DynamoDB API 오류·새 연결 불가 → EC2 시작 실패(insufficient capacity·request limit exceeded), NLB 연결 오류, Lambda·SQS/Kinesis·ECS·EKS·Fargate·STS·IAM 로그인 등 연쇄.
- **원인**: DNS Planner(계획)·DNS Enactor(Route 53 적용)의 잠재된 경쟁 상태: 늦은 Enactor가 오래된 계획으로 새 계획을 덮고, 다른 Enactor의 정리가 그 계획을 지워 리전 엔드포인트가 빈 DNS 레코드로 남음 — 이후 갱신도 막혀 사람이 개입.
- **조치**: 12:38에 DNS 원인 확인, 2:25 복원. 이어 EC2 DropletWorkflow Manager가 리스 재설정 중 '혼잡 붕괴' → 작업 조절·호스트 재시작. NLB 헬스 체크 출렁임으로 자동 장애 조치를 9:36~14:09 끔.
- **교훈**: Planner/Enactor 자동화를 전 세계에서 끄고 경쟁 상태 수정·안전장치 · NLB가 헬스 체크 장애 조치로 뺄 수 있는 용량에 속도 제한 · DWFM 복구 시험과 큐 크기 기반 조절.
- 원문: https://aws.amazon.com/message/101925/

### AWS us-east-1 Kinesis — 프런트엔드 용량 추가가 OS 스레드 한도를 넘김

- id `lib-aws-2020-11-kinesis-threads` · AWS · 발생 2020-11-25 13:15 UTC → 2020-11-26 06:23 UTC
- **증상**: Kinesis put/get 오류 → Cognito, CloudWatch(PutMetricData·PutLogEvents 공백), Auto Scaling, Lambda, EventBridge, ECS·EKS 프로비저닝·확장 영향.
- **원인**: 프런트엔드에 작은 용량을 더한 것이 계기(근본 원인 아님): 서버 수가 늘자 모든 프런트엔드 서버가 OS 스레드 한도를 넘어 샤드 맵 캐시를 만들지 못해 백엔드로 라우팅 불가.
- **조치**: 5:15 경보, 예방으로 추가 용량 제거, 9:39 원인 확인. 시험 안 한 스레드 한도 상향 대신 전체를 천천히 재시작.
- **교훈**: 더 큰 서버로 서버 수·스레드 줄이고 스레드 사용 경보 · 샤드 맵 캐시·CloudWatch를 전용·분할 플릿으로 · 셀 분할 가속.
- 원문: https://aws.amazon.com/message/11201/

### AWS us-east-1 S3 — 플레이북 명령의 입력 오타로 서버를 너무 많이 제거, 서브시스템 콜드 재시작

- id `lib-aws-2017-02-s3-command` · AWS · 발생 2017-02-28 17:37 UTC → 2017-02-28 21:54 UTC
- **증상**: S3 요청 처리 불가, S3 콘솔·EC2 시작·스냅샷 복원 EBS·Lambda 영향, 상태 대시보드도 11:37까지 갱신 불가.
- **원인**: 결제 서브시스템 서버 몇 대를 빼는 플레이북 명령의 입력 하나를 잘못 넣어 인덱스·배치 서브시스템 서버까지 대량 제거 — 둘 다 전체 재시작이 필요했고, 큰 리전에서 오래 재시작한 적이 없어 예상보다 오래 걸림.
- **조치**: 인덱스 서브시스템 재시작(13:18 회복) → 배치 서브시스템(13:54).
- **교훈**: 용량 제거 도구를 느리게, 최소 용량 아래로는 막음 · 다른 운영 도구도 같은 안전 확인 점검 · 인덱스 셀 분할, 상태 대시보드 다중 리전.
- 원문: https://aws.amazon.com/message/41926/

### Cloudflare — DB 권한 변경으로 봇 관리 기능 파일이 두 배 → 한도 초과로 프록시 패닉

- id `lib-cloudflare-2025-11-feature-file` · Cloudflare · 발생 2025-11-18 11:20 UTC → 2025-11-18 17:06 UTC
- **증상**: CDN·보안 서비스 HTTP 5xx, Turnstile 실패, 대시보드 로그인 실패, Workers KV·Access 오류 — 5분마다 좋고 나쁜 파일이 번갈아 출렁임.
- **원인**: 11:05 ClickHouse 권한 변경으로 r0 테이블이 메타데이터 쿼리에 보이게 됨. 기능 파일을 만드는 쿼리가 DB 이름으로 거르지 않아 중복 행 → 파일 크기 약 2배 → 모듈의 기능 200개 한도 초과 → FL2 프록시가 Err에 unwrap()으로 패닉. 공격 아님.
- **조치**: 11:31 자동 시험이 발견(처음엔 DDoS로 의심 — 마침 상태 페이지도 장애). 기능 파일 전파 중단, 알려진 좋은 파일 넣고 코어 프록시 재시작.
- **교훈**: 내부에서 만든 설정도 사용자 입력처럼 검증 · 전역 킬 스위치 확대 · 코어 덤프·오류 보고가 자원을 잡아먹지 않게, 프록시 모듈 오류 처리 점검.
- 원문: https://blog.cloudflare.com/18-november-2025-outage/

### Slack — 연휴 뒤 트래픽에 AWS Transit Gateway 확장 지연 → 패킷 손실, 자동 확장 폭주·파일 한도

- id `lib-slack-2021-01-tgw-autoscale` · Slack · 발생 2021-01-04 14:57 UTC → 2021-01-04 18:40 UTC
- **증상**: 오전 7시(PST) 피크에 전면 불가, 9:15까지 저하 — Slack 자체 대시보드·경고도 중단.
- **원인**: AWS Transit Gateway가 연휴 뒤 첫 업무일 급증(클라이언트 캐시가 식음)에 빨리 확장하지 못해 패킷 유실. 자동 확장이 웹 서버 약 1,200대를 더하려 했고, 새 인스턴스를 설정하는 provision-service가 Linux 열린 파일 한도·AWS 할당량에 걸림. 모니터링이 DB와 다른 VPC라 같은 TGW에 의존.
- **조치**: 외부 모니터링이 호출. 축소 중단, 8:15쯤 provision-service 수정, 로드 밸런서 패닉 모드·재시도·서킷 브레이커가 도움, AWS가 TGW 용량을 수동 증설.
- **교훈**: 다음 연휴 전 TGW 선제 확장 요청 · 모니터링을 DB와 같은 VPC로 · provision-service 정기 부하 시험, 헬스 체크·자동 확장 설정 점검.
- 원문: https://slack.engineering/slacks-outage-on-january-4th-2021/

### Anthropic — 겹친 세 버그(컨텍스트 창 라우팅·TPU 설정·근사 top-k 컴파일)로 응답 품질이 간헐 저하

- id `lib-anthropic-2025-09-three-issues` · Anthropic · 발생 2025-08-05 00:00 UTC → 2025-09-18 00:00 UTC
- **증상**: Claude 응답 품질 간헐 저하 — 이상한 문자, 코드 구문 오류, 더 나쁜 답. 사용자 보고가 평소 잡음과 구분이 어려웠음.
- **원인**: ① 일부 Sonnet 4 요청이 1M 컨텍스트용 서버로 라우팅(8/5 약 0.8%, 8/29 로드 밸런싱 변경으로 악화 — 최악 시간 16%, 라우팅이 '고정'이라 후속 요청도 같은 서버) ② 8/25 TPU 런타임 최적화 설정이 드문 토큰에 높은 확률 ③ top-k 변경이 2024년 12월 우회책에 가려져 있던 XLA:TPU 컴파일러 오컴파일을 드러냄.
- **조치**: 라우팅 수정 9/4~9/16(1차·Vertex AI)·9/18(Bedrock), TPU 설정 9/2 되돌림, 정확한 top-k로 전환.
- **교훈**: 더 민감한 평가 · 운영 중 지속 품질 평가 · 개인정보를 지키는 사용자 피드백 디버깅 도구.
- 원문: https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues

### Uber — 깊은 호출 사슬의 서비스 저하가 재시도 폭주로 번지는 것을 '오류 소유'로 막음 (신뢰성 글 — 사후 분석 아님)

- id `lib-uber-retry-storms` · Uber · 발생 2025-11-18 00:00 UTC
- **증상**: 호출 사슬 5단계 넘게 깊은 'Core Entity' 서비스가 기반 인프라 문제로 매우 높은 오류율.
- **원인**: 글에 기반 인프라 원인의 세부는 없음. 균일한 재시도는 저하 중 해롭다 — 단순 재시도 예산만으로는 저하된 서비스로의 트래픽이 46~135% 늘었을 것으로 추정.
- **조치**: '오류 소유'(그 오류를 소유한 서비스만 재시도)로 호출자 재시도를 멈춤 — 약 950만 건의 불필요한 요청을 막은 것으로 추정.
- **교훈**: 오류를 소유한 서비스만 재시도 · 재시도 폭주 반경 최대 25→3, 평균 20→2.
- 원문: https://www.uber.com/us/en/blog/protecting-against-retry-storms/

## 기술 블로그 감시 — 확인된 공식 피드 (2026-11-17)

사례·런북 › 외부 학습 › 기술 블로그 감시에서 운영자가 등록합니다(아래는 한 번에 추가할 수 있는 목록 — 스스로 추가되지 않음). 새 글은 처음 본 시각과 장애 단어(outage·postmortem·root cause·장애 …)와 함께 쌓이고, 사람이 '사례로 기록'(원문 링크가 출처) 또는 '건너뛰기'를 고릅니다.

| 출처 | 주소 | 메모 |
|---|---|---|
| Google Cloud 상태 기록 | https://status.cloud.google.com/en/feed.atom | Atom — 해결된 사건과 보고서 |
| Cloudflare 블로그 | https://blog.cloudflare.com/rss/ | 사후 분석이 블로그 글로 |
| Kubernetes 블로그 | https://kubernetes.io/feed.xml | 제거·변경 예고 |
| AWS Architecture 블로그 | https://aws.amazon.com/blogs/architecture/feed/ | AWS 사건 요약(aws.amazon.com/message)은 RSS 없음 |
| Azure 블로그 | https://azure.microsoft.com/en-us/blog/feed/ | 외부(후원) 링크가 섞임. Azure PIR은 상태 기록 `?trackingId=` 링크 |
| Google Cloud 블로그 | https://cloudblog.withgoogle.com/rss/ | cloud.google.com/blog/rss는 HTML로 답함 |
| OpenAI 뉴스 | https://openai.com/news/rss.xml | 장애 보고는 status.openai.com(RSS 아님) |

확인했지만 넣지 않은 것: Anthropic(공식 RSS·Atom 없음 — /engineering에 피드 링크 없음), Uber 엔지니어링(모든 RSS 주소가 404·406), Azure 상태 피드(진행 중 사건만 — 평소 비어 있음).

**안전**: 운영자가 넣은 주소라 서버는 https·공개 주소로만 읽습니다(사설·루프백·링크 로컬·CGNAT·메타데이터 거부, 리디렉션마다 다시 확인, 2MB·15초, RSS·Atom만). 쿠버네티스에서는 네트워크 정책이 최종 경계 — 차트 `networkPolicy.extraFqdns`에 그 호스트를 넣어야 나갑니다. 주기 `AUD_OPS_FEEDS_INTERVAL_SEC`(기본 3600, 0 = 끔), 저장 `<AUD_ARRANGEMENT_DIR>/knowledge/feeds.json`.

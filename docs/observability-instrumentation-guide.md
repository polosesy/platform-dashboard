# Observability 계측 및 수집 가이드

> AKS 환경에서 클러스터/애플리케이션 메트릭과 로그를 수집하기 위한 계측 원리, 수집 경로, 앱별 설정 방법을 정리한 문서입니다.

---

## 목차

1. [AKS 수집 가능 메트릭 체계](#1-aks-수집-가능-메트릭-체계)
2. [계측의 두 가지 근본 방식](#2-계측의-두-가지-근본-방식)
3. [수집 경로 (앱 → Azure Monitor)](#3-수집-경로)
4. [분산 추적 전파 원리](#4-분산-추적distributed-tracing-전파-원리)
5. [앱별 계측 설정](#5-앱별-계측-설정)
6. [로그 수집 체계](#6-로그-수집-체계)
7. [Observability 백엔드 데이터 조회 방식](#7-observability-백엔드-데이터-조회-방식)
8. [AKS 로그 수집 아키텍처 심층 분석](#8-aks-로그-수집-아키텍처-심층-분석)
   - [8.1 로그 분류 체계 (4계층)](#81-aks-로그-분류-체계)
   - [8.2 자원 최적화 로그 수집 전략](#82-자원-최적화-로그-수집-전략)
   - [8.3 Pod 비정상 종료 시 로그 보존](#83-pod-비정상-종료-시-로그-보존-전략)
   - [8.4 애플리케이션 운영 로그 수집](#84-애플리케이션-운영-로그-수집-체계)
   - [8.5 Azure Native vs 오픈소스 비교](#85-로그-수집-방안-비교-azure-native-vs-오픈소스)
   - [8.6 프로젝트 적용 권장사항](#86-프로젝트-적용-권장사항)
9. [요약](#9-요약)

---

## 1. AKS 수집 가능 메트릭 체계

### 1.1 클러스터 단위 (Infrastructure Layer)

Container Insights가 자동 수집하는 메트릭입니다. 별도 계측이 필요하지 않습니다.

| 계층 | 메트릭 | 데이터 소스 (KQL 테이블) |
|------|--------|------------------------|
| **Node** | CPU/Memory 사용률, Disk IOPS, Network In/Out | `InsightsMetrics` (cpuUsageNanoCores, memoryWorkingSetBytes 등) |
| **Node 상태** | Ready/NotReady, SchedulingDisabled, DiskPressure, MemoryPressure, PIDPressure | `KubeNodeInventory` |
| **Pod** | CPU/Memory request vs limit vs actual, restart count, OOMKilled 횟수 | `KubePodInventory` + `InsightsMetrics` |
| **Pod 상태** | Running/Pending/Failed/Succeeded, ContainerStatus (Waiting/Terminated 사유) | `KubePodInventory` |
| **Container** | CPU throttling, Memory RSS vs Cache, restart 사유 | `ContainerInventory` + `InsightsMetrics` |
| **Deployment** | Desired vs Available vs Ready replicas, rollout 상태 | `KubeServices` (Resource Graph / kube-state-metrics) |
| **Namespace** | ResourceQuota 사용률, LimitRange 위반 | `InsightsMetrics` (namespace 차원 집계) |
| **PV/PVC** | Disk 사용률, IOPS, latency (managed disk 기준) | `InsightsMetrics` (pvName dimension) |
| **Network** | Pod-to-Pod traffic bytes, DNS lookup latency, connection failure | `InsightsMetrics` (networkRxBytes, networkTxBytes) |

### 핵심 KQL 테이블

| 테이블 | 설명 |
|--------|------|
| `KubeNodeInventory` | 노드 목록, 상태, 라벨, OS |
| `KubePodInventory` | 파드 목록, 상태, 네임스페이스, 컨트롤러 |
| `InsightsMetrics` | CPU/Mem/Disk/Network 시계열 (Namespace=container.azm.ms/*) |
| `ContainerInventory` | 컨테이너 이미지, 상태, exit code |
| `ContainerLog` / `ContainerLogV2` | stdout/stderr 로그 텍스트 |
| `KubeEvents` | Warning/Normal 이벤트 (ImagePullBackOff, OOMKilled 등) |
| `KubeServices` | Service 목록, ClusterIP, 포트 |
| `KubeMonAgentEvents` | 모니터링 에이전트 자체 상태 |

### 1.2 애플리케이션 단위 (Application Layer)

클러스터 메트릭만으로는 앱 내부 동작을 알 수 없습니다. 이 계층은 **별도 계측(Instrumentation)이 필요**합니다.

| 메트릭 유형 | 설명 | 수집 방법 |
|-------------|------|----------|
| **HTTP 요청** | request count, latency (p50/p95/p99), error rate, status code 분포 | App Insights SDK 또는 OTel |
| **종속성 호출** | DB 쿼리 시간, 외부 API 호출 성공/실패율 | App Insights dependency tracking |
| **예외/에러** | Exception type, stack trace, 발생 빈도 | App Insights exception telemetry |
| **커스텀 메트릭** | 비즈니스 KPI (주문 수, 결제 성공률 등) | `trackMetric()` / OTel Meter |
| **분산 추적** | 서비스 간 요청 흐름, span duration, trace correlation | W3C TraceContext header 전파 |
| **Live Metrics** | 실시간 요청/실패/의존성 스트림 (1초 간격) | App Insights Live Stream |

---

## 2. 계측의 두 가지 근본 방식

### 2.1 Bytecode Instrumentation (Java Agent 방식)

JVM의 `java.lang.instrument.ClassFileTransformer` 메커니즘을 사용합니다.

```
JVM 시작
  │
  ▼
  -javaagent:applicationinsights-agent.jar
  │
  │  JVM이 클래스를 로드할 때마다 Agent에게 알림
  │  (java.lang.instrument.ClassFileTransformer)
  │
  ▼  클래스 로드 시점 — 바이트코드 변환

  [원본 바이트코드]

  public Response doGet(Request req) {
      return db.query("SELECT ...");
  }

  ─── Agent가 바이트코드를 변환(Transform) ───

  [변환된 바이트코드] (개념적 표현)

  public Response doGet(Request req) {
      Span span = tracer.startSpan("GET /api");       // ← 삽입
      try {
          Response r = db.query("SELECT ...");
          span.setStatus(OK);                          // ← 삽입
          return r;
      } catch (Exception e) {
          span.recordException(e);                     // ← 삽입
          throw e;
      } finally {
          span.end();                                  // ← 삽입
      }
  }
```

**동작 원리:**

1. JVM은 `-javaagent` 옵션이 있으면 `premain()` 메서드를 앱 `main()` 전에 실행
2. Agent가 `ClassFileTransformer`를 JVM에 등록
3. 이후 모든 클래스 로딩 시 JVM이 Agent에게 바이트코드를 전달
4. Agent는 알려진 라이브러리 패턴을 매칭
5. 매칭되면 메서드 진입/종료 지점에 측정 코드를 바이트코드 수준에서 삽입
6. **원본 소스코드는 전혀 수정되지 않음** — JVM 메모리 내에서만 변환

**Agent가 자동 감지하는 라이브러리:**

| 분류 | 라이브러리 |
|------|-----------|
| HTTP 서버 | Servlet 3.0+, Spring MVC, JAX-RS, Netty |
| HTTP 클라이언트 | HttpURLConnection, Apache HttpClient, OkHttp, WebClient |
| DB | JDBC (모든 드라이버), Hibernate, MyBatis |
| 캐시 | Redis (Lettuce, Jedis), Memcached |
| 메시징 | Kafka, RabbitMQ, JMS, Azure Service Bus |
| 로깅 | Logback, Log4j2 (로그를 trace에 자동 연결) |

### 2.2 Monkey Patching (Node.js SDK 방식)

Node.js에는 바이트코드 변환 메커니즘이 없습니다. 대신 **런타임 객체의 메서드를 덮어쓰기(Wrap)** 합니다.

```
앱 시작 시 (require 순서가 중요)

  const ai = require('applicationinsights');
  ai.setup(connectionString).start();     // ← 반드시 다른 require보다 먼저

SDK 초기화 시 내부 동작:

  // Node.js의 Module._load를 가로챔
  const originalLoad = Module._load;
  Module._load = function(name, parent) {
      const mod = originalLoad(name, parent);
      if (name === 'http') return patchHttp(mod);
      if (name === 'pg') return patchPg(mod);
      return mod;
  };

http 모듈 패칭 예시:

  function patchHttp(httpModule) {
    const originalRequest = httpModule.request;

    httpModule.request = function(options, cb) {
        const span = tracer.startSpan('HTTP OUT');
        const startTime = process.hrtime();

        // trace context를 요청 헤더에 주입
        options.headers = options.headers || {};
        options.headers['traceparent'] = span.id;

        const req = originalRequest(options, (res) => {
            span.setAttribute('http.status', res.statusCode);
            span.end();
            if (cb) cb(res);
        });
        return req;
    };

    return httpModule;
  }
```

**동작 원리:**

1. Node.js의 `require()` 시스템을 가로채서, 특정 모듈이 로드될 때 원본 함수를 래핑
2. `http.request`, `pg.Client.query`, `redis.sendCommand` 등의 메서드를 감싸서 시작/종료 시간 측정
3. **`require()` 순서가 핵심** — SDK가 먼저 로드되어야 이후 `require('http')` 시점에 패칭 적용
4. 뒤늦게 SDK를 로드하면 이미 원본 참조를 들고 있는 모듈은 패칭 불가

### 2.3 Java Agent vs Node.js SDK 비교

| | Java Agent | Node.js SDK |
|--|-----------|-------------|
| 변환 시점 | 클래스 로딩 (JVM 레벨) | `require()` 호출 (JS 레벨) |
| 변환 대상 | 바이트코드 | 함수 참조 (프로토타입) |
| 코드 수정 | 불필요 | `require()` 1줄 필요 |
| 순서 제약 | 없음 (`-javaagent`는 JVM 최초 단계) | **반드시 앱 코드 최상단** |

---

## 3. 수집 경로

데이터가 애플리케이션에서 Azure Monitor로 전달되는 세 가지 경로입니다.

### 3.1 경로 A — App Insights SDK 직접 전송 (Push)

```
  App (Pod 내부)
    │
    │  SDK/Agent 내부 버퍼
    │  [TelemetryItem, TelemetryItem, ...]
    │
    │  매 15초 또는 버퍼 500건마다 HTTPS POST
    │
    ▼
  App Insights Ingestion Endpoint
  (dc.applicationinsights.azure.com/v2/track)
    │
    ▼
  Log Analytics Workspace
    ├── requests 테이블
    ├── dependencies 테이블
    ├── exceptions 테이블
    └── customMetrics 테이블
```

**내부 동작:**

1. SDK가 텔레메트리 아이템(request, dependency, exception)을 메모리 버퍼에 저장
2. **배치 전송**: 15초 간격 또는 500건 도달 시 HTTPS POST로 일괄 전송
3. 전송 실패 시 로컬 디스크에 캐싱 → 네트워크 복구 후 재전송 (retry with backoff)
4. Ingestion endpoint가 받으면 Log Analytics 테이블에 기록

**전송 페이로드 구조:**

```json
{
  "name": "Microsoft.ApplicationInsights.Request",
  "time": "2026-03-23T10:15:30.000Z",
  "data": {
    "baseType": "RequestData",
    "baseData": {
      "id": "a1b2c3d4",
      "name": "GET /api/users",
      "duration": "00:00:00.0450000",
      "responseCode": "200",
      "success": true,
      "properties": {
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "00f067aa0ba902b7"
      }
    }
  }
}
```

### 3.2 경로 B — Container Insights (Pull — DaemonSet)

```
  AKS Node (각 노드마다)
    │
    │  Pod A (stdout) ──┐
    │  Pod B (stdout) ──┤──→ /var/log/containers/*.log
    │  Pod C (stdout) ──┘    (kubelet이 관리)
    │
    │
    ▼
  ama-logs DaemonSet (각 노드 1개)
    │
    │  1. /var/log/containers/ tail 감시 (fluentbit 기반)
    │  2. kubelet /stats/summary API 폴링 (CPU, Memory, Disk, Network)
    │  3. kube-apiserver 조회 (Pod/Node/Service 인벤토리)
    │
    │  HTTPS (60초 주기 배치)
    │
    ▼
  Log Analytics Workspace
    ├── ContainerLog / ContainerLogV2  ← stdout/stderr 텍스트
    ├── InsightsMetrics                ← CPU/Mem/Net 시계열
    ├── KubePodInventory               ← Pod 상태 스냅샷
    ├── KubeNodeInventory              ← Node 상태 스냅샷
    └── KubeEvents                     ← K8s Warning/Normal 이벤트
```

**ama-logs DaemonSet 내부 동작:**

1. **로그 수집**: fluentbit 기반. `/var/log/containers/` 디렉토리를 `tail` input 플러그인으로 감시. 새 줄이 추가되면 즉시 읽음
2. **메트릭 수집**: kubelet의 `/stats/summary` REST API를 60초마다 호출 → Pod/Container별 CPU(nanocores), Memory(bytes) 획득
3. **인벤토리 수집**: kube-apiserver에 List/Watch → Pod, Node, Service 목록과 상태를 주기적으로 스냅샷
4. **배치 전송**: 수집된 데이터를 60초 버퍼링 후 Log Analytics Data Collection Endpoint로 HTTPS POST

### 3.3 경로 C — Prometheus Scrape (Pull — /metrics)

```
  AKS Cluster
    │
    │  Nginx Pod (:9113/metrics)
    │  Spring Pod (:8080/actuator/prometheus)
    │
    │  HTTP GET /metrics (Pull 방식, 30초마다)
    │
    ▼
  ama-metrics DaemonSet (Azure Monitor Agent - Prometheus)
    │
    │  1. ServiceMonitor/PodMonitor CRD 조회 → scrape 대상 Pod 자동 발견
    │  2. 30초마다 각 Pod의 /metrics GET
    │  3. Prometheus 텍스트 형식 파싱
    │  4. Azure Monitor Workspace로 전송
    │
    ▼
  Azure Monitor Workspace (Prometheus 호환, PromQL 조회 가능)
```

**Prometheus /metrics 엔드포인트 응답 예시:**

```
# HELP nginx_connections_active Active connections
# TYPE nginx_connections_active gauge
nginx_connections_active 42

# HELP http_request_duration_seconds Request latency
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",path="/api",le="0.05"} 1024
http_request_duration_seconds_bucket{method="GET",path="/api",le="0.1"} 1589
http_request_duration_seconds_bucket{method="GET",path="/api",le="0.5"} 1632
http_request_duration_seconds_sum{method="GET",path="/api"} 78.42
http_request_duration_seconds_count{method="GET",path="/api"} 1632
```

### Pull vs Push 비교

| | App Insights (Push) | Prometheus (Pull) |
|--|---------------------|-------------------|
| 주체 | 앱이 능동적으로 전송 | 수집기가 앱에게 요청 |
| 앱 장애 시 | 마지막 버퍼 손실 가능 | scrape 실패 → 장애 자체가 알림 |
| 네트워크 | 아웃바운드 HTTPS 필요 | 클러스터 내부 HTTP만 사용 |
| 설정 복잡도 | 앱에 SDK/Agent 설정 | 앱에 /metrics 노출 + scrape config |

---

## 4. 분산 추적(Distributed Tracing) 전파 원리

서비스 간 요청을 하나의 trace로 연결하는 핵심 메커니즘입니다.

### 4.1 W3C TraceContext 표준

모든 SDK/Agent가 따르는 HTTP 헤더 표준입니다.

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │   │                                 │                │
             │   │                                 │                └─ flags (01=sampled)
             │   │                                 └─ parent-span-id (8 bytes)
             │   └─ trace-id (16 bytes, 전체 요청 고유)
             └─ version
```

### 4.2 전파 흐름

```
사용자 요청
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ Nginx (Ingress)                                      │
│                                                       │
│ traceparent 헤더 없음 → 새 TraceID 생성               │
│ traceparent: 00-{traceId}-{spanId_A}-01              │
└──────────┬────────────────────────────────────────────┘
           │  traceparent 헤더를 downstream 요청에 포함
           ▼
┌─────────────────────────────────────────────────────┐
│ Node.js API Gateway                                  │
│                                                       │
│ 수신 헤더에서 traceparent 추출:                        │
│   traceId  = 동일 값 유지                             │
│   parentId = spanId_A (Nginx의 span)                 │
│                                                       │
│ 새 SpanID 생성: spanId_B                              │
│ → Span: { traceId, spanId: B, parentId: A }          │
│                                                       │
│ Java 서비스 호출 시:                                   │
│   traceparent: 00-{traceId}-{spanId_B}-01            │
└──────────┬────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│ Java Spring Boot Service                              │
│                                                       │
│ traceparent 수신 → 동일 traceId로 Span 생성           │
│   traceId  = 동일 값 유지                             │
│   spanId   = spanId_C (새로 생성)                     │
│   parentId = spanId_B (Node.js의 span)               │
│                                                       │
│ JDBC 쿼리, Redis 호출 → 각각 child Span              │
└───────────────────────────────────────────────────────┘
```

**결과:** 하나의 traceId로 전체 요청 흐름 조회 가능

```
Nginx (50ms)
  └── Node.js API (45ms)
        ├── DB Query (8ms)
        └── Java Service (30ms)
              ├── Redis GET (2ms)
              └── DB Query (15ms)
```

**언어가 달라도 하나의 trace로 연결되는 이유:** 모든 SDK/Agent가 W3C TraceContext 표준을 따르기 때문입니다.

---

## 5. 앱별 계측 설정

### 5.1 Java Spring Boot

가장 풍부한 메트릭 수집이 가능한 스택입니다.

```
Spring Boot App
  │
  ├── [자동 계측] applicationinsights-agent.jar (-javaagent 옵션)
  │     → 코드 수정 없이 HTTP/JDBC/Redis/Kafka 자동 추적
  │
  ├── 수집 메트릭:
  │     ├── HTTP: request count, duration, status code
  │     ├── JDBC: query duration, connection pool (HikariCP active/idle/waiting)
  │     ├── JVM: heap used/max, GC pause time/count, thread count
  │     ├── Micrometer: Spring 기본 메트릭 자동 연동
  │     └── Exception: stack trace, type, 빈도
  │
  └── JVM 전용 메트릭:
        ├── jvm.memory.used / jvm.memory.max (heap, non-heap)
        ├── jvm.gc.pause (Young/Old GC duration)
        ├── jvm.threads.live / jvm.threads.daemon
        ├── process.cpu.usage
        └── hikaricp.connections.active / .idle / .pending
```

**설정:**

```dockerfile
# Dockerfile
ENV JAVA_TOOL_OPTIONS="-javaagent:/agent/applicationinsights-agent.jar"
ENV APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=xxx;IngestionEndpoint=https://..."
```

### 5.2 Node.js

```
Node.js App (Express/Fastify/NestJS 등)
  │
  ├── [SDK 방식] @applicationinsights/node
  │     → 앱 진입점 최상단에서 초기화 필수
  │
  ├── 수집 메트릭:
  │     ├── HTTP: incoming request count/duration, outgoing dependency calls
  │     ├── Event Loop: lag (이벤트 루프 포화 감지)
  │     ├── Heap: V8 heap used / total / external
  │     ├── GC: scavenge/mark-sweep duration
  │     └── Exception: unhandledRejection, uncaughtException
  │
  └── Node.js 전용 메트릭:
        ├── nodejs.eventloop.lag.p99
        ├── process.heap.used / process.heap.total
        ├── nodejs.active_handles / nodejs.active_requests
        └── http.server.duration (histogram)
```

**설정:**

```typescript
// 앱 진입점 최상단 (다른 import보다 먼저)
import * as ai from "applicationinsights";
ai.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING).start();

// 이후 앱 코드
import express from "express";
```

### 5.3 Nginx (리버스 프록시 / Ingress)

SDK 계측이 아닌 **메트릭 엔드포인트 노출** 방식입니다.

```
Nginx
  │
  ├── [메트릭 노출] nginx-prometheus-exporter (사이드카 또는 별도 Pod)
  │     → stub_status 모듈 활성화 필요
  │     → /metrics 엔드포인트 → Prometheus scrape
  │
  ├── 수집 메트릭:
  │     ├── nginx_connections_active    (현재 활성 연결 수)
  │     ├── nginx_connections_accepted  (누적 수락 연결)
  │     ├── nginx_connections_handled   (누적 처리 연결)
  │     ├── nginx_http_requests_total   (누적 HTTP 요청 수)
  │     ├── nginx_connections_reading   (요청 헤더 읽는 중)
  │     ├── nginx_connections_writing   (응답 보내는 중)
  │     └── nginx_connections_waiting   (keep-alive 대기)
  │
  └── [로그 기반 보완]
        ├── access.log → request URI, status, upstream_response_time 파싱
        └── error.log  → upstream timeout, 502/504 에러 추적
        → FluentBit/Fluentd DaemonSet → Log Analytics ContainerLog 테이블
```

**Ingress Controller 사용 시:** NGINX Ingress Controller는 기본적으로 `/metrics` (Prometheus 형식)을 노출합니다. Helm 값 `controller.metrics.enabled=true`로 활성화합니다.

**nginx.conf 설정:**

```nginx
# stub_status 활성화 (exporter가 읽을 수 있도록)
server {
    listen 8080;
    location /stub_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
    }
}
```

### 5.4 Tomcat

```
Tomcat (WAR 배포 또는 Embedded)
  │
  ├── [Java Agent 방식] applicationinsights-agent.jar (Spring Boot과 동일)
  │     → Servlet 요청/JDBC/JMX 자동 캡처
  │
  └── Tomcat 전용 메트릭:
        ├── tomcat.threads.busy / tomcat.threads.config.max
        ├── tomcat.sessions.active.current / .max
        ├── tomcat.global.request.count / .max.time
        ├── tomcat.global.error (서블릿 에러 수)
        ├── tomcat.global.sent / .received (바이트)
        └── tomcat.cache.hit / .miss (정적 리소스 캐시)
```

**설정:**

```bash
# Standalone Tomcat
export CATALINA_OPTS="-javaagent:/agent/applicationinsights-agent.jar"
export APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=xxx;..."
```

Spring Boot Embedded Tomcat인 경우 Micrometer가 위 메트릭을 자동 노출하므로 별도 설정이 필요 없습니다.

---

## 6. 로그 수집 체계

### 6.1 공통 수집 경로

```
Pod stdout/stderr
       │
       ▼
/var/log/containers/*.log (kubelet 관리)
       │
       ▼
ama-logs DaemonSet (AKS 기본 설치)
       │
       ▼  HTTPS (60초 주기)
Log Analytics Workspace
  ├── ContainerLog    ← stdout/stderr 전문 (레거시)
  └── ContainerLogV2  ← 구조화 (JSON 파싱 지원, 권장)
```

### 6.2 앱별 로그 출력

모든 앱은 **stdout/stderr로 출력하면 자동 수집**됩니다.

| 앱 | 로그 출력 방식 |
|----|---------------|
| Java/Spring Boot | Logback/Log4j2 → stdout (Console Appender) |
| Node.js | console.log / winston / pino → stdout |
| Nginx | access.log, error.log → stdout/stderr (Docker 컨테이너 표준) |
| Tomcat | catalina.out → stdout |

### 6.3 구조화 로그 권장

JSON 형식으로 출력하면 `ContainerLogV2` 테이블에서 필드 단위 KQL 조회가 가능합니다.

```json
{"timestamp":"2026-03-23T10:15:30Z","level":"ERROR","message":"DB connection timeout","service":"order-api","traceId":"4bf92f35...","duration_ms":5000}
```

```kusto
// KQL 조회 예시
ContainerLogV2
| where LogMessage has "ERROR"
| extend parsed = parse_json(LogMessage)
| project TimeGenerated, parsed.service, parsed.message, parsed.traceId
```

---

## 7. Observability 백엔드 데이터 조회 방식

현재 프로젝트의 API 서버가 Azure Monitor에서 데이터를 조회하는 구조입니다.

```
observability API routes (Express)
  │
  │  /api/observability/overview
  │  /api/observability/workloads
  │  /api/observability/nodes
  │
  ├─────────────────────┐
  │                      │
  ▼                      ▼
containerInsights       appInsightsApm
Collector.ts            Collector.ts
  │                      │
  │ KQL 쿼리 실행:       │ ARM REST API:
  │ POST /v1/workspaces/ │ GET /providers/microsoft.insights/metrics
  │   {wsId}/query       │   ?metricnames=requests/count,requests/duration,...
  │                      │
  ▼                      ▼
getLogAnalyticsFetcher  getArmFetcherAuto()
Auto()                    │
  │                      │
  │  OBO 토큰 → SP      │  OBO 토큰 → SP fallback
  │  fallback            │  (사용자 토큰 기반)
  │                      │
  ▼                      ▼
Log Analytics API       Azure Monitor Metrics API
(KQL 엔진)              (시계열 엔진)
```

**containerInsightsCollector KQL 예시:**

```kusto
KubePodInventory
| where ClusterId contains "{clusterId}"
| where TimeGenerated > ago(5m)
| summarize
    TotalPods = dcount(PodUid),
    RunningPods = dcountif(PodUid, PodStatus == "Running"),
    PendingPods = dcountif(PodUid, PodStatus == "Pending"),
    FailedPods  = dcountif(PodUid, PodStatus == "Failed")
  by Namespace, ControllerName
```

---

## 8. AKS 로그 수집 아키텍처 심층 분석

> 참고 문서:
> - [Azure: AKS 모니터링](https://learn.microsoft.com/ko-kr/azure/aks/monitor-aks)
> - [Kubernetes: 로깅 아키텍처](https://kubernetes.io/ko/docs/concepts/cluster-administration/logging/)

---

### 8.1 AKS 로그 분류 체계

AKS 클러스터 운영에서 수집되는 로그는 **4계층**으로 분류됩니다.

```
┌────────────────────────────────────────────────────────────┐
│  Layer 1: Control Plane Logs (관리형, Azure 관리)            │
│  ── kube-apiserver, kube-scheduler, kube-controller-manager │
│  ── cloud-controller-manager, cluster-autoscaler, guard     │
│  ── 진단 설정(Diagnostic Settings)으로 수집 활성화           │
├────────────────────────────────────────────────────────────┤
│  Layer 2: Node Logs (인프라 계층)                            │
│  ── kubelet, container runtime (containerd)                  │
│  ── syslog, journald                                        │
│  ── /var/log/syslog, /var/log/kern.log                      │
├────────────────────────────────────────────────────────────┤
│  Layer 3: Container Logs (워크로드 계층)                     │
│  ── Pod stdout/stderr → /var/log/containers/*.log           │
│  ── kubelet이 로그 로테이션 관리                             │
│  ── Container Insights 또는 DaemonSet 에이전트로 수집        │
├────────────────────────────────────────────────────────────┤
│  Layer 4: Application Logs (애플리케이션 계층)               │
│  ── 구조화 로그 (JSON), 분산 추적 (traceId)                  │
│  ── App Insights SDK/Agent 또는 OTel로 수집                 │
│  ── 파일 기반 로그는 Sidecar 또는 Volume Mount 필요          │
└────────────────────────────────────────────────────────────┘
```

#### 각 계층별 수집 이유와 활용

| 계층 | 수집 이유 | 핵심 활용 시나리오 | 수집 방법 |
|------|----------|-------------------|----------|
| **Control Plane** | API 호출 감사, RBAC 위반 탐지, 스케줄링 실패 원인 | 보안 감사, 장애 원인 분석, 규정 준수 | 진단 설정 → Log Analytics |
| **Node** | kubelet 장애, OOM Kill 이벤트, 디스크 압력, 네트워크 문제 | 노드 장애 RCA, 커널 패닉 추적 | Container Insights Syslog 수집 |
| **Container** | Pod stdout/stderr, 앱 런타임 에러, 시작/종료 로그 | 실시간 디버깅, 배포 검증, 에러 추적 | Container Insights 또는 K8s API 직접 |
| **Application** | HTTP 요청 성능, DB 쿼리 지연, 분산 추적, 비즈니스 KPI | SLA 모니터링, 성능 최적화, 장애 추적 | App Insights SDK / OTel |

#### Control Plane 로그 세부 분류

| 범주 | 테이블 (리소스별 모드) | 설명 | 비용 |
|------|----------------------|------|------|
| `kube-audit` | `AKSAudit` | 모든 API 감사 이벤트 (get/list 포함) | **매우 높음** |
| `kube-audit-admin` | `AKSAuditAdmin` | get/list 제외 감사 이벤트 | 중간 (권장) |
| `kube-apiserver` | `AKSControlPlane` | API 서버 로그 | 낮음 |
| `kube-controller-manager` | `AKSControlPlane` | 컨트롤러 관리자 로그 | 낮음 |
| `kube-scheduler` | `AKSControlPlane` | 스케줄러 결정 로그 | 낮음 |
| `cluster-autoscaler` | `AKSControlPlane` | 오토스케일러 활동 | 낮음 |
| `cloud-controller-manager` | `AKSControlPlane` | Azure 리소스 조정 로그 | 낮음 |
| `guard` | `AKSControlPlane` | Azure AD 인증 로그 | 낮음 |

> **비용 최적화**: `kube-audit` 대신 `kube-audit-admin`을 사용하면 get/list 이벤트를 제외하여 로그 볼륨이 약 90% 감소합니다. `AKSAudit` 테이블은 **기본 로그(Basic Logs)** 계층으로 설정하면 수집 비용을 추가로 절감할 수 있습니다.

---

### 8.2 자원 최적화 로그 수집 전략

#### DCR(Data Collection Rules) 기반 최적화

Container Insights의 DCR을 통해 수집 범위를 세밀하게 제어할 수 있습니다.

```
┌─ DCR 설정 항목 ──────────────────────────────────────┐
│                                                        │
│  1. 테이블 선택 (수집 그룹)                             │
│     ├── "모두" (기본값) — 모든 CI 테이블                │
│     ├── "로그 및 이벤트" — ContainerLogV2 + KubeEvents  │  ← 권장
│     ├── "성능" — Perf + InsightsMetrics만               │
│     └── "워크로드" — InsightsMetrics + KubePodInventory │
│                                                        │
│  2. 네임스페이스 필터                                   │
│     ├── 포함할 네임스페이스 지정                         │
│     └── 제외할 네임스페이스 지정                         │
│     → kube-system 등 시스템 NS 제외 시 비용 대폭 절감   │
│                                                        │
│  3. 수집 간격                                           │
│     ├── 기본: 60초                                      │
│     └── 최소: 15초 / 최대: 30분                         │
│     → 간격 늘리면 볼륨 감소, 실시간성 저하               │
│                                                        │
│  4. ContainerLogV2 활성화                               │
│     ├── 기본 로그(Basic Logs) 계층 호환                  │
│     ├── 구조화 필드: PodNamespace, PodName, ContainerName│
│     └── JSON 파싱 지원 → KQL 필드 단위 조회              │
│                                                        │
└────────────────────────────────────────────────────────┘
```

#### 비용 최적화 매트릭스

| 전략 | 절감 효과 | 트레이드오프 |
|------|----------|-------------|
| `kube-audit-admin` 사용 (kube-audit 대신) | 로그 볼륨 ~90% 감소 | get/list 감사 이벤트 손실 |
| 리소스별 모드 + Basic Logs 계층 | 수집 비용 ~67% 절감 | 30일 보존, 동시 쿼리 제한 |
| 네임스페이스 제외 (kube-system 등) | 시스템 NS 로그 비용 제거 | 시스템 문제 디버깅 불가 |
| 수집 그룹 = "로그 및 이벤트" + Prometheus | CI 테이블 수 감소 | CI 기본 UI 일부 비활성화 |
| ContainerLogV2 스키마 사용 | 구조화 쿼리 가능, Basic Logs 호환 | 레거시 쿼리 마이그레이션 필요 |
| 수집 간격 5분으로 확대 | 볼륨 ~80% 감소 | 5분 지연 발생 |

#### 노드 자원 최적화

```yaml
# kubelet 로그 로테이션 설정 (kubelet config)
containerLogMaxSize: "10Mi"       # 단일 로그 파일 최대 크기 (기본값)
containerLogMaxFiles: 5           # 컨테이너당 최대 로그 파일 수 (기본값)
containerLogMaxWorkers: 4         # 동시 로테이션 워커 수 (v1.30+)
containerLogMonitorInterval: "10s" # 로테이션 모니터링 간격 (v1.30+)
```

> **중요**: `kubectl logs`는 **가장 최근 로그 파일만** 반환합니다. 40MiB 로그를 10MiB로 로테이션하면 `kubectl logs`에서는 최신 10MiB만 볼 수 있습니다.

---

### 8.3 Pod 비정상 종료 시 로그 보존 전략

Kubernetes 기본 동작:
- Pod 재시작 시: kubelet이 직전 컨테이너 1개의 로그만 보존
- Pod 퇴출(eviction) 시: 컨테이너와 로그 **모두 삭제**
- CrashLoopBackOff 시: 매 재시작마다 이전 로그 덮어쓰기

```
Pod 비정상 종료
  │
  ├── Case 1: 컨테이너 재시작 (CrashLoopBackOff, OOMKilled)
  │     └── kubelet이 직전 컨테이너 1개 로그 보존
  │         → kubectl logs <pod> --previous  ✅ 조회 가능
  │         → K8s API: ?previous=true
  │
  ├── Case 2: Pod 퇴출 (Eviction, Node 장애)
  │     └── 노드에서 로그 파일 삭제됨
  │         → kubectl logs --previous  ❌ 불가
  │         → 사전에 외부로 수집되지 않았다면 손실
  │
  └── Case 3: 노드 자체 장애 (커널 패닉, VM 재시작)
        └── 로컬 디스크 로그는 VM 재시작 후에도 존재할 수 있으나
            → Pod는 다른 노드에 재스케줄링되므로 접근 어려움
```

#### 해결 방안

| 방안 | 구현 방법 | 보존 범위 | 비용 |
|------|----------|----------|------|
| **1. Container Insights (기본)** | ama-logs DaemonSet가 실시간으로 /var/log/containers/ 감시 → Log Analytics 전송 | Pod 종료 전까지 수집된 모든 로그 | Log Analytics 수집 비용 |
| **2. K8s API `previous` 플래그** | `readNamespacedPodLog({ previous: true })` | 직전 컨테이너 1회분 | 무료 (API 호출) |
| **3. Fluent Bit DaemonSet (OSS)** | 노드의 /var/log/containers/ tail → 외부 저장소 전송 | 실시간 수집, Pod 종료 전 로그 보존 | 에이전트 리소스 + 저장소 비용 |
| **4. Persistent Volume 로그** | 앱이 PVC에 로그 파일 기록 | Pod 삭제 후에도 PVC에 보존 | PV 비용 |
| **5. Sidecar 로그 전달** | Sidecar 컨테이너가 앱 로그 파일 → stdout 으로 릴레이 | kubelet + DaemonSet 이중 수집 | Sidecar 리소스 오버헤드 |

#### 프로젝트 적용: `--previous` 플래그 지원

현재 구현된 K8s API 기반 로그 수집에서 `previous` 옵션을 활용하면 종료된 컨테이너의 로그를 조회할 수 있습니다.

```typescript
// apps/api/src/services/kubernetes.ts — readPodLogs()
await coreV1.readNamespacedPodLog({
  name: podName,
  namespace,
  previous: true,         // 직전 종료 컨테이너 로그 조회
  tailLines: 500,
  timestamps: true,
});
```

---

### 8.4 애플리케이션 운영 로그 수집 체계

#### Kubernetes 로깅 아키텍처 패턴 비교

```
┌──────────────────────────────────────────────────────────┐
│  Pattern 1: Node-level Agent (DaemonSet)                  │
│  ── 가장 일반적, 앱 수정 불필요                            │
│                                                           │
│  [Pod A] stdout ──┐                                       │
│  [Pod B] stdout ──┼──→ /var/log/containers/               │
│  [Pod C] stdout ──┘         │                             │
│                         [DaemonSet Agent]                  │
│                         (ama-logs / fluent-bit)            │
│                              │                             │
│                         외부 저장소                         │
├──────────────────────────────────────────────────────────┤
│  Pattern 2: Streaming Sidecar                              │
│  ── 파일 로그를 stdout으로 중계                             │
│                                                           │
│  [App Container] ──파일──→ [Sidecar: tail -f] → stdout     │
│                            └─→ DaemonSet이 수집            │
│                                                           │
│  사용 시점: 앱이 stdout 대신 파일로 로깅하는 경우            │
├──────────────────────────────────────────────────────────┤
│  Pattern 3: Logging Agent Sidecar                          │
│  ── Pod마다 전용 에이전트 (비용 높음, 유연성 높음)           │
│                                                           │
│  [App Container] ──파일──→ [Sidecar: fluent-bit agent]     │
│                            └─→ 직접 외부 전송               │
│                                                           │
│  사용 시점: 복잡한 파싱, 멀티라인, 특수 형식 필요 시         │
├──────────────────────────────────────────────────────────┤
│  Pattern 4: Direct Push (SDK 내장)                         │
│  ── 앱이 직접 백엔드로 전송                                 │
│                                                           │
│  [App Container] ──SDK──→ App Insights / OTel Collector     │
│                                                           │
│  사용 시점: 분산 추적, APM 메트릭 필요 시                    │
└──────────────────────────────────────────────────────────┘
```

#### 권장 구성: 계층별 최적 조합

```
애플리케이션 계층      ← App Insights SDK / OTel (Pattern 4)
  │ 분산 추적, APM 메트릭, 예외 추적
  │
컨테이너 계층          ← DaemonSet Agent (Pattern 1) + K8s API 직접
  │ stdout/stderr 로그 수집
  │
노드/인프라 계층       ← Container Insights (Syslog + InsightsMetrics)
  │ kubelet, OS 로그, CPU/Mem/Disk 메트릭
  │
컨트롤 플레인          ← 진단 설정 (Diagnostic Settings)
  │ kube-audit-admin, kube-apiserver 등
```

#### 구조화 로그 표준 (앱에서 준수해야 할 형식)

```json
{
  "timestamp": "2026-03-24T10:15:30.123Z",
  "level": "ERROR",
  "logger": "com.example.OrderService",
  "message": "Payment processing failed",
  "service": "order-api",
  "namespace": "production",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "error": {
    "type": "PaymentGatewayTimeout",
    "message": "Connection timeout after 5000ms",
    "stackTrace": "..."
  },
  "context": {
    "orderId": "ORD-12345",
    "userId": "USR-67890",
    "amount": 29900
  }
}
```

이렇게 출력하면:
- ContainerLogV2 테이블에서 `parse_json(LogMessage)`로 필드 단위 KQL 쿼리 가능
- traceId로 App Insights 분산 추적과 연결 가능
- 비즈니스 컨텍스트(orderId, userId)로 고객 영향 범위 파악

---

### 8.5 로그 수집 방안 비교: Azure Native vs 오픈소스

#### 방안 A — Azure Native (Container Insights + App Insights)

```
┌─ Azure Native Stack ──────────────────────────────────┐
│                                                        │
│  수집                                                   │
│  ├── ama-logs DaemonSet (Container Insights)            │
│  │     └── stdout/stderr → ContainerLogV2               │
│  │     └── 메트릭 → InsightsMetrics                     │
│  ├── ama-metrics DaemonSet (Prometheus scrape)          │
│  │     └── /metrics → Azure Monitor Workspace           │
│  ├── 진단 설정 (Control Plane logs)                     │
│  │     └── kube-audit-admin → AKSAuditAdmin             │
│  └── App Insights SDK (앱 APM)                          │
│        └── requests/dependencies → Log Analytics        │
│                                                        │
│  저장소                                                  │
│  ├── Log Analytics Workspace (KQL 쿼리)                 │
│  └── Azure Monitor Workspace (PromQL 쿼리)              │
│                                                        │
│  시각화                                                  │
│  ├── Azure Portal (Container Insights UI)               │
│  ├── Azure Managed Grafana (Prometheus 대시보드)         │
│  └── 커스텀 대시보드 (본 프로젝트)                       │
│                                                        │
│  장점                                                   │
│  ├── AKS와 네이티브 통합 (1-click 활성화)               │
│  ├── 관리형 서비스 (패치/스케일링 Azure 책임)            │
│  ├── Azure RBAC/MSAL 통합 인증                          │
│  └── 진단 설정으로 Control Plane 로그 수집 가능          │
│                                                        │
│  단점                                                   │
│  ├── Azure 종속 (다른 클라우드/온프렘 이식 불가)         │
│  ├── Log Analytics 수집 비용 높음 (GB당 과금)            │
│  ├── 데이터 지연 (수집→쿼리 가능까지 2~5분)             │
│  ├── DCR 설정이 복잡하고 네임스페이스 필터 제한적         │
│  └── ContainerLogV2 스키마 변경 시 쿼리 호환성 문제       │
│                                                        │
└────────────────────────────────────────────────────────┘
```

#### 방안 B — 오픈소스 (Fluent Bit + Loki + Grafana)

```
┌─ Open Source Stack ────────────────────────────────────┐
│                                                        │
│  수집                                                   │
│  ├── Fluent Bit DaemonSet                               │
│  │     └── /var/log/containers/ tail → Loki             │
│  │     └── 필터/파서 파이프라인 (multiline, JSON 등)     │
│  ├── Prometheus (kube-prometheus-stack)                  │
│  │     └── ServiceMonitor/PodMonitor → Prometheus TSDB  │
│  └── OpenTelemetry Collector (앱 APM)                   │
│        └── traces/metrics/logs → 다중 백엔드             │
│                                                        │
│  저장소                                                  │
│  ├── Grafana Loki (로그, LogQL)                         │
│  ├── Prometheus / Thanos (메트릭, PromQL)               │
│  └── Tempo / Jaeger (분산 추적)                          │
│                                                        │
│  시각화                                                  │
│  └── Grafana (통합 대시보드: 로그 + 메트릭 + 추적)       │
│                                                        │
│  장점                                                   │
│  ├── 클라우드 독립적 (AWS/GCP/온프렘 이식 가능)          │
│  ├── 비용 효율적 (S3/Blob 저장, 인덱싱 최소화)          │
│  ├── CNCF 표준 (OpenTelemetry, Prometheus)              │
│  ├── 실시간 로그 스트리밍 (Loki live tail)              │
│  ├── 유연한 파이프라인 (Fluent Bit 필터/라우팅)          │
│  └── 커뮤니티 활발, 대시보드 풍부                        │
│                                                        │
│  단점                                                   │
│  ├── 자체 운영 부담 (설치/업그레이드/스케일링)           │
│  ├── AKS Control Plane 로그 직접 수집 불가               │
│  │   (진단 설정은 Azure 전용 → Event Hub로 브리지 필요)  │
│  ├── 스토리지 관리 필요 (PV 또는 Object Storage)         │
│  └── 보안/인증을 별도 구성 필요                          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

#### 방안 C — 하이브리드 (권장)

```
┌─ Hybrid Architecture (권장) ──────────────────────────┐
│                                                        │
│  Azure Native (대체 불가능한 영역)                       │
│  ├── 진단 설정 → kube-audit-admin, kube-apiserver       │
│  │   (Control Plane 로그는 Azure에서만 수집 가능)        │
│  ├── App Insights → APM 분산 추적                       │
│  │   (또는 OTel → Azure Monitor Exporter)               │
│  └── 플랫폼 메트릭 (자동 수집, 무료)                     │
│                                                        │
│  K8s API 직접 (실시간 조회, 본 프로젝트 현재 구현)       │
│  ├── coreV1.listPodForAllNamespaces() → 네임스페이스/Pod │
│  ├── coreV1.readNamespacedPodLog() → 실시간 로그         │
│  └── coreV1.readNamespacedPodLog({ previous: true })     │
│      → 종료된 컨테이너 로그                               │
│                                                        │
│  오픈소스 (장기 보존 + 비용 최적화)                      │
│  ├── Fluent Bit DaemonSet → Azure Blob Storage           │
│  │   (또는 Grafana Loki)                                 │
│  │   → 장기 로그 아카이브 (30일+)                        │
│  ├── Prometheus (Azure Managed 또는 자체 운영)            │
│  │   → 인프라/앱 메트릭                                   │
│  └── Grafana → Prometheus + Loki 통합 대시보드            │
│                                                        │
│  수집 흐름:                                               │
│                                                        │
│  Pod stdout ──→ /var/log/containers/                     │
│                    │                                     │
│                    ├──→ K8s API (실시간 조회, 본 대시보드) │
│                    │                                     │
│                    ├──→ ama-logs (Container Insights)     │
│                    │      └─→ Log Analytics (KQL 분석)    │
│                    │                                     │
│                    └──→ Fluent Bit (OSS DaemonSet)        │
│                           └─→ Loki / Blob (장기 보존)     │
│                                                        │
│  Control Plane ──→ 진단 설정 ──→ Log Analytics            │
│  (Azure 전용)       또는 Event Hub → Fluent Bit → Loki    │
│                                                        │
└────────────────────────────────────────────────────────┘
```

#### 방안 비교 종합

| 평가 항목 | Azure Native | 오픈소스 (Loki) | 하이브리드 (권장) |
|----------|-------------|----------------|-----------------|
| **Control Plane 로그** | 진단 설정으로 직접 수집 | Event Hub 브리지 필요 | Azure 진단 설정 사용 |
| **Container 로그 (실시간)** | 2~5분 지연 | Loki live tail (~1초) | K8s API 직접 (0초) |
| **Container 로그 (장기 보존)** | Log Analytics (비쌈) | Loki + Object Storage (저렴) | Fluent Bit → Blob/Loki |
| **APM/분산 추적** | App Insights (강력) | Jaeger/Tempo | App Insights 또는 OTel |
| **메트릭** | Azure Monitor + Prometheus Managed | Prometheus 자체 운영 | Azure Managed Prometheus |
| **시각화** | Azure Portal + Grafana Managed | Grafana 자체 운영 | 본 대시보드 + Grafana |
| **클라우드 이식성** | Azure 종속 | 완전 이식 가능 | Control Plane만 Azure 종속 |
| **운영 부담** | 낮음 (관리형) | 높음 (자체 운영) | 중간 |
| **비용** | 높음 (GB당 과금) | 낮음 (스토리지만) | 중간 |
| **설치 복잡도** | 낮음 (Portal 1-click) | 중간 (Helm chart) | 중간 |

---

### 8.6 프로젝트 적용 권장사항

#### 단기 (현재 — 즉시 적용 가능)

1. **K8s API 직접 조회** (이미 구현됨)
   - 네임스페이스/Pod 실시간 목록
   - Pod 로그 실시간 조회 + `--previous` 지원
   - Container Insights 의존성 제거

2. **Container Insights DCR 최적화**
   - 수집 그룹: "로그 및 이벤트" (ContainerLogV2 + KubeEvents + KubePodInventory)
   - `kube-audit` → `kube-audit-admin`으로 전환
   - `AKSAudit` 테이블 → Basic Logs 계층 설정

3. **진단 설정 활성화**
   - 리소스별 모드로 kube-audit-admin, kube-apiserver, kube-scheduler 수집

#### 중기 (1~2개월)

4. **Fluent Bit DaemonSet 배포**
   ```yaml
   # Helm: fluent/fluent-bit
   # 장기 로그 아카이브 → Azure Blob Storage 또는 Loki
   config:
     inputs: |
       [INPUT]
           Name              tail
           Path              /var/log/containers/*.log
           Parser            cri
           Tag               kube.*
           Mem_Buf_Limit     5MB
           Skip_Long_Lines   On
     filters: |
       [FILTER]
           Name              kubernetes
           Match             kube.*
           K8S-Logging.Parser On
     outputs: |
       [OUTPUT]
           Name              azure_blob
           Match             kube.*
           account_name      ${STORAGE_ACCOUNT}
           shared_key        ${STORAGE_KEY}
           container_name    aks-logs
           auto_create_container on
           blob_type         appendblob
   ```

5. **구조화 로그 표준 적용**
   - 모든 앱에서 JSON 형식 stdout 출력
   - traceId/spanId 필수 포함

#### 장기 (3개월+)

6. **OpenTelemetry 전환**
   - App Insights SDK → OTel SDK로 점진적 마이그레이션
   - OTel Collector → Azure Monitor Exporter + Loki Exporter 이중 전송
   - 클라우드 독립적 관측 파이프라인 완성

---

## 9. 요약

### 앱별 필요 조치

| 앱 | 계측 방법 | 코드 수정 | 핵심 설정 |
|----|----------|----------|----------|
| **Java/Spring Boot** | `applicationinsights-agent.jar` | 없음 | `JAVA_TOOL_OPTIONS` 환경변수 |
| **Tomcat (standalone)** | 동일 Java Agent | 없음 | `CATALINA_OPTS`에 `-javaagent` |
| **Node.js** | `@applicationinsights/node` SDK | `require()` 1줄 | `APPLICATIONINSIGHTS_CONNECTION_STRING` |
| **Nginx** | `nginx-prometheus-exporter` 사이드카 | 없음 | `stub_status` 모듈 활성화 |

### 수집 경로 요약

| 경로 | 방식 | 수집 대상 | 저장소 |
|------|------|----------|--------|
| App Insights SDK | Push (앱→Azure) | HTTP 요청, 종속성, 예외, 커스텀 메트릭 | Log Analytics (requests, dependencies 등) |
| Container Insights | Pull (DaemonSet) | stdout/stderr 로그, CPU/Mem, Pod/Node 상태 | Log Analytics (ContainerLog, InsightsMetrics 등) |
| Prometheus | Pull (scrape) | /metrics 엔드포인트 노출 메트릭 | Azure Monitor Workspace (PromQL) |

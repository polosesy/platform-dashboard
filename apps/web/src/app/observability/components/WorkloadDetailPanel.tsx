"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  WorkloadHealth,
  WorkloadDetailResponse,
  WorkloadPodDetail,
  WorkloadServiceInfo,
  WorkloadContainerDetail,
  JvmMetrics,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.metricRow}>
      <span className={styles.metricRowLabel}>{label}</span>
      <span className={styles.metricRowValue}>{value}</span>
    </div>
  );
}

function JvmSection({ jvm }: { jvm: JvmMetrics }) {
  const heapPct = jvm.heapUsedPct !== null ? Math.round(jvm.heapUsedPct) : null;
  const heapCls = heapPct !== null
    ? heapPct >= 85 ? styles.gaugeCrit : heapPct >= 70 ? styles.gaugeWarn : styles.gaugeOk
    : "";

  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>JVM 메트릭</p>
      {heapPct !== null && (
        <div style={{ marginBottom: 10 }}>
          <div className={styles.gaugeLabel} style={{ marginBottom: 4 }}>Heap 사용률</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className={styles.gaugeBar} style={{ width: 120 }}>
              <div className={`${styles.gaugeFill} ${heapCls}`} style={{ width: `${heapPct}%` }} />
            </div>
            <span className={styles.gaugeLabel}>{heapPct}% ({jvm.heapUsedMiB ?? "?"} / {jvm.heapMaxMiB ?? "?"}Mi)</span>
          </div>
        </div>
      )}
      {jvm.gcTimeMs !== null && <MetricRow label="GC 시간 (1분)" value={`${jvm.gcTimeMs}ms`} />}
      {jvm.gcCount !== null && <MetricRow label="GC 횟수 (1분)" value={jvm.gcCount} />}
      {jvm.threadCount !== null && (
        <MetricRow
          label="스레드"
          value={jvm.threadBlocked !== null ? `${jvm.threadCount} (차단: ${jvm.threadBlocked})` : jvm.threadCount}
        />
      )}
      {jvm.classesLoaded !== null && <MetricRow label="클래스 로드" value={jvm.classesLoaded.toLocaleString()} />}
    </div>
  );
}

// ── Pod age formatting ──
function formatAge(isoString: string): string {
  if (!isoString) return "—";
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

// ── Container state badge ──
function ContainerStateBadge({ state, reason }: { state: string; reason?: string }) {
  const cls =
    state === "running" ? styles.podStatusRunning
    : state === "waiting" ? styles.podStatusWaiting
    : state === "terminated" ? styles.podStatusTerminated
    : styles.podStatusUnknown;
  return (
    <span className={`${styles.podStatusBadge} ${cls}`} title={reason}>
      {state}{reason ? ` (${reason})` : ""}
    </span>
  );
}

// ── Sub-components for detail sections ──

function PodDetailRow({ pod }: { pod: WorkloadPodDetail }) {
  const [expanded, setExpanded] = useState(false);
  const totalRestarts = pod.containers.reduce((s, c) => s + c.restartCount, 0);
  const readyCount = pod.containers.filter((c) => c.ready).length;

  return (
    <div className={styles.podDetailItem}>
      <div className={styles.podDetailHeader} onClick={() => setExpanded(!expanded)}>
        <span className={styles.podDetailChevron}>{expanded ? "▾" : "▸"}</span>
        <span className={styles.podDetailName} title={pod.name}>{pod.name}</span>
        <span className={`${styles.podStatusBadge} ${pod.status === "Running" ? styles.podStatusRunning : pod.status === "Pending" ? styles.podStatusWaiting : styles.podStatusTerminated}`}>
          {pod.status}
        </span>
        <span className={styles.podDetailMeta}>{readyCount}/{pod.containers.length}</span>
        {totalRestarts > 0 && <span className={styles.podDetailRestarts}>↻{totalRestarts}</span>}
      </div>

      {expanded && (
        <div className={styles.podDetailBody}>
          <div className={styles.podDetailMiniRow}>
            <span>IP</span><span className={styles.podDetailMono}>{pod.podIP || "—"}</span>
          </div>
          <div className={styles.podDetailMiniRow}>
            <span>노드</span><span className={styles.podDetailMono}>{pod.nodeName || "—"}</span>
          </div>
          <div className={styles.podDetailMiniRow}>
            <span>Age</span><span>{formatAge(pod.startTime)}</span>
          </div>

          {pod.containers.map((c) => (
            <div key={c.name} className={styles.containerDetail}>
              <div className={styles.containerDetailHeader}>
                <span className={styles.containerDetailName}>{c.name}</span>
                <ContainerStateBadge state={c.state} reason={c.stateReason} />
              </div>
              <div className={styles.containerDetailBody}>
                <div className={styles.podDetailMiniRow}>
                  <span>이미지</span>
                  <span className={styles.podDetailMono} title={c.image}>
                    {c.image.length > 45 ? "…" + c.image.slice(-42) : c.image}
                  </span>
                </div>
                {c.ports.length > 0 && (
                  <div className={styles.podDetailMiniRow}>
                    <span>포트</span>
                    <span>{c.ports.map((p) => `${p.containerPort}/${p.protocol}`).join(", ")}</span>
                  </div>
                )}
                {c.resourceRequests && (
                  <div className={styles.podDetailMiniRow}>
                    <span>Requests</span>
                    <span>{c.resourceRequests.cpu || "—"} / {c.resourceRequests.memory || "—"}</span>
                  </div>
                )}
                {c.resourceLimits && (
                  <div className={styles.podDetailMiniRow}>
                    <span>Limits</span>
                    <span>{c.resourceLimits.cpu || "—"} / {c.resourceLimits.memory || "—"}</span>
                  </div>
                )}
                {c.restartCount > 0 && (
                  <div className={styles.podDetailMiniRow}>
                    <span>재시작</span>
                    <span style={{ color: "rgba(196,43,28,0.85)" }}>{c.restartCount}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceSection({ services }: { services: WorkloadServiceInfo[] }) {
  if (services.length === 0) return null;
  return (
    <div className={styles.detailSection}>
      <p className={styles.detailSectionTitle}>서비스 / 엔드포인트</p>
      {services.map((svc) => (
        <div key={svc.name} className={styles.svcCard}>
          <div className={styles.svcCardHeader}>
            <span className={styles.svcCardName}>{svc.name}</span>
            <span className={styles.svcTypeBadge}>{svc.type}</span>
          </div>
          <div className={styles.podDetailMiniRow}>
            <span>Cluster IP</span>
            <span className={styles.podDetailMono}>{svc.clusterIP || "None"}</span>
          </div>
          {svc.externalIP && (
            <div className={styles.podDetailMiniRow}>
              <span>External IP</span>
              <span className={styles.podDetailMono}>{svc.externalIP}</span>
            </div>
          )}
          {svc.ports.length > 0 && (
            <div className={styles.podDetailMiniRow}>
              <span>포트</span>
              <span>
                {svc.ports.map((p) =>
                  `${p.port}→${p.targetPort}/${p.protocol}${p.nodePort ? ` (NP:${p.nodePort})` : ""}`
                ).join(", ")}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function WorkloadDetailPanel({
  wl,
  clusterId,
  onClose,
}: {
  wl: WorkloadHealth;
  clusterId: string;
  onClose: () => void;
}) {
  const getApiToken = useApiToken();
  const { name, namespace, kind, pods, cpu, memory, apm, jvm } = wl;

  const [detail, setDetail] = useState<WorkloadDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!clusterId || !namespace || !name) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const token = await getApiToken();
      const base = apiBaseUrl();
      const params = new URLSearchParams({ clusterId, namespace, workloadName: name, kind });
      const data = await fetchJsonWithBearer<WorkloadDetailResponse>(
        `${base}/api/observability/workloads/detail?${params}`,
        token,
      );
      setDetail(data);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, [clusterId, namespace, name, kind, getApiToken]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const errorPct = apm?.errorRate !== null && apm?.errorRate !== undefined
    ? Math.round(apm.errorRate * 100)
    : null;

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className={styles.detailKind}>{kind}</span>
          </div>
          <p className={styles.detailTitle}>{name}</p>
          <p className={styles.detailNs}>{namespace}</p>
        </div>
        <button className={styles.detailClose} onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className={styles.detailBody}>
        {/* Pod Summary */}
        <div className={styles.detailSection}>
          <p className={styles.detailSectionTitle}>파드 상태</p>
          <MetricRow label="전체" value={pods.total} />
          <MetricRow
            label="Running"
            value={<span style={{ color: "rgba(16,137,62,0.85)" }}>{pods.running}</span>}
          />
          {pods.pending > 0 && (
            <MetricRow
              label="Pending"
              value={<span style={{ color: "rgba(209,132,0,0.85)" }}>{pods.pending}</span>}
            />
          )}
          {pods.failed > 0 && (
            <MetricRow
              label="Failed"
              value={<span style={{ color: "rgba(196,43,28,0.85)" }}>{pods.failed}</span>}
            />
          )}
          {pods.restarts > 0 && (
            <MetricRow
              label="재시작 횟수"
              value={<span style={{ color: "rgba(196,43,28,0.75)" }}>{pods.restarts}</span>}
            />
          )}
        </div>

        {/* Resource Usage */}
        <div className={styles.detailSection}>
          <p className={styles.detailSectionTitle}>리소스 사용률</p>
          {cpu ? (
            <div style={{ marginBottom: 8 }}>
              <div className={styles.nodeMetricLabel}>CPU</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={styles.gaugeBar} style={{ width: 120 }}>
                  <div
                    className={`${styles.gaugeFill} ${cpu.usagePct >= 85 ? styles.gaugeCrit : cpu.usagePct >= 70 ? styles.gaugeWarn : styles.gaugeOk}`}
                    style={{ width: `${Math.min(100, cpu.usagePct)}%` }}
                  />
                </div>
                <span className={styles.gaugeLabel}>{Math.round(cpu.usagePct)}% / {cpu.usageRaw}m</span>
              </div>
            </div>
          ) : <MetricRow label="CPU" value="N/A" />}

          {memory ? (
            <div>
              <div className={styles.nodeMetricLabel}>메모리</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={styles.gaugeBar} style={{ width: 120 }}>
                  <div
                    className={`${styles.gaugeFill} ${memory.usagePct >= 85 ? styles.gaugeCrit : memory.usagePct >= 70 ? styles.gaugeWarn : styles.gaugeOk}`}
                    style={{ width: `${Math.min(100, memory.usagePct)}%` }}
                  />
                </div>
                <span className={styles.gaugeLabel}>{Math.round(memory.usagePct)}% / {memory.usageRaw}Mi</span>
              </div>
            </div>
          ) : <MetricRow label="메모리" value="N/A" />}
        </div>

        {/* Services & Endpoints (from detail API) */}
        {detail && <ServiceSection services={detail.services} />}

        {/* Per-pod detail (from detail API) */}
        {detailLoading && (
          <div className={styles.detailSection}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
              <span className={styles.spinner} style={{ width: 14, height: 14 }} />
              <span style={{ fontSize: 12, color: "rgba(20,21,23,0.4)" }}>파드 상세 로딩 중...</span>
            </div>
          </div>
        )}

        {detailError && (
          <div className={styles.detailSection}>
            <div className={styles.errorMsg} style={{ fontSize: 11, padding: 10 }}>
              상세 조회 실패: {detailError}
            </div>
          </div>
        )}

        {detail && detail.pods.length > 0 && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>파드 상세 ({detail.pods.length})</p>
            {detail.pods.map((pod) => (
              <PodDetailRow key={pod.name} pod={pod} />
            ))}
          </div>
        )}

        {/* No services banner */}
        {detail && detail.services.length === 0 && detail.pods.length > 0 && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>서비스</p>
            <div style={{ fontSize: 12, color: "rgba(20,21,23,0.4)", padding: "6px 0" }}>
              이 워크로드에 연결된 서비스가 없습니다.
            </div>
          </div>
        )}

        {/* APM Metrics */}
        {apm && apm.source !== "none" && (
          <div className={styles.detailSection}>
            <p className={styles.detailSectionTitle}>APM 메트릭 ({apm.source})</p>
            {apm.requestsPerSec !== null && (
              <MetricRow label="요청/초" value={apm.requestsPerSec.toFixed(2)} />
            )}
            {errorPct !== null && (
              <MetricRow
                label="에러율"
                value={
                  <span style={{ color: errorPct >= 5 ? "rgba(196,43,28,0.85)" : errorPct >= 1 ? "rgba(160,100,0,0.85)" : "rgba(16,137,62,0.85)" }}>
                    {errorPct}%
                  </span>
                }
              />
            )}
            {apm.p50Ms !== null && <MetricRow label="p50 레이턴시" value={`${Math.round(apm.p50Ms)}ms`} />}
            {apm.p95Ms !== null && <MetricRow label="p95 레이턴시" value={`${Math.round(apm.p95Ms)}ms`} />}
            {apm.p99Ms !== null && <MetricRow label="p99 레이턴시" value={`${Math.round(apm.p99Ms)}ms`} />}
          </div>
        )}

        {/* JVM Metrics */}
        {jvm && <JvmSection jvm={jvm} />}

        {/* No APM data */}
        {(!apm || apm.source === "none") && !jvm && (
          <div className={styles.noDataBanner} style={{ margin: "10px 0", padding: 16 }}>
            <strong>APM 데이터 없음</strong>
            App Insights가 구성되지 않았거나 이 워크로드에서 메트릭을 수집하지 않습니다.
          </div>
        )}
      </div>
    </div>
  );
}

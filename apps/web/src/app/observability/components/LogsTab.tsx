"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { PodLogEntry, ObservabilityLogsResponse, ObservabilityNamespacesResponse, NamespacePodItem } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";
import { rgba } from "@/lib/palette";
import { startPolling } from "@/lib/usePolling";

type Props = {
  clusterId: string;
};

export function LogsTab({ clusterId }: Props) {
  const { t } = useI18n();
  const getApiToken = useApiToken();

  const [namespace, setNamespace] = useState("");
  const [podName, setPodName] = useState("");
  const [containerName, setContainerName] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState(30);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamFilter, setStreamFilter] = useState<"all" | "stdout" | "stderr">("all");

  const [nsPodItems, setNsPodItems] = useState<NamespacePodItem[]>([]);
  const [logs, setLogs] = useState<PodLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch namespace/pod list from dedicated endpoint
  const fetchNamespaces = useCallback(async () => {
    if (!clusterId) return;
    try {
      const token = await getApiToken();
      const base = apiBaseUrl();
      const params = new URLSearchParams({ clusterId });
      const data = await fetchJsonWithBearer<ObservabilityNamespacesResponse>(
        `${base}/api/observability/namespaces?${params}`,
        token,
      );
      setNsPodItems(data.items);
    } catch (e) {
      console.error("[LogsTab] namespace fetch error:", e);
    }
  }, [clusterId, getApiToken]);

  // Poll namespaces every 30s
  useEffect(() => {
    if (!clusterId) return;
    return startPolling(fetchNamespaces, 30_000); // visible tab only, no overlap
  }, [fetchNamespaces, clusterId]);

  // Build namespace list (모든 네임스페이스, Pod 유무 관계없이)
  const namespaces = useMemo(() => {
    const nsSet = new Set<string>();
    for (const item of nsPodItems) {
      if (item.namespace) nsSet.add(item.namespace);
    }
    return Array.from(nsSet).sort();
  }, [nsPodItems]);

  // Build pod list for selected namespace (빈 podName 항목 제외)
  const podOptions = useMemo(() => {
    if (!namespace) return [];
    const pods: string[] = [];
    for (const item of nsPodItems) {
      if (item.namespace === namespace && item.podName && !pods.includes(item.podName)) {
        pods.push(item.podName);
      }
    }
    return pods;
  }, [namespace, nsPodItems]);

  // Build container list for selected pod
  const containerOptions = useMemo(() => {
    if (!namespace || !podName) return [];
    const item = nsPodItems.find((i) => i.namespace === namespace && i.podName === podName);
    return item?.containers ?? [];
  }, [namespace, podName, nsPodItems]);

  // Auto-select first namespace
  useEffect(() => {
    if (namespaces.length > 0 && !namespace) {
      setNamespace(namespaces[0]!);
    }
  }, [namespaces]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pod 변경 시 container 즉시 리셋 (stale container name 방지)
  useEffect(() => {
    if (podOptions.length > 0 && !podOptions.includes(podName)) {
      setPodName(podOptions[0]!);
    }
    // Pod가 바뀌면 containerName 무조건 리셋
    setContainerName("");
  }, [podOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // containerOptions가 결정된 후 multi-container pod면 첫 번째 선택
  useEffect(() => {
    if (containerOptions.length > 1) {
      setContainerName((prev) =>
        containerOptions.includes(prev) ? prev : containerOptions[0]!,
      );
    } else {
      setContainerName("");
    }
  }, [containerOptions]);  

  const fetchLogs = useCallback(async () => {
    if (!clusterId || !namespace || !podName) return;

    // 현재 pod의 유효 컨테이너 목록 확인 (stale container name 방지)
    const podItem = nsPodItems.find((i) => i.namespace === namespace && i.podName === podName);
    const validContainers = podItem?.containers ?? [];
    const safeContainer =
      containerName && validContainers.includes(containerName) ? containerName : "";

    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const base = apiBaseUrl();
      const params = new URLSearchParams({
        clusterId,
        namespace,
        podName,
        limit: "300",
        sinceMinutes: String(sinceMinutes),
      });
      if (safeContainer) {
        params.set("container", safeContainer);
      }
      const data = await fetchJsonWithBearer<ObservabilityLogsResponse>(
        `${base}/api/observability/logs?${params}`,
        token,
      );
      setLogs(data.logs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, namespace, podName, containerName, sinceMinutes, getApiToken, nsPodItems]);

  // Initial fetch + polling
  useEffect(() => {
    if (!namespace || !podName) return;
    return startPolling(fetchLogs, 15_000); // visible tab only, no overlap
  }, [fetchLogs, namespace, podName]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // kubelet 로그 API는 stdout/stderr를 구분하지 않음 — Container Insights 경로일 때만 필터 노출
  const hasStreamInfo = useMemo(() => logs.some((l) => l.stream !== "unknown"), [logs]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (hasStreamInfo && streamFilter !== "all") {
      result = result.filter((l) => l.stream === streamFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.logMessage.toLowerCase().includes(q));
    }
    return result;
  }, [logs, hasStreamInfo, streamFilter, search]);

  function formatTime(ts: string) {
    const d = new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  if (nsPodItems.length === 0 && !loading) {
    return (
      <div className={styles.noDataBanner}>
        <strong>{t("ob.logs.unavailable")}</strong>
        {t("ob.logs.unavailableHint")}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.logsToolbar}>
        <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

        <select value={podName} onChange={(e) => setPodName(e.target.value)}>
          {podOptions.length === 0 && (
            <option value="">{t("ob.logs.noPods")}</option>
          )}
          {podOptions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        {/* Multi-container pod인 경우 컨테이너 선택 드롭다운 표시 */}
        {containerOptions.length > 1 && (
          <select value={containerName} onChange={(e) => setContainerName(e.target.value)}>
            {containerOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}

        <select value={sinceMinutes} onChange={(e) => setSinceMinutes(Number(e.target.value))}>
          {[5, 15, 30, 60, 360, 1440].map((m) => <option key={m} value={m}>{m < 60 ? t("ob.logs.lastMin", { n: m }) : t("ob.logs.lastHour", { n: m / 60 })}</option>)}
        </select>

        {hasStreamInfo && (
          <select value={streamFilter} onChange={(e) => setStreamFilter(e.target.value as "all" | "stdout" | "stderr")}>
            <option value="all">{t("ob.logs.allStreams")}</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
        )}

        <input
          type="text"
          placeholder={t("ob.logs.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 140 }}
        />

        <button
          className={`${styles.logAutoScroll} ${autoScroll ? styles.logAutoScrollActive : ""}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {t("ob.logs.autoScroll")} {autoScroll ? "ON" : "OFF"}
        </button>

        <span style={{ fontSize: 11, color: rgba("ink", 0.4), marginLeft: "auto" }}>
          {t("ob.logs.lines", { n: filteredLogs.length })} {loading && `· ${t("common.loading")}`}
        </span>
      </div>

      {error && <div className={styles.errorMsg}>{t("ob.error")}: {error}</div>}

      {/* Log viewer */}
      <div className={styles.logContainer} ref={containerRef}>
        {filteredLogs.length === 0 && !loading && (
          <div style={{ padding: 32, textAlign: "center", color: "#6a6a6a" }}>
            {podOptions.length === 0
              ? t("ob.logs.noRunningPods")
              : namespace && podName
                ? t("ob.logs.noLogs")
                : t("ob.logs.pick")}
          </div>
        )}
        {filteredLogs.map((log, i) => (
          <div key={i} className={styles.logLine}>
            <span className={styles.logTime}>{formatTime(log.timestamp)}</span>
            <span className={styles.logPod} title={log.containerName}>
              {log.containerName || log.podName}
            </span>
            {log.stream !== "unknown" && (
              <span className={`${styles.logStream} ${log.stream === "stderr" ? styles.logStderr : styles.logStdout}`}>
                {log.stream}
              </span>
            )}
            <span className={styles.logMsg}>{log.logMessage}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

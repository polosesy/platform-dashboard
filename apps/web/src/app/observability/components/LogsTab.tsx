"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { PodLogEntry, ObservabilityLogsResponse, WorkloadHealth } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

type Props = {
  clusterId: string;
  workloads: WorkloadHealth[];
};

export function LogsTab({ clusterId, workloads }: Props) {
  const getApiToken = useApiToken();

  const [namespace, setNamespace] = useState("");
  const [podName, setPodName] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState(30);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamFilter, setStreamFilter] = useState<"all" | "stdout" | "stderr">("all");

  const [logs, setLogs] = useState<PodLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build namespace → pod list from workloads
  const nsPodMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const wl of workloads) {
      if (!map.has(wl.namespace)) map.set(wl.namespace, []);
      // Use workload names as pod prefix (actual pod names aren't in types,
      // but Container Insights queries use PodName contains workload name)
      const list = map.get(wl.namespace)!;
      if (!list.includes(wl.name)) list.push(wl.name);
    }
    return map;
  }, [workloads]);

  const namespaces = useMemo(() => Array.from(nsPodMap.keys()).sort(), [nsPodMap]);
  const podOptions = useMemo(() => {
    if (!namespace) return [];
    return nsPodMap.get(namespace) ?? [];
  }, [namespace, nsPodMap]);

  // Auto-select first namespace/pod
  useEffect(() => {
    if (namespaces.length > 0 && !namespace) {
      setNamespace(namespaces[0]!);
    }
  }, [namespaces]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (podOptions.length > 0 && !podOptions.includes(podName)) {
      setPodName(podOptions[0]!);
    }
  }, [podOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchLogs = useCallback(async () => {
    if (!clusterId || !namespace || !podName) return;
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
  }, [clusterId, namespace, podName, sinceMinutes, getApiToken]);

  // Initial fetch + polling
  useEffect(() => {
    if (!namespace || !podName) return;
    fetchLogs();
    // Poll every 15s
    pollRef.current = setInterval(fetchLogs, 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLogs, namespace, podName]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (streamFilter !== "all") {
      result = result.filter((l) => l.stream === streamFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.logMessage.toLowerCase().includes(q));
    }
    return result;
  }, [logs, streamFilter, search]);

  function formatTime(ts: string) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return ts.slice(11, 19);
    }
  }

  if (workloads.length === 0) {
    return (
      <div className={styles.noDataBanner}>
        <strong>로그 조회 불가</strong>
        워크로드 목록이 없습니다. Container Insights가 연결되어 있는지 확인해 주세요.
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
          {podOptions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <select value={sinceMinutes} onChange={(e) => setSinceMinutes(Number(e.target.value))}>
          <option value={5}>최근 5분</option>
          <option value={15}>최근 15분</option>
          <option value={30}>최근 30분</option>
          <option value={60}>최근 1시간</option>
          <option value={360}>최근 6시간</option>
          <option value={1440}>최근 24시간</option>
        </select>

        <select value={streamFilter} onChange={(e) => setStreamFilter(e.target.value as "all" | "stdout" | "stderr")}>
          <option value="all">전체 스트림</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
        </select>

        <input
          type="text"
          placeholder="로그 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 140 }}
        />

        <button
          className={`${styles.logAutoScroll} ${autoScroll ? styles.logAutoScrollActive : ""}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          자동 스크롤 {autoScroll ? "ON" : "OFF"}
        </button>

        <span style={{ fontSize: 11, color: "rgba(20,21,23,0.4)", marginLeft: "auto" }}>
          {filteredLogs.length}줄 {loading && "· 로딩 중..."}
        </span>
      </div>

      {error && <div className={styles.errorMsg}>오류: {error}</div>}

      {/* Log viewer */}
      <div className={styles.logContainer} ref={containerRef}>
        {filteredLogs.length === 0 && !loading && (
          <div style={{ padding: 32, textAlign: "center", color: "#6a6a6a" }}>
            {namespace && podName
              ? "선택한 파드에 대한 로그가 없습니다."
              : "네임스페이스와 파드를 선택해 주세요."}
          </div>
        )}
        {filteredLogs.map((log, i) => (
          <div key={i} className={styles.logLine}>
            <span className={styles.logTime}>{formatTime(log.timestamp)}</span>
            <span className={styles.logPod} title={log.containerName}>
              {log.containerName || log.podName}
            </span>
            <span className={`${styles.logStream} ${log.stream === "stderr" ? styles.logStderr : styles.logStdout}`}>
              {log.stream}
            </span>
            <span className={styles.logMsg}>{log.logMessage}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { LogInsights } from "./LogInsights";
import { firstPodOf } from "@/lib/logInsightsView";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { dateLocale, useI18n } from "@/lib/i18n";
import type { PodLogEntry, PodLogAttempt, PodLogSource, ObservabilityLogsResponse, ObservabilityNamespacesResponse, NamespacePodItem } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";
import { Chip, EmptyState, Notice, Panel, SearchInput, Segmented, Select, Toggle } from "@/components/ui";
import { PodLogList } from "./PodLogList";
import { levelCounts, passesLevel, type LevelFilter } from "@/lib/podLogView";
import { atParam, podLogMinutesFor, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";

// One pod's logs over the page's time range (lib/timeRange podLogMinutesFor — up to a day, ending now or at the
// range's end): Loki and Container Insights read a past range, kubelet only tails now (skipped, said). Refreshed by
// the page's 새로 고침 / auto refresh (the tab used to poll every 15 s on its own).
type Props = {
  clusterId: string;
  range: TimeRange;
  nonce: number;
  report?: (id: string, loading: boolean) => void;
};

export function LogsTab({ clusterId, range, nonce, report }: Props) {
  const { t, locale } = useI18n();
  const getApiToken = useApiToken();

  const [namespace, setNamespace] = useState("");
  const [podName, setPodName] = useState("");
  const [containerName, setContainerName] = useState("");
  const span = podLogMinutesFor(range);
  const sinceMinutes = span.value;
  const at = atParam(range);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamFilter, setStreamFilter] = useState<"all" | "stdout" | "stderr">("all");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");

  const [nsPodItems, setNsPodItems] = useState<NamespacePodItem[]>([]);
  const [logs, setLogs] = useState<PodLogEntry[]>([]);
  // Which source answered (Loki · kubelet · Container Insights) and why the others did not
  const [source, setSource] = useState<PodLogSource | null>(null);
  const [attempts, setAttempts] = useState<PodLogAttempt[]>([]);
  // Namespaces this connection may read logs of inside the cluster (null = all)
  const [logNamespaces, setLogNamespaces] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch namespace/pod list from dedicated endpoint
  const fetchNamespaces = useCallback(async () => {
    if (!clusterId) return;
    try {
      const token = await getApiToken();
      const data = await fetchJsonWithBearer<ObservabilityNamespacesResponse>(
        apiUrl("/api/observability/namespaces", { clusterId }),
        token,
      );
      setNsPodItems(data.items);
      setLogNamespaces(data.logNamespaces ?? null);
    } catch (e) {
      console.error("[LogsTab] namespace fetch error:", e);
    }
  }, [clusterId, getApiToken]);

  // The namespace / pod list: on open, and again with the page's refresh (below)
  useEffect(() => {
    if (!clusterId) return;
    void fetchNamespaces();
  }, [fetchNamespaces, clusterId]);

  // Build namespace list (모든 네임스페이스, Pod 유무 관계없이)
  const namespaces = useMemo(() => {
    const nsSet = new Set<string>();
    for (const item of nsPodItems) {
      if (item.namespace) nsSet.add(item.namespace);
    }
    // Readable namespaces first, so the first pick shows logs instead of a refusal
    const can = (ns: string) => !logNamespaces || logNamespaces.includes(ns);
    return Array.from(nsSet).sort((a, b) => Number(can(b)) - Number(can(a)) || a.localeCompare(b));
  }, [nsPodItems, logNamespaces]);
  const canRead = useCallback((ns: string) => !logNamespaces || logNamespaces.includes(ns), [logNamespaces]);

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

  // A slow read for the previous pod must not land under the pod picked after it
  const requestSeq = useRef(0);
  const fetchLogs = useCallback(async () => {
    if (!clusterId || !namespace || !podName) return;
    const seq = ++requestSeq.current;

    // 현재 pod의 유효 컨테이너 목록 확인 (stale container name 방지)
    const podItem = nsPodItems.find((i) => i.namespace === namespace && i.podName === podName);
    const validContainers = podItem?.containers ?? [];
    const safeContainer =
      containerName && validContainers.includes(containerName) ? containerName : "";

    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const data = await fetchJsonWithBearer<ObservabilityLogsResponse>(
        apiUrl("/api/observability/logs", { clusterId, namespace, podName, limit: 300, sinceMinutes, at, container: safeContainer }),
        token,
      );
      if (seq !== requestSeq.current) return;
      setLogs(data.logs);
      setSource(data.source ?? null);
      setAttempts(data.attempts ?? []);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [clusterId, namespace, podName, containerName, sinceMinutes, at, getApiToken, nsPodItems]);

  // A new pod / range reads at once; the page's refresh reads again
  useEffect(() => {
    if (!namespace || !podName) return;
    void fetchLogs();
  }, [fetchLogs, namespace, podName]);
  const refreshAll = useCallback(() => { void fetchNamespaces(); void fetchLogs(); }, [fetchNamespaces, fetchLogs]);
  useRangeRefresh("logs", nonce, loading, refreshAll, report);

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
    if (levelFilter !== "all") result = result.filter((l) => passesLevel(l, levelFilter));
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.logMessage.toLowerCase().includes(q));
    }
    return result;
  }, [logs, hasStreamInfo, streamFilter, levelFilter, search]);
  const levels = useMemo(() => levelCounts(logs), [logs]);
  // Levels are known for Loki lines (its detected level) and for lines that state one — offer the filter when any is
  const hasLevels = levels.error + levels.warn + levels.info > 0;

  function formatTime(ts: string) {
    const d = new Date(ts);
    if (!ts || Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(dateLocale(locale), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  if (nsPodItems.length === 0 && !loading) {
    return <EmptyState title={t("ob.logs.unavailable")}>{t("ob.logs.unavailableHint")}</EmptyState>;
  }

  const pastAt = at ? new Date(Number(at) * 1000).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className={styles.plWrap}>
      {/* What to read: namespace · pod · container (the page's time range bar sets when) */}
      <div className={styles.plPick}>
        <Select label={t("hb.namespace")} value={namespace} onChange={setNamespace}
          options={namespaces.map((ns) => ({ value: ns, label: canRead(ns) ? ns : t("ob.logs.nsDenied", { ns }) }))} />
        <Select label="Pod" value={podName} onChange={setPodName} placeholder={t("ob.logs.noPods")}
          options={podOptions.map((p) => ({ value: p, label: p }))} />
        {containerOptions.length > 1 ? (
          <Select label={t("ob.pl.container")} value={containerName} onChange={setContainerName}
            options={containerOptions.map((c) => ({ value: c, label: c }))} />
        ) : null}
        <span className={styles.plPickEnd}>
          {span.differs ? <Chip level="info" glyph={false} title={t("ob.logs.rangeMaxHint")}>{t("ob.logs.rangeMax")}</Chip> : null}
          {at ? <Chip level="warn" glyph={false} title={t("ob.logs.pastHint")}>{t("ob.logs.past", { at: pastAt })}</Chip> : null}
        </span>
      </div>

      {/* The namespace's logs as numbers first (ERROR · WARN · exception classes · over time — counted by Loki); a
          workload picked there opens one of its pods in the viewer below. Only where this connection reads logs. */}
      {namespace && canRead(namespace) ? (
        <LogInsights clusterId={clusterId} namespace={namespace} range={range} nonce={nonce}
          onPickWorkload={(w) => { const pod = firstPodOf(podOptions, w); if (pod) setPodName(pod); }} />
      ) : null}

      {error ? <Notice tone="danger" title={t("ob.error")}>{error}</Notice> : null}
      {!source && attempts.length > 0 && !loading && (
        <Notice tone={canRead(namespace) ? "warning" : "info"} title={t(canRead(namespace) ? "ob.logs.noneTitle" : "ob.logs.deniedTitle")}>
          {canRead(namespace)
            ? t("ob.logs.noneHint")
            : t("ob.logs.deniedHint", { list: (logNamespaces ?? []).join(", ") || "—" })}
        </Notice>
      )}

      {/* The pod's lines — the same list grammar as the workload panel's stream; a row opens its details */}
      <Panel title={t("ob.pl.title")} sub={podName ? `${podName} · ${t("ob.logs.lines", { n: filteredLogs.length })}${loading ? ` · ${t("common.loading")}` : ""}` : undefined}
        actions={
          // Where the lines came from — and why the other sources gave none
          <span className={styles.plSources}>
            {attempts.map((a) => (
              <Chip key={a.source} level={a.state === "ok" ? "ok" : a.state === "empty" || a.state === "notConfigured" || a.state === "pastRange" ? "neutral" : "warn"}
                title={a.message ?? t(`ob.logs.state.${a.state}`)}>
                {t(`ob.logs.src.${a.source}`)} · {t(`ob.logs.state.${a.state}`)}
              </Chip>
            ))}
          </span>
        }
        footer={<span>{t(source === "loki" ? "ob.pl.footLoki" : "ob.pl.foot")}</span>}>
        <div className={styles.plFilters}>
          {hasLevels ? (
            <Segmented label={t("ob.pl.level")} value={levelFilter} onChange={setLevelFilter}
              items={[
                { id: "all", label: t("ob.pl.lv.all", { n: logs.length }) },
                { id: "warn", label: t("ob.pl.lv.warn", { n: levels.error + levels.warn }) },
                { id: "error", label: t("ob.pl.lv.error", { n: levels.error }) },
              ]} />
          ) : null}
          {hasStreamInfo ? (
            <Select label={t("ob.logs.allStreams")} hideLabel value={streamFilter} onChange={(v) => setStreamFilter(v as "all" | "stdout" | "stderr")}
              options={[{ value: "all", label: t("ob.logs.allStreams") }, { value: "stdout", label: "stdout" }, { value: "stderr", label: "stderr" }]} />
          ) : null}
          <SearchInput label={t("ob.pl.search")} value={search} onChange={setSearch} placeholder={t("ob.logs.search")} />
          <Toggle checked={autoScroll} onChange={setAutoScroll}>{t("ob.logs.autoScroll")}</Toggle>
        </div>
        <div className={styles.plScroll} ref={containerRef}>
          <PodLogList clusterId={clusterId} namespace={namespace} logs={filteredLogs}
            empty={loading ? t("common.loading") : podOptions.length === 0 ? t("ob.logs.noRunningPods") : namespace && podName ? t("ob.logs.noLogs") : t("ob.logs.pick")} />
        </div>
      </Panel>
    </div>
  );
}

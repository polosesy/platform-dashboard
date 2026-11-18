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
import { coverageOf, levelNumbers, type LevelFilter } from "@/lib/podLogView";
import { atParam, podLogMinutesFor, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { causeView } from "@/lib/connectCause";

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
  // What the viewer reads: one pod, or every pod of a workload — the scope the log insights count (Loki only)
  const [scope, setScope] = useState<"pod" | "workload">("pod");
  const [pickedWorkload, setPickedWorkload] = useState("");
  // The answer's own words on what it holds: counts over the window, how much of it the lines cover
  const [meta, setMeta] = useState<(Pick<ObservabilityLogsResponse, "counts" | "coverage" | "windowMinutes" | "scope" | "level" | "generatedAt" | "at"> & { key: string }) | null>(null);

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

  // The workload of the pod in view (the API's controller name), or the one picked in the log insights
  const workload = useMemo(() => pickedWorkload || nsPodItems.find((i) => i.namespace === namespace && i.podName === podName)?.workloadName || "",
    [pickedWorkload, nsPodItems, namespace, podName]);
  const wholeWorkload = scope === "workload" && !!workload;
  // The numbers belong to one read: shown only while the scope · level · range they were read for is the one picked
  const readKey = `${wholeWorkload ? `w:${workload}` : `p:${podName}:${containerName}`}:${levelFilter}:${sinceMinutes}:${at ?? "now"}`;

  // A slow read for the previous pod must not land under the pod picked after it
  const requestSeq = useRef(0);
  const fetchLogs = useCallback(async () => {
    if (!clusterId || !namespace || (!podName && !wholeWorkload)) return;
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
        // ERROR / WARN+ are filtered by the API over the whole window (the insights' rules) — never in the browser
        // over whatever lines were loaded
        apiUrl("/api/observability/logs", {
          clusterId, namespace, limit: 300, sinceMinutes, at,
          ...(wholeWorkload ? { workload } : { podName, container: safeContainer }),
          level: levelFilter === "all" ? undefined : levelFilter,
        }),
        token,
      );
      if (seq !== requestSeq.current) return;
      setLogs(data.logs);
      setMeta({ ...data, key: readKey });
      setSource(data.source ?? null);
      setAttempts(data.attempts ?? []);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [clusterId, namespace, podName, containerName, sinceMinutes, at, getApiToken, nsPodItems, wholeWorkload, workload, levelFilter, readKey]);

  // A new pod / scope / level / range reads at once; the page's refresh reads again
  useEffect(() => {
    if (!namespace || (!podName && !wholeWorkload)) return;
    void fetchLogs();
  }, [fetchLogs, namespace, podName, wholeWorkload]);
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
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.logMessage.toLowerCase().includes(q));
    }
    return result;
  }, [logs, hasStreamInfo, streamFilter, search]);
  // Numbers = Loki's counts over the window with the insights' rules (null = not counted — no number shown)
  const current = meta?.key === readKey ? meta : null;
  const nums = levelNumbers(current?.counts);
  const windowRead = current?.windowMinutes ?? sinceMinutes;
  const coverage = current ? coverageOf(current.coverage, windowRead, current.at ?? current.generatedAt) : { kind: "unknown" as const };
  const lvLabel = (k: "all" | "warn" | "error", n: number | null) => (n === null ? t(`ob.pl.lv.${k}Plain`) : t(`ob.pl.lv.${k}`, { n: n.toLocaleString() }));

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
        <Select label="Pod" value={podName} onChange={(p) => { setPodName(p); setPickedWorkload(""); setScope("pod"); }} placeholder={t("ob.logs.noPods")}
          options={podOptions.map((p) => ({ value: p, label: p }))} />
        {workload ? (
          <Segmented label={t("ob.pl.scope")} value={scope} onChange={setScope}
            items={[{ id: "pod", label: t("ob.pl.scope.pod") }, { id: "workload", label: t("ob.pl.scope.workload", { w: workload }) }]} />
        ) : null}
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
          onPickWorkload={(w) => { const pod = firstPodOf(podOptions, w); if (pod) setPodName(pod); setPickedWorkload(w); setScope("workload"); }} />
      ) : null}

      {error ? <Notice tone="danger" title={t("ob.error")}>{error}</Notice> : null}
      {!source && attempts.length > 0 && !loading && (
        <Notice tone={canRead(namespace) ? "warning" : "info"} title={t(canRead(namespace) ? "ob.logs.noneTitle" : "ob.logs.deniedTitle")}>
          {canRead(namespace)
            ? t("ob.logs.noneHint")
            : t("ob.logs.deniedHint", { list: (logNamespaces ?? []).join(", ") || "—" })}
          {/* the sources' own words (only in a chip's tooltip before — "Loki · failed" said nothing about why) */}
          {attempts.some((a) => a.message && a.state !== "ok" && a.state !== "empty") ? (
            <ul className={styles.plWhy}>
              {attempts.filter((a) => a.message && a.state !== "ok" && a.state !== "empty").map((a) => (
                <li key={a.source}><b>{t(`ob.logs.src.${a.source}`)}</b> — {a.message}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      )}

      {/* The pod's lines — the same list grammar as the workload panel's stream; a row opens its details */}
      <Panel title={t("ob.pl.title")} sub={podName || wholeWorkload ? `${wholeWorkload ? t("ob.pl.scope.workload", { w: workload }) : podName} · ${t("ob.logs.lines", { n: filteredLogs.length })}${loading ? ` · ${t("common.loading")}` : ""}` : undefined}
        actions={
          // How much of the window the lines are, then where they came from — and why the other sources gave none
          <span className={styles.plSources}>
            {coverage.kind === "complete" ? (
              <Chip level="ok" glyph={false} title={t("ob.pl.cov.completeHint")}>{t("ob.pl.cov.complete", { n: windowRead })}</Chip>
            ) : coverage.kind === "partial" ? (
              <Chip level="warn" title={t("ob.pl.cov.partialHint", { lines: logs.length, n: windowRead })}>
                {t("ob.pl.cov.partial", { lines: logs.length, from: formatTime(coverage.from), m: coverage.minutes, n: windowRead })}
              </Chip>
            ) : null}
            {current?.windowMinutes !== undefined && current.windowMinutes < sinceMinutes ? (
              <Chip level="info" glyph={false} title={t("ob.pl.levelWindowHint")}>{t("ob.pl.levelWindow", { n: current.windowMinutes })}</Chip>
            ) : null}
            {attempts.map((a) => (
              <Chip key={a.source} level={a.state === "ok" ? "ok" : a.state === "empty" || a.state === "notConfigured" || a.state === "pastRange" ? "neutral" : "warn"}
                title={[causeView(a.state, a.cause) ? t(causeView(a.state, a.cause)!.title, { target: t(`ob.logs.src.${a.source}`) }) : null, a.message ?? t(`ob.logs.state.${a.state}`)].filter(Boolean).join(" — ")}>
                {t(`ob.logs.src.${a.source}`)} · {a.state === "unreachable" && a.cause ? t(`net.cause.${a.cause}.short`) : t(`ob.logs.state.${a.state}`)}
              </Chip>
            ))}
          </span>
        }
        footer={<span>{nums.error !== null ? `${t("ob.pl.countsNote", { n: windowRead })} ` : ""}{t(source === "loki" ? "ob.pl.footLoki" : "ob.pl.foot")}</span>}>
        <div className={styles.plFilters}>
          <Segmented label={t("ob.pl.level")} value={levelFilter} onChange={setLevelFilter}
            items={[
              { id: "all", label: lvLabel("all", null) },
              { id: "warn", label: lvLabel("warn", nums.warnPlus) },
              { id: "error", label: lvLabel("error", nums.error) },
            ]} />
          {hasStreamInfo ? (
            <Select label={t("ob.logs.allStreams")} hideLabel value={streamFilter} onChange={(v) => setStreamFilter(v as "all" | "stdout" | "stderr")}
              options={[{ value: "all", label: t("ob.logs.allStreams") }, { value: "stdout", label: "stdout" }, { value: "stderr", label: "stderr" }]} />
          ) : null}
          <SearchInput label={t("ob.pl.search")} value={search} onChange={setSearch} placeholder={t("ob.logs.search")} />
          <Toggle checked={autoScroll} onChange={setAutoScroll}>{t("ob.logs.autoScroll")}</Toggle>
        </div>
        <div className={styles.plScroll} ref={containerRef}>
          <PodLogList clusterId={clusterId} namespace={namespace} logs={filteredLogs} showPod={wholeWorkload}
            empty={loading ? t("common.loading") : levelFilter !== "all" && source === "loki" ? t("ob.pl.noLevelLines", { n: windowRead }) : podOptions.length === 0 ? t("ob.logs.noRunningPods") : namespace && podName ? t("ob.logs.noLogs") : t("ob.logs.pick")} />
        </div>
      </Panel>
    </div>
  );
}

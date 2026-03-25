"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { HubbleFlowsResponse, HubbleFlow } from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import styles from "../styles.module.css";

type Props = { clusterId: string };

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso.slice(11, 19);
  }
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const cls =
    verdict === "DROPPED" ? styles.verdictDropped
    : verdict === "AUDIT" ? styles.verdictAudit
    : styles.verdictForwarded;
  return <span className={`${styles.verdictBadge} ${cls}`}>{verdict}</span>;
}

export function FlowsTab({ clusterId }: Props) {
  const getApiToken = useApiToken();

  const [flows, setFlows] = useState<HubbleFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nsFilter, setNsFilter] = useState("");
  const [verdictFilter, setVerdictFilter] = useState("");
  const [search, setSearch] = useState("");

  const fetchFlows = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getApiToken();
      const params = new URLSearchParams({ clusterId, limit: "2000" });
      if (nsFilter) params.set("namespace", nsFilter);
      if (verdictFilter) params.set("verdict", verdictFilter);
      const data = await fetchJsonWithBearer<HubbleFlowsResponse>(
        `${apiBaseUrl()}/api/hubble/flows?${params}`,
        token,
      );
      setFlows(data.flows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, nsFilter, verdictFilter, getApiToken]);

  useEffect(() => {
    fetchFlows();
    const iv = setInterval(fetchFlows, 15_000);
    return () => clearInterval(iv);
  }, [fetchFlows]);

  const namespaces = useMemo(() => {
    const ns = new Set<string>();
    for (const f of flows) {
      if (f.source.namespace) ns.add(f.source.namespace);
      if (f.destination.namespace) ns.add(f.destination.namespace);
    }
    return Array.from(ns).sort();
  }, [flows]);

  const filtered = useMemo(() => {
    if (!search) return flows;
    const q = search.toLowerCase();
    return flows.filter(
      (f) =>
        f.source.workloadName.toLowerCase().includes(q) ||
        f.destination.workloadName.toLowerCase().includes(q) ||
        f.summary.toLowerCase().includes(q),
    );
  }, [flows, search]);

  return (
    <div>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <select value={nsFilter} onChange={(e) => setNsFilter(e.target.value)}>
          <option value="">전체 네임스페이스</option>
          {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>

        <select value={verdictFilter} onChange={(e) => setVerdictFilter(e.target.value)}>
          <option value="">전체 Verdict</option>
          <option value="FORWARDED">FORWARDED</option>
          <option value="DROPPED">DROPPED</option>
          <option value="AUDIT">AUDIT</option>
        </select>

        <input
          type="text"
          placeholder="서비스 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 140 }}
        />

        <span className={styles.toolbarCount}>
          {filtered.length}개 플로우 {loading && "· 로딩 중..."}
        </span>
      </div>

      {error && <div className={styles.errorMsg}>Flows 오류: {error}</div>}

      {/* Flow Table */}
      <div className={styles.flowTableContainer}>
        <table className={styles.flowTable}>
          <thead>
            <tr>
              <th>시간</th>
              <th>Source</th>
              <th>Destination</th>
              <th>Verdict</th>
              <th>Protocol</th>
              <th>Port</th>
              <th>L7</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((f, i) => (
              <tr
                key={i}
                className={`${styles.flowRow} ${f.verdict === "DROPPED" ? styles.flowRowDropped : ""}`}
              >
                <td className={styles.flowMono}>{formatTime(f.time)}</td>
                <td title={`${f.source.namespace}/${f.source.podName}`}>
                  <span style={{ fontWeight: 600 }}>{f.source.workloadName}</span>
                  <br />
                  <span style={{ fontSize: 10, color: "rgba(20,21,23,0.4)" }}>{f.source.namespace}</span>
                </td>
                <td title={`${f.destination.namespace}/${f.destination.podName}`}>
                  <span style={{ fontWeight: 600 }}>{f.destination.workloadName}</span>
                  <br />
                  <span style={{ fontSize: 10, color: "rgba(20,21,23,0.4)" }}>{f.destination.namespace}</span>
                </td>
                <td><VerdictBadge verdict={f.verdict} /></td>
                <td><span className={styles.protocolBadge}>{f.l4Protocol}</span></td>
                <td className={styles.flowMono}>{f.destinationPort || "—"}</td>
                <td>
                  {f.l7?.http && (
                    <span>
                      <span className={styles.protocolBadge}>HTTP</span>{" "}
                      {f.l7.http.method} {f.l7.http.code}
                    </span>
                  )}
                  {f.l7?.dns && (
                    <span>
                      <span className={styles.protocolBadge}>DNS</span>{" "}
                      {f.l7.dns.query}
                    </span>
                  )}
                  {!f.l7 && "—"}
                </td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.summary || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && !loading && (
          <div className={styles.noDataBanner}>
            <strong>플로우 데이터 없음</strong>
            Hubble에서 수집된 플로우가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

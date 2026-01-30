"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { NetworkSummary } from "@/lib/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  const digits = idx === 0 ? 0 : idx === 1 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[idx]}`;
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

async function loadSummary(bearerToken: string | null, lookbackMinutes: number, top: number): Promise<NetworkSummary> {
  const url = new URL(`${apiBaseUrl()}/api/network/summary`);
  url.searchParams.set("lookbackMinutes", String(lookbackMinutes));
  url.searchParams.set("top", String(top));
  return await fetchJsonWithBearer<NetworkSummary>(url.toString(), bearerToken);
}

type RangePreset = { label: string; minutes: number };
const ranges: RangePreset[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

export default function NetworkPage() {
  const getApiToken = useApiToken();
  const [summary, setSummary] = useState<NetworkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookbackMinutes, setLookbackMinutes] = useState(60);
  const [top, setTop] = useState(15);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getApiToken()
      .then((token) => loadSummary(token, lookbackMinutes, top))
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getApiToken, lookbackMinutes, top]);

  const maxSubnetBytes = useMemo(() => {
    const max = Math.max(0, ...(summary?.topSubnetPairs ?? []).map((r) => r.totalBytes));
    return max <= 0 ? 1 : max;
  }, [summary?.topSubnetPairs]);

  const maxIpBytes = useMemo(() => {
    const max = Math.max(0, ...(summary?.topIpPairs ?? []).map((r) => r.totalBytes));
    return max <= 0 ? 1 : max;
  }, [summary?.topIpPairs]);

  const maxPortBytes = useMemo(() => {
    const max = Math.max(0, ...(summary?.topPorts ?? []).map((r) => r.totalBytes));
    return max <= 0 ? 1 : max;
  }, [summary?.topPorts]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Network Flow</div>
          <div className={styles.subTitle}>
            {summary ? (
              <span>
                Table: <span className={styles.mono}>{summary.table}</span> · Generated: {new Date(summary.generatedAt).toLocaleString()}
              </span>
            ) : (
              <span>{loading ? "Loading..." : "No data"}</span>
            )}
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.control}>
            <div className={styles.controlLabel}>Range</div>
            <select
              className={styles.select}
              value={lookbackMinutes}
              onChange={(e) => setLookbackMinutes(Number(e.target.value))}
            >
              {ranges.map((r) => (
                <option key={r.minutes} value={r.minutes}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.control}>
            <div className={styles.controlLabel}>Top</div>
            <select className={styles.select} value={top} onChange={(e) => setTop(Number(e.target.value))}>
              {[10, 15, 20, 30, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}
      {summary?.note ? <div className={styles.note}>{summary.note}</div> : null}

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardTitle}>Totals</div>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Bytes</div>
              <div className={styles.kpiValue}>{summary ? formatBytes(summary.totals.totalBytes) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Allowed flows</div>
              <div className={styles.kpiValue}>{summary ? fmtInt(summary.totals.allowedFlows) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Denied flows</div>
              <div className={styles.kpiValue}>{summary ? fmtInt(summary.totals.deniedFlows) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>API</div>
              <div className={styles.kpiValueMono}>{apiBaseUrl()}</div>
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>Top subnet pairs</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>Pair</div>
              <div>Bytes</div>
              <div>Denied</div>
            </div>
            {(summary?.topSubnetPairs ?? []).map((r) => {
              const w = `${Math.round((r.totalBytes / maxSubnetBytes) * 100)}%`;
              return (
                <div key={`${r.src}__${r.dest}`} className={styles.tr}>
                  <div className={styles.pair}>
                    <div className={styles.pairText}>
                      <span className={styles.pill}>{r.src}</span>
                      <span className={styles.arrow} aria-hidden="true">
                        →
                      </span>
                      <span className={styles.pill}>{r.dest}</span>
                    </div>
                    <div className={styles.bar} aria-hidden="true">
                      <div className={styles.barFill} style={{ width: w }} />
                    </div>
                  </div>
                  <div className={styles.num}>{formatBytes(r.totalBytes)}</div>
                  <div className={styles.numDanger}>{fmtInt(r.deniedFlows)}</div>
                </div>
              );
            })}
            {summary && summary.topSubnetPairs.length === 0 ? <div className={styles.empty}>No flow pairs found.</div> : null}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>Top talkers (IP)</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>Pair</div>
              <div>Bytes</div>
              <div>Denied</div>
            </div>
            {(summary?.topIpPairs ?? []).map((r) => {
              const w = `${Math.round((r.totalBytes / maxIpBytes) * 100)}%`;
              return (
                <div key={`${r.src}__${r.dest}`} className={styles.tr}>
                  <div className={styles.pair}>
                    <div className={styles.pairText}>
                      <span className={styles.pillMono}>{r.src}</span>
                      <span className={styles.arrow} aria-hidden="true">
                        →
                      </span>
                      <span className={styles.pillMono}>{r.dest}</span>
                    </div>
                    <div className={styles.bar} aria-hidden="true">
                      <div className={styles.barFill2} style={{ width: w }} />
                    </div>
                  </div>
                  <div className={styles.num}>{formatBytes(r.totalBytes)}</div>
                  <div className={styles.numDanger}>{fmtInt(r.deniedFlows)}</div>
                </div>
              );
            })}
            {summary && summary.topIpPairs.length === 0 ? <div className={styles.empty}>No talkers found.</div> : null}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>Top ports</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>Port</div>
              <div>Bytes</div>
              <div>Denied</div>
            </div>
            {(summary?.topPorts ?? []).map((r) => {
              const w = `${Math.round((r.totalBytes / maxPortBytes) * 100)}%`;
              const port = r.destPort == null ? "-" : String(r.destPort);
              const proto = r.protocol ?? "-";
              return (
                <div key={`${port}:${proto}`} className={styles.tr}>
                  <div className={styles.portCell}>
                    <div className={styles.portText}>
                      <span className={styles.portBadge}>{port}</span>
                      <span className={styles.portProto}>{proto}</span>
                    </div>
                    <div className={styles.bar} aria-hidden="true">
                      <div className={styles.barFill3} style={{ width: w }} />
                    </div>
                  </div>
                  <div className={styles.num}>{formatBytes(r.totalBytes)}</div>
                  <div className={styles.numDanger}>{fmtInt(r.deniedFlows)}</div>
                </div>
              );
            })}
            {summary && summary.topPorts.length === 0 ? <div className={styles.empty}>No ports found.</div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

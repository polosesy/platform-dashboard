"use client";

import { useMemo, useState } from "react";
import styles from "./styles.module.css";
import type { NetworkSummary } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { ErrorNotice, PageHeader, SampleDataNotice, Select } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { formatBytes } from "@/lib/format";
import { useApiQuery } from "@/lib/useApiQuery";

function fmtInt(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

async function loadSummary(bearerToken: string | null, lookbackMinutes: number, top: number): Promise<NetworkSummary> {
  return await fetchJsonWithBearer<NetworkSummary>(apiUrl("/api/network/summary", { lookbackMinutes, top }), bearerToken);
}

type RangePreset = { label: string; minutes: number };
const ranges: RangePreset[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

export default function NetworkPage() {
  const { t, locale } = useI18n();
  const [lookbackMinutes, setLookbackMinutes] = useState(60);
  const [top, setTop] = useState(15);
  const { data, error, loading } = useApiQuery(`network:${lookbackMinutes}:${top}`, (token) =>
    loadSummary(token, lookbackMinutes, top),
  );
  const summary = data ?? null;

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
      <PageHeader
        meta={summary ? <span>{t("net.table")} <span className={styles.mono}>{summary.table}</span> · {t("common.updated")} {new Date(summary.generatedAt).toLocaleString(dateLocale(locale))}</span> : loading ? <span>{t("common.loading")}</span> : null}
        actions={
          <>
            <Select label={t("net.range")} value={String(lookbackMinutes)} onChange={(v) => setLookbackMinutes(Number(v))} options={ranges.map((r) => ({ value: String(r.minutes), label: r.label }))} />
            <Select label={t("net.top")} value={String(top)} onChange={(v) => setTop(Number(v))} options={[10, 15, 20, 30, 50].map((n) => ({ value: String(n), label: String(n) }))} />
          </>
        }
      />

      <ErrorNotice error={error} />
      <SampleDataNotice note={summary?.note} />

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardTitle}>{t("net.totals")}</div>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("net.bytes")}</div>
              <div className={styles.kpiValue}>{summary ? formatBytes(summary.totals.totalBytes) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("net.allowed")}</div>
              <div className={styles.kpiValue}>{summary ? fmtInt(summary.totals.allowedFlows) : "-"}</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>{t("net.denied")}</div>
              <div className={styles.kpiValue}>{summary ? fmtInt(summary.totals.deniedFlows) : "-"}</div>
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>{t("net.subnetPairs")}</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>{t("net.pair")}</div>
              <div>{t("net.bytes")}</div>
              <div>{t("net.deniedShort")}</div>
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
            {summary && summary.topSubnetPairs.length === 0 ? <div className={styles.empty}>{t("net.noPairs")}</div> : null}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>{t("net.talkers")}</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>{t("net.pair")}</div>
              <div>{t("net.bytes")}</div>
              <div>{t("net.deniedShort")}</div>
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
            {summary && summary.topIpPairs.length === 0 ? <div className={styles.empty}>{t("net.noTalkers")}</div> : null}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>{t("net.ports")}</div>
          <div className={styles.table}>
            <div className={styles.thead}>
              <div>{t("net.port")}</div>
              <div>{t("net.bytes")}</div>
              <div>{t("net.deniedShort")}</div>
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
            {summary && summary.topPorts.length === 0 ? <div className={styles.empty}>{t("net.noPorts")}</div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

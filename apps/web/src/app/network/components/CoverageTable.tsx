"use client";

import type { BadgeTone } from "@/components/ui";
import type { NetCoverageKind, NetCoverageResponse } from "@aud/types";
import { Badge, EmptyState, Notice, Panel, SampleDataNotice } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

const KIND_TONE: Record<NetCoverageKind, BadgeTone> = { vnet: "success", partial: "info", nsgOnly: "medium", none: "high" };
// Placeholders only — never a real resource name or id (copied by the user, not run by the platform)
// One line: a shell line continuation renders as ₩ in Korean monospace fonts
const ENABLE_CMD = "az network watcher flow-log create --location <region> --resource-group <rg> --name <vnet>-flowlog --vnet <vnet> --storage-account <storage> --traffic-analytics true --workspace <workspace> --interval 10";

/** Is anything collected? Per VNet: VNet flow log / partial / NSG-only (retiring) / none, Traffic Analytics and workspace */
export function CoverageTable({ coverage }: { coverage: NetCoverageResponse }) {
  const { t, locale } = useI18n();
  const count = (k: NetCoverageKind) => coverage.vnets.filter((v) => v.kind === k).length;
  const ws = coverage.workspace;
  return (
    <div className={styles.stack}>
      {coverage.source === "mock" ? <SampleDataNotice note={coverage.note ?? "mock"} /> : null}
      {coverage.gaps.length ? <Notice tone="warning">{coverage.gaps.map((g) => t("net.unmeasured", { part: t(`net.part.${g.part}`) })).join(" · ")}</Notice> : null}
      <div className={styles.strip}>
        <span className={styles.stripText}>
          {t("net.cov.summary", { total: coverage.vnets.length, vnet: count("vnet"), partial: count("partial"), nsgOnly: count("nsgOnly"), none: count("none") })}
        </span>
        <span className={styles.stripText}>{ws.lastRow ? t("net.lastIngested", { time: new Date(ws.lastRow).toLocaleString(dateLocale(locale)) }) : t(ws.state === "disabled" ? "net.state.disabled" : ws.state === "noAccess" ? "net.state.noAccess" : ws.state === "noTable" ? "net.state.noTable" : "net.lastNone")}</span>
        {ws.legacyFlowRows7d ? <span className={styles.stripText}>{t("net.cov.legacyRows", { n: ws.legacyFlowRows7d })}</span> : null}
      </div>
      {count("nsgOnly") ? <Notice tone="warning" title={t("net.cov.migrate")}>{t("net.cov.nsgOnlyHint")}</Notice> : null}
      <Panel title={t("net.cov.title")} sub={String(coverage.vnets.length)} flush>
        {coverage.vnets.length === 0 ? (
          <EmptyState title={t("net.cov.empty")} />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("net.vnet")}</th>
                <th>{t("net.cov.region")}</th>
                <th>{t("net.cov.kind")}</th>
                <th>{t("net.cov.ta")}</th>
                <th>{t("net.cov.interval")}</th>
                <th>{t("net.cov.workspace")}</th>
                <th>{t("net.cov.retention")}</th>
                <th>{t("net.cov.legacy")}</th>
              </tr>
            </thead>
            <tbody>
              {coverage.vnets.map((v) => (
                <tr key={v.key}>
                  <td className={styles.mono} title={v.key}>{v.name}</td>
                  <td>{v.region}</td>
                  <td><Badge tone={KIND_TONE[v.kind]}>{t(`net.cov.${v.kind}`)}</Badge></td>
                  <td>{v.kind === "vnet" || v.kind === "partial" ? (v.trafficAnalytics ? t("net.cov.on") : <Badge tone="medium">{t("net.cov.off")}</Badge>) : "-"}</td>
                  <td>{v.intervalMin ? t("net.cov.minutes", { n: v.intervalMin }) : "-"}</td>
                  <td>
                    {v.workspace ?? "-"}
                    {v.workspaceMatches === false ? <> <Badge tone="medium" title={t("net.cov.wsMismatch")}>≠</Badge></> : null}
                  </td>
                  <td>{v.retentionDays === null ? "-" : v.retentionDays === 0 ? t("net.cov.retentionForever") : t("net.cov.days", { n: v.retentionDays })}</td>
                  <td>
                    {v.nsgLegacy ? <Badge tone="medium">{`${v.nsgLegacy} · ${t("net.cov.migrate")}`}</Badge> : "-"}
                    {v.disabledLogs ? <span className={styles.muted}> {t("net.cov.disabled", { n: v.disabledLogs })}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {coverage.unmappedFlowLogs ? <p className={styles.muted}>{t("net.cov.unmapped", { n: coverage.unmappedFlowLogs })}</p> : null}
      <Panel title={t("net.cov.enableCmd")}>
        <pre className={styles.code}><code>{ENABLE_CMD}</code></pre>
      </Panel>
    </div>
  );
}

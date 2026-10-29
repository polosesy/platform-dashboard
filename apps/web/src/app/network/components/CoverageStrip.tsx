"use client";

import type { NetCoverageResponse } from "@aud/types";
import { Badge, Button, Notice } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

/**
 * One line above the tabs: how much of the subscription is measured, when data last arrived, what to migrate, and —
 * when the connection cannot see the flow-log settings — that "not measured" is not "no flow log"
 */
export function CoverageStrip({ coverage, onOpen }: { coverage: NetCoverageResponse | undefined; onOpen: () => void }) {
  const { t, locale } = useI18n();
  if (!coverage) return null;
  const vnets = coverage.vnets;
  const measured = vnets.filter((v) => (v.kind === "vnet" || v.kind === "partial") && v.trafficAnalytics).length;
  const unknown = vnets.filter((v) => v.kind === "unknown").length;
  const nsgOnly = vnets.filter((v) => v.kind === "nsgOnly").length;
  const unlisted = coverage.workspace.unlisted ?? [];
  const mismatch = !unlisted.length && vnets.some((v) => v.workspaceMatches === false);
  const last = coverage.workspace.lastRow;
  return (
    <>
      <div className={styles.strip}>
        <Badge tone={measured === 0 ? (unknown ? "neutral" : "high") : measured + unknown < vnets.length ? "medium" : "success"}>{t("net.cov.strip", { n: measured, m: vnets.length })}</Badge>
        {unknown ? <Badge title={t("net.cov.hiddenHint")}>{t("net.cov.unknownN", { n: unknown })}</Badge> : null}
        <span className={styles.stripText}>{last ? t("net.lastIngested", { time: new Date(last).toLocaleString(dateLocale(locale)) }) : t("net.lastNone")}</span>
        {nsgOnly ? <Badge tone="medium">{`${t("net.cov.nsgOnly")} ${nsgOnly} · ${t("net.cov.migrate")}`}</Badge> : null}
        <Button size="sm" variant="ghost" onClick={onOpen}>{t("net.checkCoverage")}</Button>
      </div>
      {unlisted.length ? <Notice tone="warning">{t("net.cov.unlisted", { names: unlisted.join(", ") })}</Notice> : null}
      {mismatch ? <Notice tone="warning">{t("net.cov.wsMismatch")}</Notice> : null}
    </>
  );
}

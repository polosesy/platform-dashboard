"use client";

import type { NetCoverageResponse } from "@aud/types";
import { Badge, Button, Notice } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

/** One line above the tabs: how much of the subscription is measured, when data last arrived, what to migrate */
export function CoverageStrip({ coverage, onOpen }: { coverage: NetCoverageResponse | undefined; onOpen: () => void }) {
  const { t, locale } = useI18n();
  if (!coverage) return null;
  const vnets = coverage.vnets;
  const measured = vnets.filter((v) => (v.kind === "vnet" || v.kind === "partial") && v.trafficAnalytics).length;
  const nsgOnly = vnets.filter((v) => v.kind === "nsgOnly").length;
  const mismatch = vnets.some((v) => v.workspaceMatches === false);
  const last = coverage.workspace.lastRow;
  return (
    <>
      <div className={styles.strip}>
        <Badge tone={measured === 0 ? "high" : measured < vnets.length ? "medium" : "success"}>{t("net.cov.strip", { n: measured, m: vnets.length })}</Badge>
        <span className={styles.stripText}>{last ? t("net.lastIngested", { time: new Date(last).toLocaleString(dateLocale(locale)) }) : t("net.lastNone")}</span>
        {nsgOnly ? <Badge tone="medium">{`${t("net.cov.nsgOnly")} ${nsgOnly} · ${t("net.cov.migrate")}`}</Badge> : null}
        <Button size="sm" variant="ghost" onClick={onOpen}>{t("net.checkCoverage")}</Button>
      </div>
      {mismatch ? <Notice tone="warning">{t("net.cov.wsMismatch")}</Notice> : null}
    </>
  );
}

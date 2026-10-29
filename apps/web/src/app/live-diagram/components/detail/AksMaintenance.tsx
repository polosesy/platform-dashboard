"use client";

// Live diagram, AKS cluster: node maintenance (the same API as AKS 모니터링 › 노드) — a card chip while an upgrade or
// node replacement runs or ended within 24 h, and a panel section with the latest episodes and the planned windows.

import type { NodeMaintenanceResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { durationText, recentEpisode } from "@/lib/nodeMaintView";
import { Body } from "../../../observability/components/NodeMaintenancePanel";
import { Section } from "./primitives";
import { FetchFailed } from "./kindSections";
import styles from "../../styles.module.css";

const DAYS = 14;
/** A real cluster id (sample diagrams use /subscriptions/mock/… — nothing to read) */
export const REAL_ARM = /^\/subscriptions\/[0-9a-f-]{36}\//i;
const useNodeMaintenance = (clusterId: string) =>
  useApiQuery(`node-maint:${clusterId}:${DAYS}`, (token) =>
    fetchJsonWithBearer<NodeMaintenanceResponse>(apiUrl("/api/observability/node-maintenance", { clusterId, days: DAYS }), token));

export function AksMaintenanceChip({ clusterId }: { clusterId: string }) {
  const { t } = useI18n();
  const { data } = useNodeMaintenance(clusterId);
  const now = Date.now();
  const e = recentEpisode(data, now);
  if (!e) return null;
  const ago = e.end === null ? t("nm.status.inProgress") : t("nm.ago", { dur: durationText(t, now - Date.parse(e.end)) });
  const label = t("nm.chip", { kind: t(`nm.kind.${e.kind}`), ago });
  return <span className={styles.cardChip} data-tone="lc" title={`${label} — ${t(`nm.by.${e.initiator}`)}`}>{label}</span>;
}

export function AksMaintenanceSection({ clusterId }: { clusterId: string }) {
  const { t } = useI18n();
  const { data, error, loading } = useNodeMaintenance(clusterId);
  return (
    <Section id="aks-maintenance" title={t("nm.title")} count={data?.episodes.length}>
      {error ? <FetchFailed what={t("nm.title")} /> : !data ? (loading ? <div className={styles.dpMuted}>{t("common.loading")}</div> : null) : <Body d={data} compact />}
    </Section>
  );
}

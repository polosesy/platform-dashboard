"use client";

import styles from "./styles.module.css";
import { useAksClusters } from "@/lib/useAksClusters";
import { useI18n } from "@/lib/i18n";
import { EmptyState, PageHeader, SearchInput, Select } from "@/components/ui";
import { HubbleTab } from "../observability/components/HubbleTab";

/** Standalone Hubble view — same content as the Observability › Hubble Network tab. */
export default function HubblePage() {
  const { clusters, clusterId, setClusterId, loading } = useAksClusters();
  const { t } = useI18n();

  return (
    <div className={styles.page}>
      <PageHeader
      />

      {clusterId ? (
        <HubbleTab key={clusterId} clusterId={clusterId} />
      ) : (
        !loading && (
          <EmptyState title={t("hub.pickCluster")}>{t("hub.pickClusterHint")}</EmptyState>
        )
      )}
    </div>
  );
}

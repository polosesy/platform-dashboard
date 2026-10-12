"use client";

import { useState } from "react";
import type { HubbleStatusResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { ServiceMapTab } from "../../hubble/components/ServiceMapTab";
import { FlowsTab } from "../../hubble/components/FlowsTab";
import { NetworkTab } from "../../hubble/components/NetworkTab";
import { SecurityTab } from "../../hubble/components/SecurityTab";
import styles from "../../hubble/styles.module.css";
import { Button, Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

type Props = { clusterId: string };

type SubTab = "service-map" | "flows" | "network" | "security";

const SUB_TABS: SubTab[] = ["service-map", "flows", "network", "security"];

/** Hubble status badges + Service Map / Flows / Network / Security sub-tabs for one cluster. */
export function HubbleTab({ clusterId }: Props) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<SubTab>("service-map");
  const status = useApiQuery(clusterId ? `hubble-status:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<HubbleStatusResponse>(apiUrl("/api/hubble/status", { clusterId }), token),
  );
  // Ignore a previous cluster's status while the new one loads
  const hubbleStatus = status.data?.clusterId === clusterId ? status.data : null;

  return (
    <div>
      {/* Hubble Status */}
      <div className={styles.statusBadges}>
        {hubbleStatus ? (
          <>
            <span className={`${styles.statusBadge} ${hubbleStatus.available ? styles.statusOk : styles.statusOff}`}>
              Hubble: {hubbleStatus.available ? "연결됨" : "연결 안 됨"}
            </span>
            {hubbleStatus.available && (
              <>
                <span
                  className={`${styles.statusBadge} ${hubbleStatus.nodeCount < hubbleStatus.nodesTotal ? styles.statusOff : styles.statusOk}`}
                  title="cilium agent가 응답한 노드 / 전체 노드"
                >
                  노드: {hubbleStatus.nodeCount}/{hubbleStatus.nodesTotal}
                </span>
                <span className={`${styles.statusBadge} ${styles.statusOk}`} title="모든 노드 링 버퍼 합계 (보관 중 / 최대)">
                  버퍼: {hubbleStatus.numFlows.toLocaleString()} / {hubbleStatus.maxFlows.toLocaleString()}
                </span>
              </>
            )}
          </>
        ) : (
          <span className={`${styles.statusBadge} ${styles.statusOff}`}>
            {status.loading ? "Hubble 상태 확인 중..." : "Hubble 상태 없음"}
          </span>
        )}
        <Button size="sm" onClick={status.reload} disabled={!clusterId}>
          {t("hub.checkStatus")}
        </Button>
      </div>

      {status.error && <div className={styles.errorMsg}>Hubble 오류: {status.error}</div>}

      {hubbleStatus?.message && hubbleStatus.message !== "connected" && (
        <div className={styles.errorMsg} style={{ marginBottom: 16 }}>
          {hubbleStatus.message}
        </div>
      )}

      {/* Sub-tabs */}
      <div className={styles.subTabs}>
        <Segmented label={t("hub.views")} value={subTab} onChange={setSubTab} items={SUB_TABS.map((id) => ({ id, label: t(`hub.view.${id}`) }))} />
      </div>

      {subTab === "service-map" && <ServiceMapTab clusterId={clusterId} />}
      {subTab === "flows" && <FlowsTab clusterId={clusterId} />}
      {subTab === "network" && <NetworkTab clusterId={clusterId} />}
      {subTab === "security" && <SecurityTab clusterId={clusterId} />}
    </div>
  );
}

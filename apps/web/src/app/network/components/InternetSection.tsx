"use client";

import Link from "next/link";
import type { NetDir, NetInternetRow } from "@aud/types";
import { Badge, Panel, Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { DIRECTIONS } from "../tabs";
import { flowTypeLabel } from "./OverviewSection";
import styles from "../styles.module.css";

const fmtInt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);

/** Public IPs talking to (inbound) or reached from (outbound) the VNet — Traffic Analytics' malicious IPs first */
export function InternetSection({ internet, dir, onDir }: { internet: { direction: NetDir; rows: NetInternetRow[] }; dir: NetDir; onDir: (d: NetDir) => void }) {
  const { t } = useI18n();
  const rows = internet.direction === dir ? internet.rows : [];
  const anyMalicious = rows.some((r) => r.malicious);
  return (
    <Panel
      title={t("net.tab.internet")}
      actions={
        <div className={styles.actions}>
          {anyMalicious ? <Link className={styles.link} href="/security/threats">{t("net.openThreats")}</Link> : null}
          <Segmented label={t("net.direction")} value={dir} onChange={onDir} items={DIRECTIONS.map((id) => ({ id, label: t(`net.dir.${id}`) }))} />
        </div>
      }
      flush
    >
      {rows.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("net.ip")}</th>
              <th>{t("net.flowType")}</th>
              <th>{t("net.country")}</th>
              <th>{t("net.targets")}</th>
              <th>{t("net.port")}</th>
              <th className={styles.num} title={t("net.recordsHint")}>{t("net.allowedRec")}</th>
              <th className={styles.num} title={t("net.recordsHint")}>{t("net.deniedRec")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ip}>
                <td className={styles.mono}>
                  {r.ip}
                  {r.malicious ? <> <Badge tone="high" title={r.threatDetail}>{r.threat ? `${t("net.malicious")} · ${r.threat}` : t("net.malicious")}</Badge></> : null}
                </td>
                <td>{r.flowTypes.map((f) => flowTypeLabel(t, f)).join(", ") || "-"}</td>
                <td>{r.country || "-"}</td>
                <td className={styles.mono}>{r.targets.join(", ") || "-"}</td>
                <td className={styles.mono}>{r.ports.join(", ") || "-"}</td>
                <td className={r.malicious && r.allowedRecords > 0 ? `${styles.num} ${styles.dangerText}` : styles.num}>{fmtInt(r.allowedRecords)}</td>
                <td className={styles.num}>{fmtInt(r.deniedRecords)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

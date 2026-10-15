"use client";

import type { NetTalkerDim, NetTalkerRow } from "@aud/types";
import { Badge, Panel, Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { formatBytes } from "@/lib/format";
import { TALKER_DIMS, isRiskyPort } from "../tabs";
import styles from "../styles.module.css";

const fmtInt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);

/** Who talks to whom the most (subnet / VM / IP pairs) and which ports carry the bytes */
export function TalkersSection({ talkers, dim, onDim }: { talkers: { dim: NetTalkerDim; rows: NetTalkerRow[] }; dim: NetTalkerDim; onDim: (d: NetTalkerDim) => void }) {
  const { t } = useI18n();
  const rows = talkers.dim === dim ? talkers.rows : [];
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  const isPort = dim === "port";
  return (
    <Panel
      title={t("net.tab.talkers")}
      actions={<Segmented label={t("net.tab.talkers")} value={dim} onChange={onDim} items={TALKER_DIMS.map((id) => ({ id, label: t(`net.dim.${id}`) }))} />}
      flush
    >
      {rows.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{isPort ? `${t("net.port")} / ${t("net.protocol")}` : t("net.pair")}</th>
              <th className={styles.num}>{t("net.bytes")}</th>
              <th className={styles.num}>{t("net.allowed")}</th>
              <th className={styles.num}>{t("net.deniedShort")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={isPort ? `${r.port}/${r.protocol}` : `${r.src}>${r.dest}:${i}`}>
                <td>
                  <div className={styles.barCell}>
                    {isPort ? (
                      <span className={styles.mono}>
                        {r.port ?? "-"} / {r.protocol ?? "-"}
                        {isRiskyPort(r) ? <> <Badge tone="high">{t("net.riskyPort")}</Badge></> : null}
                      </span>
                    ) : (
                      <span className={styles.mono}>{r.src} <span className={styles.arrow}>→</span> {r.dest}</span>
                    )}
                    <span className={styles.bar} style={{ width: `${Math.max(2, (r.bytes / max) * 100)}%` }} />
                  </div>
                </td>
                <td className={styles.num}>{formatBytes(r.bytes)}</td>
                <td className={styles.num}>{fmtInt(r.allowedFlows)}</td>
                <td className={r.deniedFlows > 0 ? `${styles.num} ${styles.dangerText}` : styles.num}>{fmtInt(r.deniedFlows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

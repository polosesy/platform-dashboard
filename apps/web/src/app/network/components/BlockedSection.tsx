"use client";

import type { NetBlockedRow } from "@aud/types";
import { Panel } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import styles from "../styles.module.css";

const fmtInt = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);

/** What the NSGs (or admin rules) turned away: by rule, direction and port, with a few sources and the last time */
export function BlockedSection({ rows }: { rows: NetBlockedRow[] }) {
  const { t, locale } = useI18n();
  return (
    <Panel title={t("net.tab.blocked")} sub={String(rows.length)} flush>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t("net.group")}</th>
            <th>{t("net.rule")}</th>
            <th>{t("net.direction")}</th>
            <th>{`${t("net.port")} / ${t("net.protocol")}`}</th>
            <th className={styles.num}>{t("net.denied")}</th>
            <th className={styles.num} title={t("net.recordsHint")}>{t("net.records")}</th>
            <th>{t("net.sources")}</th>
            <th>{t("net.lastSeen")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.group}|${r.rule}|${r.direction}|${r.port}|${i}`}>
              <td className={styles.mono}>{r.group || "-"}</td>
              <td className={styles.mono}>{r.rule || "-"}</td>
              <td>{r.direction ? t(`net.dir.${r.direction}`) : "-"}</td>
              <td className={styles.mono}>{r.port ?? "-"} / {r.protocol ?? "-"}</td>
              <td className={`${styles.num} ${styles.dangerText}`}>{fmtInt(r.deniedFlows)}</td>
              <td className={styles.num}>{fmtInt(r.records)}</td>
              <td className={styles.mono}>{r.sources.join(", ") || "-"}</td>
              <td>{r.lastSeen ? new Date(r.lastSeen).toLocaleString(dateLocale(locale)) : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

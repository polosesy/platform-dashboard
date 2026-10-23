"use client";

import type { HubbleEnforceReadiness, HubbleJudgementKind } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Notice } from "@/components/ui";
import styles from "../styles.module.css";

// What enforcing the network policy would block — from Cilium's own record of which rule allowed each new
// connection (API services/hubbleAudit.ts). Trace events carry no policy match ("policy-verdict:none"), so the
// audit form of a policy cannot be read from them; this reads the policy-verdict events instead.

const ORDER: HubbleJudgementKind[] = ["auditOnly", "policy", "default", "dropped", "unknown"];
const TONE: Record<HubbleJudgementKind, string | undefined> = {
  auditOnly: "var(--warning)", policy: "var(--success)", default: undefined, dropped: "var(--danger)", unknown: undefined,
};

export function EnforceReadiness({ data }: { data: HubbleEnforceReadiness }) {
  const { t, locale } = useI18n();
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(dateLocale(locale)) : "—");

  return (
    <section aria-labelledby="hb-audit-title">
      <h3 id="hb-audit-title" className={styles.sectionTitle}>{t("hb.audit.title")}</h3>
      <Notice tone="info">{t("hb.audit.hint")}</Notice>
      {!data.allowedBySupported && <Notice tone="warning" title={t("hb.audit.estimate")}>{t("hb.audit.estimateHint")}</Notice>}

      <div className={styles.verdictSummary}>
        {ORDER.map((k) => (
          <div key={k} className={styles.verdictBox}>
            <div className={styles.verdictBoxValue} style={{ color: data.counts[k] > 0 ? TONE[k] : undefined }}>
              {data.counts[k].toLocaleString()}
            </div>
            <div className={styles.verdictBoxLabel}>{t(`hb.audit.kind.${k}`)}</div>
          </div>
        ))}
      </div>
      <p className={styles.verdictBoxLabel}>
        {t("hb.audit.window", { n: data.verdictEvents.toLocaleString(), from: when(data.oldest), to: when(data.newest) })}
      </p>

      {data.byPolicy.length > 0 && (
        <p>
          <strong>{t("hb.audit.byPolicy")}</strong>{" "}
          {data.byPolicy.map((p) => (
            <span key={p.policy} className={styles.protocolBadge} title={p.policy}>{p.policy} · {p.count}</span>
          ))}
        </p>
      )}

      {data.wouldDrop.length > 0 ? (
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>{t("hb.col.direction")}</th>
              <th>{t("hb.audit.col.workload")}</th>
              <th>{t("hb.audit.col.peer")}</th>
              <th>{t("hb.col.port")}</th>
              <th>{t("hb.col.protocol")}</th>
              <th>{t("hb.audit.col.connections")}</th>
              <th>{t("hb.audit.col.lastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {data.wouldDrop.map((r) => (
              <tr key={`${r.direction}|${r.subject}|${r.peer}|${r.port}|${r.protocol}`}>
                <td>{r.direction}</td>
                <td style={{ fontWeight: 600 }}>{r.subject}</td>
                <td className={styles.flowMono} title={r.peerNames.length ? undefined : t("hb.audit.noName")}>
                  {r.peer}{r.peerNames.length === 0 && r.peerIdentity === 2 ? ` · ${t("hb.audit.noName")}` : ""}
                </td>
                <td className={styles.flowMono}>{r.port}</td>
                <td><span className={styles.protocolBadge}>{r.protocol}</span></td>
                <td style={{ fontWeight: 700, color: "var(--warning)" }}>{r.count}</td>
                <td>{when(r.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className={styles.noDataBanner}>
          <strong>{t("hb.audit.none")}</strong>
          {t("hb.audit.noneHint")}
        </div>
      )}
    </section>
  );
}

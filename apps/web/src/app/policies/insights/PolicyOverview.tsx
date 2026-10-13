"use client";

import type { PolicyFinding, PolicyInsightsResponse } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import type { InsightsNav } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import { RiskHeatmap, type HeatSel } from "./RiskHeatmap";
import { RiskCombos, issueState } from "./RiskCombos";
import styles from "./insights.module.css";

type Props = {
  data: PolicyInsightsResponse;
  findings: PolicyFinding[];
  heatSel: HeatSel | null;
  onHeatSel: (s: HeatSel | null) => void;
  heatManaged: boolean;
  onHeatManaged: (v: boolean) => void;
  issueId: string;
  onIssue: (id: string) => void;
  checked: ReadonlySet<string>;
  onToggleAction: (id: string, on: boolean) => void;
  nav: InsightsNav;
};

export function PolicyOverview(p: Props) {
  const { t } = useI18n();
  const { KIND_LABEL, hubbleLabel } = useInsightLabels();
  const { data, findings, checked } = p;
  const security = findings.filter((f) => !f.system && f.severity !== "info" && ["psa", "networkPolicy", "rbac"].includes(f.category));
  const inIssues = new Set(data.issues.flatMap((i) => i.findingIds));
  const covered = security.filter((f) => inIssues.has(f.id));
  const rest = security.filter((f) => !inIssues.has(f.id));
  const open = data.issues.filter((i) => issueState(i, checked) !== "closed");
  const kinds = Object.entries(KIND_LABEL).map(([k, l]) => [l, open.filter((i) => i.kind === k).length] as const).filter(([, n]) => n);
  const cov = data.network.coverage;
  return (
    <div className={styles.root}>
      <section className={`${styles.panel} ${styles.verdict}`} aria-label={t("ins.ov.aria")}>
        <div className={styles.verdictMain}>
          <div>
            <h2>{t("ins.ov.checks", { n: security.length })} → <em>{t("ins.ov.combos", { n: open.length })}</em>{open.length < data.issues.length && <span className={styles.muted} style={{ fontSize: 14, fontWeight: 600 }}> {t("ins.ov.closedBy", { n: data.issues.length - open.length })}</span>}</h2>
            <div>{kinds.map(([l, n], i) => <span key={l}>{i ? " · " : ""}{l} <b>{n}</b></span>)}</div>
          </div>
          <div className={styles.ctrls}>
            <span className={styles.chip}>Hubble {hubbleLabel(cov)}</span>
            <span className={styles.chip}>{t("ins.ov.azureMatch")} {data.network.azureMatched ? data.containment.resources.length : t("ins.notConnected")}</span>
          </div>
        </div>
        <div className={styles.recon} role="img" aria-label={t("ins.ov.reconAria", { n: security.length, a: covered.length, b: rest.length })}>
          <span style={{ flex: covered.length, background: "var(--ink)" }} />
          <span style={{ flex: rest.length, background: "var(--faint)" }} />
        </div>
        <div className={styles.reconLegend}>
          <span><i style={{ background: "var(--ink)" }} />{t("ins.ov.inCombos", { n: covered.length })}</span>
          <span><i style={{ background: "var(--faint)" }} />{t("ins.ov.alone", { n: rest.length })}</span>
          <span>{t("ins.ov.total", { n: security.length })}</span>
        </div>
        {data.gaps.length > 0 && (
          <div className={styles.notice}>{t("ins.ov.gaps")}: {data.gaps.join(" · ")}</div>
        )}
        <div className={styles.position}>
          {t("ins.ov.position1")} <b>{t("ins.ov.position2")}</b>{t("ins.ov.position3")}
        </div>
      </section>

      <RiskHeatmap data={data} sel={p.heatSel} onSelect={p.onHeatSel} showManaged={p.heatManaged} onShowManaged={p.onHeatManaged} nav={p.nav} />

      <section aria-label={t("ins.ov.combosAria")} id="policy-combos" style={{ display: "grid", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>{t("ins.ov.flowTitle")}</h3>
          <div className={styles.sub}>{t("ins.ov.flowSub")}</div>
        </div>
        <RiskCombos data={data} findings={findings} selectedId={p.issueId} onSelect={p.onIssue} checked={checked} onToggleAction={p.onToggleAction} nav={p.nav} />
      </section>
    </div>
  );
}

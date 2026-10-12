"use client";

import type { PolicyFinding, PolicyInsightsResponse } from "@aud/types";
import { KIND_LABEL, hubbleLabel, type InsightsNav } from "./model";
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
      <section className={`${styles.panel} ${styles.verdict}`} aria-label="판정 요약">
        <div className={styles.verdictMain}>
          <div>
            <h2>보안 점검 {security.length}건 → 서로 이어지는 <em>위험 조합 {open.length}건</em>{open.length < data.issues.length && <span className={styles.muted} style={{ fontSize: 14, fontWeight: 600 }}> (선택한 조치로 {data.issues.length - open.length}건 닫힘)</span>}</h2>
            <div>{kinds.map(([l, n], i) => <span key={l}>{i ? " · " : ""}{l} <b>{n}</b></span>)}</div>
          </div>
          <div className={styles.ctrls}>
            <span className={styles.chip}>Hubble {hubbleLabel(cov)}</span>
            <span className={styles.chip}>Azure 리소스 매칭 {data.network.azureMatched ? `${data.containment.resources.length}개` : "미연결"}</span>
          </div>
        </div>
        <div className={styles.recon} role="img" aria-label={`보안 점검 ${security.length}건 중 위험 조합에 묶임 ${covered.length}건, 그 외 ${rest.length}건`}>
          <span style={{ flex: covered.length, background: "var(--ink)" }} />
          <span style={{ flex: rest.length, background: "var(--faint)" }} />
        </div>
        <div className={styles.reconLegend}>
          <span><i style={{ background: "var(--ink)" }} />위험 조합에 묶임 {covered.length}</span>
          <span><i style={{ background: "var(--faint)" }} />단독 점검 {rest.length} (&lsquo;점검 결과&rsquo; 탭)</span>
          <span>= 보안 점검 {security.length}건 (PSA·네트워크·RBAC, 시스템·정보 제외)</span>
        </div>
        {data.gaps.length > 0 && (
          <div className={styles.notice}>일부 데이터를 읽지 못해 해당 영역은 &lsquo;모름&rsquo;으로 표시됩니다: {data.gaps.join(" · ")}</div>
        )}
        <div className={styles.position}>
          구성(K8s API)·권한(RBAC)·관측(Hubble)·Azure 설정(ARM)을 함께 읽어, 각 위험에 <b>근거 등급과 수정 시 운영 영향</b>을 붙입니다. 미수집 값은 회색 &lsquo;?&rsquo;로만 표시하며 위험으로 색칠하지 않습니다.
        </div>
      </section>

      <RiskHeatmap data={data} sel={p.heatSel} onSelect={p.onHeatSel} showManaged={p.heatManaged} onShowManaged={p.onHeatManaged} nav={p.nav} />

      <section aria-label="위험 조합과 공격 경로" id="policy-combos" style={{ display: "grid", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>위험 조합 → 공격 경로 → 수정</h3>
          <div className={styles.sub}>카드를 고르면 경로가, 노드·간선을 누르면 근거 상세가 열립니다. 체크한 조치는 그래프·판정 숫자에 바로 반영됩니다.</div>
        </div>
        <RiskCombos data={data} findings={findings} selectedId={p.issueId} onSelect={p.onIssue} checked={checked} onToggleAction={p.onToggleAction} nav={p.nav} />
      </section>
    </div>
  );
}

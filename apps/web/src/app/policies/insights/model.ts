import type { ComboType, EvidenceKind, HubbleCoverage, RiskIssue, RiskWeight } from "@aud/types";

export const EVK: Record<EvidenceKind, string> = { obs: "Hubble 관측", perm: "RBAC 권한", cfg: "구성", unk: "추정·미확인" };
export const WEIGHT_LABEL: Record<RiskWeight, string> = { crit: "장악·탈출 직결", warn: "경로 확대", low: "위생" };
export const COMBO_LABEL: Record<ComboType, string> = { exfil: "데이터 유출", takeover: "클러스터 장악", standing: "상시 고권한", vnet: "노출+격리 없음" };
export const COMBO_FORMULA: Record<ComboType, string> = {
  exfil: "Secret 사용 ∧ 송신 제한 없음 ∧ 클러스터 밖 송신",
  takeover: "고권한 RBAC(장악 직결) ∧ SA 토큰 마운트 ∧ (root 실행 가능 ∨ 권한 상승 허용)",
  standing: "고권한 RBAC ∧ SA 토큰 마운트",
  vnet: "외부 노출 ∧ 수신 격리 없음",
};
export const KIND_LABEL: Record<RiskIssue["kind"], string> = {
  local: "클러스터 장악급 권한", exfil: "데이터 유출 채널", takeover: "클러스터 장악 경로", vnet: "네트워크 노출", standing: "상시 고권한 계정",
};
export const COLS = ["진입", "워크로드", "신원·비밀", "권한·채널", "영향"] as const;
export const TYPE_LABEL: Record<string, string> = {
  network: "네트워크", workload: "Kubernetes 워크로드", secret: "비밀 정보", identity: "신원", permission: "권한",
  azure: "Azure 리소스", node: "노드", credential: "자격증명", impact: "영향",
};

/** Circled number for the n-th issue (①…⑳), plain number beyond. */
export const issueNum = (i: number) => (i < 20 ? String.fromCharCode(0x2460 + i) : `${i + 1}.`);

export function hubbleLabel(cov: HubbleCoverage | null): string {
  return cov ? `노드 ${cov.nodesObserved}/${cov.nodesTotal} · 공통 ${cov.commonWindowMinutes}분` : "Hubble 미연결";
}

export function flowNote(cov: HubbleCoverage | null): string {
  if (!cov || !cov.nodes.length) return "관측 구간 기준";
  const spans = cov.nodes
    .filter((n) => n.oldest && n.newest)
    .map((n) => Math.round(((Date.parse(n.newest!) - Date.parse(n.oldest!)) / 60_000) * 10) / 10);
  return spans.length ? `노드별 보관 구간(${Math.min(...spans)}–${Math.max(...spans)}분) 합산` : "관측 구간 기준";
}

export const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

/** Evidence counts over a path's edges — cards, conf line and inspector use the same numbers. */
export function tally(issue: RiskIssue): Record<EvidenceKind, number> {
  const t: Record<EvidenceKind, number> = { obs: 0, perm: 0, cfg: 0, unk: 0 };
  for (const e of issue.edges) t[e.ev]++;
  return t;
}

export function confOf(issue: RiskIssue, cov: HubbleCoverage | null): string {
  const t = tally(issue);
  const parts = ([["관측", t.obs], ["권한", t.perm], ["구성", t.cfg], ["추정", t.unk]] as const).filter(([, n]) => n).map(([l, n]) => `${l} ${n}`);
  return parts.join(" · ") + (t.obs ? ` · Hubble ${hubbleLabel(cov)}` : "") + (issue.confNote ? ` — ${issue.confNote}` : "");
}

export function evidenceOf(issue: RiskIssue): Array<[EvidenceKind | "ev", string]> {
  const t = tally(issue);
  const auto = (["obs", "perm", "cfg"] as const).filter((k) => t[k]).map((k) => ["ev", `${{ obs: "관측", perm: "권한", cfg: "구성" }[k]} ${t[k]}`] as ["ev", string]);
  return [...auto, ...issue.extraEvidence.map(([k, txt]) => [k === "unk" ? "unk" : "ev", txt] as [EvidenceKind | "ev", string])];
}

/** Cross-view navigation, implemented by the page. */
export type InsightsNav = {
  openHeatRow: (rowId: string) => void;
  openNet: (nodeId: string) => void;
  openIssue: (issueId: string) => void;
};

/** Stable DOM-safe id fragment. */
export const domId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-");

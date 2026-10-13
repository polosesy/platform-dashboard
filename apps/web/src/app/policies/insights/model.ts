import type { ComboType, EvidenceKind, HubbleCoverage, RiskIssue, RiskWeight } from "@aud/types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

const COMBOS: ComboType[] = ["exfil", "takeover", "standing", "vnet"];
const KINDS: Array<RiskIssue["kind"]> = ["local", "exfil", "takeover", "vnet", "standing"];
const NODE_TYPES = ["network", "workload", "secret", "identity", "permission", "azure", "node", "credential", "impact"];

/** Every label of the insights views, in the current language (built once per locale by useInsightLabels). */
export function insightLabels(t: TFn) {
  const rec = <K extends string>(keys: readonly K[], prefix: string) => Object.fromEntries(keys.map((k) => [k, t(`${prefix}.${k}`)])) as Record<K, string>;
  const EVK = rec(["obs", "perm", "cfg", "unk"] as const, "ins.ev");
  const hubbleLabel = (cov: HubbleCoverage | null): string =>
    cov ? t("ins.hubbleCov", { n: cov.nodesObserved, m: cov.nodesTotal, min: cov.commonWindowMinutes }) : t("ins.hubbleNone");
  const flowNote = (cov: HubbleCoverage | null): string => {
    if (!cov || !cov.nodes.length) return t("ins.flowNoteWindow");
    const spans = cov.nodes
      .filter((n) => n.oldest && n.newest)
      .map((n) => Math.round(((Date.parse(n.newest!) - Date.parse(n.oldest!)) / 60_000) * 10) / 10);
    return spans.length ? t("ins.flowNoteSpans", { min: Math.min(...spans), max: Math.max(...spans) }) : t("ins.flowNoteWindow");
  };
  const short = rec(["obs", "perm", "cfg", "unk"] as const, "ins.evShort");
  return {
    EVK,
    WEIGHT_LABEL: rec(["crit", "warn", "low"] as const satisfies readonly RiskWeight[], "ins.weight"),
    COMBO_LABEL: rec(COMBOS, "ins.combo"),
    COMBO_FORMULA: rec(COMBOS, "ins.formula"),
    KIND_LABEL: rec(KINDS, "ins.kind"),
    COLS: [0, 1, 2, 3, 4].map((i) => t(`ins.col.${i}`)),
    TYPE_LABEL: rec(NODE_TYPES, "ins.type") as Record<string, string>,
    hubbleLabel,
    flowNote,
    confOf(issue: RiskIssue, cov: HubbleCoverage | null): string {
      const n = tally(issue);
      const parts = (["obs", "perm", "cfg", "unk"] as const).filter((k) => n[k]).map((k) => `${short[k]} ${n[k]}`);
      return parts.join(" · ") + (n.obs ? ` · Hubble ${hubbleLabel(cov)}` : "") + (issue.confNote ? ` — ${issue.confNote}` : "");
    },
    evidenceOf(issue: RiskIssue): Array<[EvidenceKind | "ev", string]> {
      const n = tally(issue);
      const auto = (["obs", "perm", "cfg"] as const).filter((k) => n[k]).map((k) => ["ev", `${short[k]} ${n[k]}`] as ["ev", string]);
      return [...auto, ...issue.extraEvidence.map(([k, txt]) => [k === "unk" ? "unk" : "ev", txt] as [EvidenceKind | "ev", string])];
    },
  };
}
export type InsightLabels = ReturnType<typeof insightLabels>;

/** Circled number for the n-th issue (①…⑳), plain number beyond. */
export const issueNum = (i: number) => (i < 20 ? String.fromCharCode(0x2460 + i) : `${i + 1}.`);

export const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

/** Evidence counts over a path's edges — cards, conf line and inspector use the same numbers. */
export function tally(issue: RiskIssue): Record<EvidenceKind, number> {
  const t: Record<EvidenceKind, number> = { obs: 0, perm: 0, cfg: 0, unk: 0 };
  for (const e of issue.edges) t[e.ev]++;
  return t;
}

/** Cross-view navigation, implemented by the page. */
export type InsightsNav = {
  openHeatRow: (rowId: string) => void;
  openNet: (nodeId: string) => void;
  openIssue: (issueId: string) => void;
};

/** Stable DOM-safe id fragment. */
export const domId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-");

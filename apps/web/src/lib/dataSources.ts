// AKS 모니터링 data source chips (pure): Prometheus and Container Insights always show; Loki · Tempo · Pyroscope ·
// Grafana show when set up or when the workspace metrics see the cluster shipping to them; the rest fold into one
// "+n 설정 안 됨" chip. States are the API's (services/observabilitySources.ts) — nothing is upgraded here.

import type { ObservabilityDataSourceStatus, ObservabilitySource, ObservabilitySourceKind, ObservabilitySourceState } from "@aud/types";

export type ChipState = ObservabilitySourceState | "notRead";
export type ChipKind = ObservabilitySourceKind | "prometheus" | "containerInsights" | "appInsights";
export type SourceChip = { kind: ChipKind; label: string; state: ChipState; pipeline: ObservabilitySource["pipeline"]; href?: string; detail?: string };

export const CHIP_GLYPH: Record<ChipState, string> = { read: "✓", link: "↗", blocked: "✕", error: "!", off: "–", notRead: "–" };
const LABEL: Record<ChipKind, string> = {
  prometheus: "Prometheus", containerInsights: "Container Insights", loki: "Loki", tempo: "Tempo", pyroscope: "Pyroscope", grafana: "Grafana", appInsights: "App Insights",
};
const ORDER: ChipKind[] = ["prometheus", "containerInsights", "loki", "tempo", "pyroscope", "grafana", "appInsights"];

export function sourceChips(legacy: ObservabilityDataSourceStatus | null, sources: ObservabilitySource[] | null): { shown: SourceChip[]; folded: SourceChip[] } {
  const all: SourceChip[] = [];
  if (legacy) {
    all.push({ kind: "prometheus", label: LABEL.prometheus, state: legacy.prometheus ? "read" : "notRead", pipeline: null });
    all.push({ kind: "containerInsights", label: LABEL.containerInsights, state: legacy.containerInsights ? "read" : "notRead", pipeline: null });
    all.push({ kind: "appInsights", label: LABEL.appInsights, state: legacy.appInsights ? "read" : "off", pipeline: null });
  }
  for (const s of sources ?? []) {
    all.push({ kind: s.kind, label: LABEL[s.kind], state: s.state, pipeline: s.pipeline, ...(s.href ? { href: s.href } : {}), ...(s.detail ? { detail: s.detail } : {}) });
  }
  all.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const always = (c: SourceChip) => c.kind === "prometheus" || c.kind === "containerInsights";
  const shown = all.filter((c) => always(c) || c.state !== "off" || c.pipeline === "seen");
  return { shown, folded: all.filter((c) => !shown.includes(c)) };
}

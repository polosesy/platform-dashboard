// View helpers for node maintenance (AKS 모니터링 › 노드, 라이브 다이어그램 AKS 패널) and pod readiness (수집 상태).
// Pure; tested from apps/api/test/nodeMaintView.test.ts.
import type { NodeMaintEpisode, NodeMaintenanceResponse } from "@aud/types";

type T = (k: string, v?: Record<string, string | number>) => string;

/** "3시간 36분" / "45분" / "2일 4시간" — whole minutes, two units at most */
export function durationText(t: T, ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d) return h ? t("nm.dur.dh", { d, h }) : t("nm.dur.d", { d });
  if (h) return min ? t("nm.dur.hm", { h, m: min }) : t("nm.dur.h", { h });
  return t("nm.dur.m", { m: min });
}

/** A span's length; open spans run to `now` */
export const spanMs = (start: string, end: string | null, now: number) => (end ? Date.parse(end) : now) - Date.parse(start);

/** The latest episode, if it is running or ended within `hours` — what a card chip shows */
export function recentEpisode(r: NodeMaintenanceResponse | null | undefined, now: number, hours = 24): NodeMaintEpisode | null {
  const e = r?.episodes[0];
  if (!e) return null;
  return e.end === null || now - Date.parse(e.end) <= hours * 3_600_000 ? e : null;
}

/** Nodes of an episode by what happened to them (counts for the summary line) */
export function nodeCounts(e: NodeMaintEpisode): { surge: number; reRegistered: number; notReady: number; cordoned: number } {
  return {
    surge: e.nodes.filter((n) => n.surge).length,
    reRegistered: e.nodes.filter((n) => n.reRegistered).length,
    notReady: e.nodes.filter((n) => n.notReady).length,
    cordoned: e.nodes.filter((n) => n.cordoned).length,
  };
}

/** The version change an episode shows, if all its changed nodes agree (kernel or kubelet) */
export function versionChange(e: NodeMaintEpisode): { kind: "kubelet" | "kernel"; from: string; to: string } | null {
  for (const kind of ["kubelet", "kernel"] as const) {
    const pairs = [...new Set(e.nodes.map((n) => n[kind]).filter(Boolean).map((v) => `${v!.from}→${v!.to}`))];
    if (pairs.length === 1) { const [from, to] = pairs[0]!.split("→") as [string, string]; return { kind, from, to }; }
  }
  return null;
}

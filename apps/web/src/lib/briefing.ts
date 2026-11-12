// 개요 › 브리핑 (pure) — "what matters in this environment right now", said in sentences from what the other screens
// already read: alerts not yet acknowledged, Resource Health, Defender recommendations (subscription), and for the
// selected cluster the workload heatmap, SLO burn, Warning events still happening and the Kubernetes version.
//
// Rules: a source still loading says "reading" (it used to read "could not be read" until it arrived); one that
// failed says "not checked" — neither is ever a zero or an "OK". Rows are grouped: act now (■ ▲) · good to know
// (updates available, sources not checked) · fine (●). The headline counts only what needs action.

export type BriefLevel = "danger" | "warn" | "info" | "ok" | "unknown" | "loading";
export type BriefGroup = "now" | "know" | "fine";
export type BriefRow = { id: string; level: BriefLevel; group: BriefGroup; key: string; params: Record<string, string | number>; href: string };
/** loading = not answered yet · failed = could not be read · ok = `data` holds the numbers */
export type BriefSource<T> = { state: "loading" | "failed" | "ok" | "off"; data?: T; sample?: boolean };

export type BriefInput = {
  alerts: BriefSource<{ firingUnacked: number; high: number }>;
  health: BriefSource<{ unavailable: number; degraded: number; total: number }>;
  security: BriefSource<{ high: number; medium: number }>;
  /** The selected cluster's sources — `off` when no cluster is selected (their rows are left out) */
  workloads: BriefSource<{ danger: number; warn: number; total: number; worst?: string }>;
  slo: BriefSource<{ burning: number; exhausted: number; total: number; worst?: string }>;
  events: BriefSource<{ recent: number; total: number; topReason?: string }>;
  version: BriefSource<{ state: "upToDate" | "patch" | "minor" | "unknown"; current: string; to: string | null; poolsBehind: number }>;
  cluster?: string;
};

const GROUP: Record<BriefLevel, BriefGroup> = { danger: "now", warn: "now", info: "know", unknown: "know", loading: "know", ok: "fine" };
const RANK: Record<BriefLevel, number> = { danger: 0, warn: 1, info: 2, unknown: 3, loading: 4, ok: 5 };

/** Pure: the briefing rows (worst first) and what the headline counts */
export function briefing(i: BriefInput): { rows: BriefRow[]; act: number; danger: number; unchecked: number; loading: number; sample: boolean } {
  const rows: BriefRow[] = [];
  const add = (id: string, level: BriefLevel, key: string, href: string, params: Record<string, string | number> = {}) =>
    rows.push({ id, level, group: GROUP[level], key, params, href });
  /** The two states every source shares; true = handled */
  const pending = (id: string, s: BriefSource<unknown>, href: string): boolean => {
    if (s.state === "off") return true;
    if (s.state === "loading") { add(id, "loading", `brief.${id}.loading`, href); return true; }
    if (s.state === "failed" || !s.data) { add(id, "unknown", `brief.${id}.unknown`, href); return true; }
    return false;
  };

  if (!pending("alerts", i.alerts, "/notifications")) {
    const a = i.alerts.data!;
    if (a.firingUnacked > 0) add("alerts", a.high > 0 ? "danger" : "warn", "brief.alerts.firing", "/notifications", { n: a.firingUnacked, high: a.high });
    else add("alerts", "ok", "brief.alerts.ok", "/notifications");
  }
  if (!pending("health", i.health, "/health")) {
    const h = i.health.data!;
    if (h.unavailable > 0) add("health", "danger", "brief.health.unavailable", "/health", { n: h.unavailable, degraded: h.degraded });
    else if (h.degraded > 0) add("health", "warn", "brief.health.degraded", "/health", { n: h.degraded });
    else add("health", "ok", "brief.health.ok", "/health", { n: h.total });
  }
  if (!pending("security", i.security, "/security")) {
    const s = i.security.data!;
    if (s.high > 0) add("security", "danger", "brief.security.high", "/security/findings", { n: s.high });
    else if (s.medium > 0) add("security", "warn", "brief.security.medium", "/security/findings", { n: s.medium });
    else add("security", "ok", "brief.security.ok", "/security");
  }
  const c = i.cluster ?? "";
  if (!pending("workloads", i.workloads, "/observability")) {
    const w = i.workloads.data!;
    if (w.danger > 0) add("workloads", "danger", "brief.workloads.danger", "/observability", { n: w.danger, warn: w.warn, worst: w.worst ?? "—", cluster: c });
    else if (w.warn > 0) add("workloads", "warn", "brief.workloads.warn", "/observability", { n: w.warn, cluster: c });
    else add("workloads", "ok", "brief.workloads.ok", "/observability", { n: w.total, cluster: c });
  }
  if (!pending("slo", i.slo, "/observability")) {
    const s = i.slo.data!;
    if (s.total === 0) { /* no service with request metrics: nothing to brief */ }
    else if (s.burning > 0) add("slo", "danger", "brief.slo.burning", "/observability", { n: s.burning, worst: s.worst ?? "—" });
    else if (s.exhausted > 0) add("slo", "warn", "brief.slo.exhausted", "/observability", { n: s.exhausted, worst: s.worst ?? "—" });
    else add("slo", "ok", "brief.slo.ok", "/observability", { n: s.total });
  }
  if (!pending("events", i.events, "/observability")) {
    const e = i.events.data!;
    if (e.recent > 0) add("events", "warn", "brief.events.recent", "/observability", { n: e.recent, reason: e.topReason ?? "—" });
    else add("events", "ok", "brief.events.ok", "/observability", { n: e.total });
  }
  if (!pending("version", i.version, "/kubernetes")) {
    const v = i.version.data!;
    if (v.poolsBehind > 0) add("version", "warn", "brief.version.pools", "/kubernetes", { n: v.poolsBehind, v: v.current });
    else if (v.state === "patch") add("version", "info", "brief.version.patch", "/kubernetes", { v: v.current, to: v.to ?? "" });
    else if (v.state === "minor") add("version", "info", "brief.version.minor", "/kubernetes", { v: v.current, to: v.to ?? "" });
    else if (v.state === "upToDate") add("version", "ok", "brief.version.ok", "/kubernetes", { v: v.current });
    else add("version", "unknown", "brief.version.unknown", "/kubernetes");
  }

  rows.sort((x, y) => RANK[x.level] - RANK[y.level]);
  return {
    rows,
    act: rows.filter((r) => r.group === "now").length,
    danger: rows.filter((r) => r.level === "danger").length,
    unchecked: rows.filter((r) => r.level === "unknown").length,
    loading: rows.filter((r) => r.level === "loading").length,
    sample: [i.alerts, i.health, i.security].some((s) => s.sample),
  };
}

/** Pure: the headline's key — still reading counts as "so far" so the sentence never claims more than was read */
export function headlineKey(b: { act: number; unchecked: number; loading: number }): string {
  if (b.act > 0) return b.loading > 0 ? "brief.head.actSoFar" : "brief.head.act";
  if (b.loading > 0) return "brief.head.reading";
  return b.unchecked > 0 ? "brief.head.unchecked" : "brief.head.ok";
}

/** The platform's core features on the first screen: where to go for what (route → i18n `home.feat.<id>`) */
export const CORE_FEATURES: { id: string; href: string; icon: "sitemap" | "activity" | "gauge" | "radar" | "wallet" | "bell" }[] = [
  { id: "architecture", href: "/architecture", icon: "sitemap" },
  { id: "live", href: "/live-diagram", icon: "activity" },
  { id: "monitoring", href: "/observability", icon: "gauge" },
  { id: "risk", href: "/security/risk", icon: "radar" },
  { id: "cost", href: "/cost", icon: "wallet" },
  { id: "alerts", href: "/notifications", icon: "bell" },
];

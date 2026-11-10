// 개요 › 오늘의 상태 (pure — tested in apps/api/test/loginFlow.test.ts). One sentence and a short list built from what
// other screens already read: firing alerts not yet acknowledged (알림 센터), Resource Health (리소스 상태), Defender
// recommendations by severity (보안 개요). A source that did not answer is "not checked" — never counted as zero.

export type TodayLevel = "danger" | "warn" | "ok" | "unknown";
export type TodayRow = { id: "alerts" | "health" | "security"; level: TodayLevel; key: string; params: Record<string, number>; href: string };
export type TodaySource<T> = { data: T | null; failed: boolean; sample?: boolean };

export type TodayInput = {
  alerts: TodaySource<{ firingUnacked: number; sev1: number; sev2: number }>;
  health: TodaySource<{ unavailable: number; degraded: number; total: number }>;
  security: TodaySource<{ high: number; medium: number }>;
};

/** Pure: the rows (problems first: ■ then ▲, then the sources not checked, then ● the fine ones) and the headline */
export function todayStatus(i: TodayInput): { rows: TodayRow[]; problems: number; unchecked: number; sample: boolean } {
  const rows: TodayRow[] = [];
  const a = i.alerts;
  if (a.failed || !a.data) rows.push({ id: "alerts", level: "unknown", key: "today.alerts.unknown", params: {}, href: "/notifications" });
  else if (a.data.firingUnacked > 0) {
    rows.push({ id: "alerts", level: a.data.sev1 + a.data.sev2 > 0 ? "danger" : "warn", key: "today.alerts.firing", params: { n: a.data.firingUnacked, high: a.data.sev1 + a.data.sev2 }, href: "/notifications" });
  } else rows.push({ id: "alerts", level: "ok", key: "today.alerts.ok", params: {}, href: "/notifications" });

  const h = i.health;
  if (h.failed || !h.data) rows.push({ id: "health", level: "unknown", key: "today.health.unknown", params: {}, href: "/health" });
  else if (h.data.unavailable > 0) rows.push({ id: "health", level: "danger", key: "today.health.unavailable", params: { n: h.data.unavailable, degraded: h.data.degraded }, href: "/health" });
  else if (h.data.degraded > 0) rows.push({ id: "health", level: "warn", key: "today.health.degraded", params: { n: h.data.degraded }, href: "/health" });
  else rows.push({ id: "health", level: "ok", key: "today.health.ok", params: { n: h.data.total }, href: "/health" });

  const s = i.security;
  if (s.failed || !s.data) rows.push({ id: "security", level: "unknown", key: "today.security.unknown", params: {}, href: "/security" });
  else if (s.data.high > 0) rows.push({ id: "security", level: "danger", key: "today.security.high", params: { n: s.data.high }, href: "/security/findings" });
  else if (s.data.medium > 0) rows.push({ id: "security", level: "warn", key: "today.security.medium", params: { n: s.data.medium }, href: "/security/findings" });
  else rows.push({ id: "security", level: "ok", key: "today.security.ok", params: {}, href: "/security" });

  const rank: Record<TodayLevel, number> = { danger: 0, warn: 1, unknown: 2, ok: 3 };
  rows.sort((x, y) => rank[x.level] - rank[y.level]);
  return {
    rows,
    problems: rows.filter((r) => r.level === "danger" || r.level === "warn").length,
    unchecked: rows.filter((r) => r.level === "unknown").length,
    sample: !!(i.alerts.sample || i.health.sample || i.security.sample),
  };
}

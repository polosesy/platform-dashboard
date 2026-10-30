// 알림 센터 — optional internal relay. When the platform admin sets AUD_NOTIFY_RELAY_URL (https, one address: an
// in-house bot, a mail gateway), every new alert and every firing ↔ resolved change at or above the minimum severity
// is POSTed once as {title, message, …}: `title` / `message` are finished text (the shape template-style receivers
// render with {{title}} / {{message}}), the other fields are structured for receivers that parse. No retries, no
// redirects, 5 s — the inbox stays the source of truth and records the result.
import type { NotifyAlert, NotifySeverity } from "@aud/types";

const RANK: Record<NotifySeverity, number> = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };
const SEV_TEXT: Record<NotifySeverity, string> = { sev1: "SEV1 critical", sev2: "SEV2 major", sev3: "SEV3 warning", sev4: "SEV4 info" };

export const relayWanted = (a: Pick<NotifyAlert, "severity">, min: NotifySeverity) => RANK[a.severity] <= RANK[min];

const targetText = (a: NotifyAlert) => {
  const t = a.target;
  return t.pod ? `${t.namespace ?? ""}/${t.pod}` : t.workload ? `${t.namespace ? `${t.namespace}/` : ""}${t.workload}` : t.namespace ?? t.node ?? t.resourceName ?? t.cluster ?? "";
};

/** Pure: the relay body. `base` = the dashboard's public origin (links become absolute), or null */
export function relayBody(a: NotifyAlert, base: string | null): Record<string, unknown> {
  const link = (u: string) => (u.startsWith("/") ? (base ? `${base}${u}` : null) : u);
  const links = a.links.map((l) => ({ ...l, url: link(l.url) })).filter((l): l is typeof l & { url: string } => !!l.url);
  const target = targetText(a);
  const title = `[${a.status === "firing" ? "FIRING" : "RESOLVED"}][${SEV_TEXT[a.severity]}] ${a.title}${target ? ` — ${target}` : ""}`;
  const message = [
    title,
    a.summary,
    a.description && a.description !== a.summary ? a.description : null,
    `category: ${a.category} · source: ${a.source}${a.team ? ` · team: ${a.team}` : ""}`,
    `since: ${a.startsAt}${a.endsAt ? ` · resolved: ${a.endsAt}` : ""}`,
    ...links.slice(0, 4).map((l) => `${l.kind}: ${l.url}`),
  ].filter(Boolean).join("\n");
  return {
    title, message, status: a.status, severity: a.severity, category: a.category, rule: a.rule, source: a.source,
    target: { ...a.target, subscriptionId: undefined }, team: a.team ?? null, startsAt: a.startsAt, endsAt: a.endsAt ?? null, links, id: a.id,
  };
}

export async function relay(url: string, a: NotifyAlert, base: string | null): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json" }, body: JSON.stringify(relayBody(a, base)),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false };
  }
}

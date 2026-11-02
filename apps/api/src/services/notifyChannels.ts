// 알림 센터 — outbound channels (pure). The dashboard is the relay: alerts it received (Azure common alert schema,
// Grafana, Alertmanager) go out to chat tools in the shape each one reads:
//   flow        Madras Check Flow (flowLabs BOT webhook) — a template receiver ({{json.path}}): the Azure common schema
//               fields (data.essentials.*, data.alertContext.*) AND finished `title` / `message`, so both an existing
//               Azure template and a {{title}}/{{message}} template render — the reason Grafana alerts came out blank
//   azureCommon Azure Monitor common alert schema (any receiver built for action groups)
//   grafana     Grafana webhook shape (receivers built for Grafana contact points)
//   slack       Slack incoming webhook (text + Block Kit)
//   googleChat  Google Chat incoming webhook (text)
//   teams       Microsoft Teams Workflows webhook (Adaptive Card message)
//   json        the dashboard's own {title, message, …}
// Channels are set by the platform admin only (AUD_NOTIFY_CHANNELS, JSON). The webhook URL carries the chat tool's
// secret, so it lives in its own environment variable (urlEnv, AUD_NOTIFY_URL_*) and only its host is ever shown.
import { z } from "zod";
import type { NotifyAlert, NotifyCategory, NotifyChannelInfo, NotifySeverity } from "@aud/types";

export const FORMATS = ["flow", "azureCommon", "grafana", "slack", "googleChat", "teams", "json"] as const;
export type ChannelFormat = (typeof FORMATS)[number];

const SEVS = ["sev1", "sev2", "sev3", "sev4"] as const;
const CATS = ["incident", "security", "monitoring", "change"] as const;
const RANK: Record<NotifySeverity, number> = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };

export const ChannelSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  name: z.string().trim().min(1).max(60),
  format: z.enum(FORMATS),
  /** Environment variable holding the webhook URL (secret) */
  urlEnv: z.string().regex(/^AUD_NOTIFY_URL_[A-Z0-9_]{1,40}$/),
  /** Optional environment variable whose value is sent as the Authorization header (e.g. "Bearer …") */
  authHeaderEnv: z.string().regex(/^AUD_NOTIFY_AUTH_[A-Z0-9_]{1,40}$/).optional(),
  minSeverity: z.enum(SEVS).default("sev3"),
  /** Only these categories (empty = all) */
  categories: z.array(z.enum(CATS)).default([]),
  /** Only alerts of these teams (connection file owners; empty = all, "none" = alerts without a team) */
  teams: z.array(z.string().min(1).max(60)).default([]),
  /** firing and/or resolved */
  statuses: z.array(z.enum(["firing", "resolved"])).min(1).default(["firing", "resolved"]),
  lang: z.enum(["ko", "en"]).default("ko"),
  /** Text in front of every title, e.g. "[STG] " — which environment a shared room is hearing from */
  prefix: z.string().max(30).default(""),
  /** Plain http is refused unless set (an internal server without TLS) */
  allowHttp: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).strict();
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * The channels from AUD_NOTIFY_CHANNELS (+ the older AUD_NOTIFY_RELAY_URL as a `json` channel). Throws on an invalid
 * definition — at startup, so a typo never silently drops alerts.
 */
export function loadChannels(env: { AUD_NOTIFY_CHANNELS?: string; AUD_NOTIFY_RELAY_URL?: string; AUD_NOTIFY_RELAY_MIN_SEVERITY?: NotifySeverity }): Channel[] {
  const out: Channel[] = [];
  if (env.AUD_NOTIFY_CHANNELS?.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(env.AUD_NOTIFY_CHANNELS); } catch { throw new Error("AUD_NOTIFY_CHANNELS is not valid JSON"); }
    const parsed = z.array(ChannelSchema).max(20).safeParse(raw);
    if (!parsed.success) throw new Error(`AUD_NOTIFY_CHANNELS: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    out.push(...parsed.data);
  }
  if (env.AUD_NOTIFY_RELAY_URL && !out.some((c) => c.key === "relay")) {
    out.push(ChannelSchema.parse({ key: "relay", name: "relay", format: "json", urlEnv: "AUD_NOTIFY_URL_RELAY", minSeverity: env.AUD_NOTIFY_RELAY_MIN_SEVERITY ?? "sev2" }));
  }
  const keys = new Set<string>();
  for (const c of out) { if (keys.has(c.key)) throw new Error(`AUD_NOTIFY_CHANNELS: duplicate key ${c.key}`); keys.add(c.key); }
  return out;
}

/** The webhook URL of a channel (the legacy relay keeps AUD_NOTIFY_RELAY_URL); null = not set or not allowed */
export function channelUrl(c: Channel, vars: Record<string, string | undefined>): URL | null {
  const raw = c.urlEnv === "AUD_NOTIFY_URL_RELAY" ? vars.AUD_NOTIFY_URL_RELAY ?? vars.AUD_NOTIFY_RELAY_URL : vars[c.urlEnv];
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol === "https:" || (u.protocol === "http:" && c.allowHttp)) return u;
    return null;
  } catch {
    return null;
  }
}

export function channelInfo(c: Channel, vars: Record<string, string | undefined>): NotifyChannelInfo {
  const u = channelUrl(c, vars);
  return {
    key: c.key, name: c.name, format: c.format, host: u ? u.host : null, configured: !!u, enabled: c.enabled,
    minSeverity: c.minSeverity, categories: c.categories as NotifyCategory[], teams: c.teams, statuses: c.statuses, lang: c.lang, prefix: c.prefix,
  };
}

/** Does this alert (new, or its state just changed) go to this channel? */
export function channelWants(c: Channel, a: Pick<NotifyAlert, "severity" | "category" | "team" | "status">): boolean {
  return c.enabled
    && RANK[a.severity] <= RANK[c.minSeverity]
    && (!c.categories.length || c.categories.includes(a.category))
    && (!c.teams.length || c.teams.includes(a.team ?? "none"))
    && c.statuses.includes(a.status);
}

// ── Text (shared by every format) ──

const SEV_TEXT = {
  ko: { sev1: "SEV1·긴급", sev2: "SEV2·중대", sev3: "SEV3·경고", sev4: "SEV4·정보" },
  en: { sev1: "SEV1 critical", sev2: "SEV2 major", sev3: "SEV3 warning", sev4: "SEV4 info" },
} as const;
const SEV_ICON: Record<NotifySeverity, string> = { sev1: "🔴", sev2: "🟠", sev3: "🟡", sev4: "🔵" };
const CAT_TEXT = {
  ko: { incident: "장애", security: "보안", monitoring: "모니터링", change: "변경·유지보수" },
  en: { incident: "Incident", security: "Security", monitoring: "Monitoring", change: "Change" },
} as const;
const W = {
  ko: { firing: "발생", resolved: "해소", target: "대상", since: "발생", ended: "해소", team: "팀", source: "출처", links: "링크", dashboard: "대시보드" },
  en: { firing: "FIRING", resolved: "RESOLVED", target: "Target", since: "Since", ended: "Resolved", team: "Team", source: "Source", links: "Links", dashboard: "Dashboard" },
} as const;
const LINK_TEXT = {
  ko: { dashboard: "대시보드", grafana: "Grafana", portal: "Azure Portal", runbook: "런북", silence: "무음", source: "알림 규칙" },
  en: { dashboard: "Dashboard", grafana: "Grafana", portal: "Azure Portal", runbook: "Runbook", silence: "Silence", source: "Alert rule" },
} as const;

export function targetOf(a: Pick<NotifyAlert, "target">): string {
  const t = a.target;
  if (t.pod) return `${t.namespace ? `${t.namespace}/` : ""}${t.pod}`;
  if (t.workload) return `${t.namespace ? `${t.namespace}/` : ""}${t.workload}`;
  return t.node ?? t.namespace ?? (t.resourceName ? `${t.resourceName}${t.resourceGroup ? ` (${t.resourceGroup})` : ""}` : t.cluster ?? "");
}

/** "11-02 01:00 UTC · 10:00 KST" (ko) / "2026-11-02 01:00 UTC" (en) */
export function timeText(iso: string | undefined, lang: "ko" | "en"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const utc = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  if (lang === "en") return utc;
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${utc} · ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`;
}

export type Message = {
  title: string;
  /** Lines without markup */
  lines: string[];
  links: Array<{ label: string; url: string }>;
  facts: Array<{ k: string; v: string }>;
};

/** Absolute links only (dashboard paths need the public origin) */
export function absoluteLinks(a: NotifyAlert, base: string | null, lang: "ko" | "en") {
  return a.links
    .map((l) => ({ label: LINK_TEXT[lang][l.kind], url: l.url.startsWith("/") ? (base ? `${base}${l.url}` : "") : l.url }))
    .filter((l) => l.url)
    .filter((l, i, xs) => xs.findIndex((x) => x.url === l.url) === i)
    .slice(0, 5);
}

export function messageOf(a: NotifyAlert, c: Pick<Channel, "lang" | "prefix">, base: string | null): Message {
  const L = c.lang, w: Record<keyof (typeof W)["ko"], string> = W[L];
  const target = targetOf(a);
  const title = `${c.prefix}${a.status === "resolved" ? "✅" : SEV_ICON[a.severity]} [${SEV_TEXT[L][a.severity]}][${w[a.status]}] ${a.title}${target ? ` — ${target}` : ""}`;
  const facts = [
    target ? { k: w.target, v: target } : null,
    { k: w.since, v: timeText(a.startsAt, L) },
    a.endsAt ? { k: w.ended, v: timeText(a.endsAt, L) } : null,
    { k: w.source, v: `${CAT_TEXT[L][a.category]} · ${a.service ?? a.source}` },
    a.team ? { k: w.team, v: a.team } : null,
  ].filter((x): x is { k: string; v: string } => !!x);
  const lines = [
    a.summary ? `📋 ${a.summary}` : null,
    a.description && a.description !== a.summary ? `💡 ${a.description.slice(0, 1500)}` : null,
    ...facts.map((f) => `${f.k}: ${f.v}`),
  ].filter((x): x is string => !!x);
  return { title, lines, links: absoluteLinks(a, base, L), facts };
}

export const plainText = (m: Message) => [m.title, ...m.lines, ...m.links.map((l) => `🔗 ${l.label}: ${l.url}`)].join("\n");

// ── Formats ──

const AZ_SEV: Record<NotifySeverity, string> = { sev1: "Sev0", sev2: "Sev1", sev3: "Sev2", sev4: "Sev3" };

/** Azure Monitor common alert schema — the same paths an action-group receiver reads */
export function azureCommon(a: NotifyAlert, m: Message): Record<string, unknown> {
  return {
    schemaId: "azureMonitorCommonAlertSchema",
    data: {
      essentials: {
        alertId: a.id, alertRule: a.rule, severity: AZ_SEV[a.severity],
        signalType: a.source === "azure-monitor" ? "Metric" : "Log",
        monitorCondition: a.status === "firing" ? "Fired" : "Resolved",
        monitoringService: a.service ?? a.source,
        alertTargetIDs: a.target.resourceId ? [a.target.resourceId] : [],
        configurationItems: [targetOf(a)].filter(Boolean),
        originAlertId: a.id,
        firedDateTime: a.startsAt,
        ...(a.endsAt ? { resolvedDateTime: a.endsAt } : {}),
        description: a.summary ?? a.title,
        essentialsVersion: "1.0", alertContextVersion: "1.0",
      },
      alertContext: {
        labels: { ...a.labels, alertname: a.rule, ...(a.target.namespace ? { namespace: a.target.namespace } : {}), ...(a.target.pod ? { pod: a.target.pod } : {}) },
        annotations: { summary: a.summary ?? "", description: a.description ?? "", ...(m.links[0] ? { dashboard: m.links[0].url } : {}) },
        message: plainText(m),
        links: m.links,
      },
    },
  };
}

export function grafanaShape(a: NotifyAlert, m: Message, base: string | null): Record<string, unknown> {
  return {
    receiver: "aud-dashboard", status: a.status, orgId: 1, version: "1",
    title: m.title, message: plainText(m), externalURL: base ?? "",
    groupKey: `{}:{alertname="${a.rule}"}`, truncatedAlerts: 0,
    groupLabels: { alertname: a.rule }, commonLabels: { ...a.labels, alertname: a.rule, severity: a.severity }, commonAnnotations: { summary: a.summary ?? "" },
    alerts: [{
      status: a.status, labels: { ...a.labels, alertname: a.rule, severity: a.severity },
      annotations: { summary: a.summary ?? "", description: a.description ?? "" },
      startsAt: a.startsAt, endsAt: a.endsAt ?? "0001-01-01T00:00:00Z", fingerprint: a.id, values: a.values ?? {},
      generatorURL: m.links[0]?.url ?? "", silenceURL: "", dashboardURL: "", panelURL: "",
    }],
  };
}

const slackEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackShape(m: Message): Record<string, unknown> {
  return {
    text: m.title,
    blocks: [
      { type: "header", text: { type: "plain_text", text: m.title.slice(0, 150), emoji: true } },
      ...(m.lines.length ? [{ type: "section", text: { type: "mrkdwn", text: slackEsc(m.lines.join("\n")).slice(0, 2900) } }] : []),
      ...(m.links.length ? [{ type: "actions", elements: m.links.map((l) => ({ type: "button", text: { type: "plain_text", text: l.label }, url: l.url })) }] : []),
    ],
  };
}

export function googleChatShape(m: Message): Record<string, unknown> {
  return { text: [`*${m.title}*`, ...m.lines, ...m.links.map((l) => `<${l.url}|${l.label}>`)].join("\n").slice(0, 4000) };
}

export function teamsShape(a: NotifyAlert, m: Message): Record<string, unknown> {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: m.title, weight: "Bolder", size: "Medium", wrap: true, color: a.status === "resolved" ? "Good" : a.severity === "sev1" || a.severity === "sev2" ? "Attention" : "Warning" },
          ...(a.summary ? [{ type: "TextBlock", text: a.summary, wrap: true }] : []),
          ...(a.description && a.description !== a.summary ? [{ type: "TextBlock", text: a.description.slice(0, 1500), wrap: true, isSubtle: true }] : []),
          { type: "FactSet", facts: m.facts.map((f) => ({ title: f.k, value: f.v })) },
        ],
        actions: m.links.map((l) => ({ type: "Action.OpenUrl", title: l.label, url: l.url })),
      },
    }],
  };
}

/** The request body for a channel */
export function channelPayload(c: Pick<Channel, "format" | "lang" | "prefix">, a: NotifyAlert, base: string | null): Record<string, unknown> {
  const m = messageOf(a, c, base);
  switch (c.format) {
    case "flow": return { ...azureCommon(a, m), title: m.title, message: plainText(m), status: a.status, severity: a.severity, category: a.category, team: a.team ?? null };
    case "azureCommon": return azureCommon(a, m);
    case "grafana": return grafanaShape(a, m, base);
    case "slack": return slackShape(m);
    case "googleChat": return googleChatShape(m);
    case "teams": return teamsShape(a, m);
    case "json": return {
      title: m.title, message: plainText(m), status: a.status, severity: a.severity, category: a.category, rule: a.rule, source: a.source,
      target: { ...a.target, subscriptionId: undefined }, team: a.team ?? null, startsAt: a.startsAt, endsAt: a.endsAt ?? null, links: m.links, id: a.id,
    };
  }
}

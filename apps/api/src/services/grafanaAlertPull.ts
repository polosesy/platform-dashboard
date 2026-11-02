// 알림 센터 › Grafana에서 가져오기 (pull) — the dashboard reads the active alerts of a Grafana instance itself and feeds
// them to the same inbox + relay channels as the webhook receiver. Why: Azure Managed Grafana sends contact-point
// webhooks over the public internet, and a private AKS cluster's receiver is not reachable from there; reading the
// Alertmanager API outward needs no public ingress and no change to the Grafana contact points (Google Chat keeps its
// own path — the same alert reaches Google Chat from Grafana and Flow through this relay).
//
// API: GET <grafana>/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false (Grafana
// Alertmanager, Prometheus Alertmanager v2 shape: labels, annotations, startsAt, fingerprint, receivers[{name}],
// status.state). Silenced / inhibited alerts are left out (Grafana does not send them to Google Chat either).
// Filter: the receivers (contact points) the alert is routed to — e.g. only the stg Google Chat contact points.
// Resolved: an alert seen before that is no longer active (the API lists active alerts only).
// Auth: Azure Managed Grafana (*.grafana.azure.com) — the platform identity's Entra token (role "Grafana Viewer" on the
// Grafana resource, no secret); any other Grafana — a service account token (AUD_NOTIFY_PULL_GRAFANA_TOKEN, Viewer).

import type { Env } from "../env.js";

/** Azure Managed Grafana's Entra application (token audience for its API) */
export const MANAGED_GRAFANA_SCOPE = "ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default";
const ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false";

export type PullConfig = { url: string; host: string; receivers: string[]; intervalMs: number; auth: "entra" | "token" };

/** Pure: the pull settings, or null when off. Throws on an invalid setting (checked at startup — no silent no-op) */
export function pullConfig(env: Pick<Env, "AUD_NOTIFY_PULL_GRAFANA_URL" | "AUD_NOTIFY_PULL_RECEIVERS" | "AUD_NOTIFY_PULL_INTERVAL_SEC" | "AUD_NOTIFY_PULL_GRAFANA_TOKEN">): PullConfig | null {
  const raw = env.AUD_NOTIFY_PULL_GRAFANA_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("AUD_NOTIFY_PULL_GRAFANA_URL is not a URL"); }
  if (u.protocol !== "https:") throw new Error("AUD_NOTIFY_PULL_GRAFANA_URL must be https");
  if (u.username || u.password || u.search) throw new Error("AUD_NOTIFY_PULL_GRAFANA_URL must not carry credentials or a query");
  const managed = /\.grafana\.azure\.com$/i.test(u.hostname);
  if (!managed && !env.AUD_NOTIFY_PULL_GRAFANA_TOKEN) throw new Error("AUD_NOTIFY_PULL_GRAFANA_TOKEN is required for a Grafana outside *.grafana.azure.com");
  const receivers = (env.AUD_NOTIFY_PULL_RECEIVERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    url: `${u.origin}${u.pathname.replace(/\/$/, "")}`, host: u.hostname, receivers,
    intervalMs: env.AUD_NOTIFY_PULL_INTERVAL_SEC * 1000,
    auth: env.AUD_NOTIFY_PULL_GRAFANA_TOKEN ? "token" : "entra",
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** One alert of the Alertmanager v2 list, in the webhook's per-alert shape (what parseAlertPayload reads) */
export type PulledAlert = { fingerprint: string; status: "firing" | "resolved"; labels: Obj; annotations: Obj; startsAt?: string; endsAt?: string; generatorURL?: string };

/** Pure: the active alerts routed to one of `receivers` (empty = every receiver) */
export function activeAlerts(list: unknown, receivers: string[]): PulledAlert[] {
  if (!Array.isArray(list)) throw new Error("unexpected_shape");
  const want = new Set(receivers);
  const out: PulledAlert[] = [];
  for (const x of list.slice(0, 2000)) {
    const a = obj(x);
    if (!a || typeof a.fingerprint !== "string") continue;
    const state = String(obj(a.status)?.state ?? "active");
    if (state !== "active") continue;
    const names = Array.isArray(a.receivers) ? a.receivers.map((r) => String(obj(r)?.name ?? "")) : [];
    if (want.size && !names.some((n) => want.has(n))) continue;
    out.push({
      fingerprint: a.fingerprint, status: "firing", labels: obj(a.labels) ?? {}, annotations: obj(a.annotations) ?? {},
      ...(typeof a.startsAt === "string" ? { startsAt: a.startsAt } : {}),
      ...(typeof a.generatorURL === "string" ? { generatorURL: a.generatorURL } : {}),
    });
  }
  return out;
}

/**
 * Pure: one poll against the previous one — the alerts to deliver now. New and still-firing alerts go as firing (the
 * inbox only relays a status change, so a still-firing alert is not sent again); alerts that left the active list go
 * as resolved. On the first poll after start, an alert that began well before the start is recorded without being
 * relayed (`quiet`) — Google Chat had it already, and a restart must not resend every firing alert to Flow.
 */
export function pollStep(prev: Map<string, PulledAlert> | null, now: PulledAlert[], at: Date, startedAt: Date, intervalMs: number): { deliver: PulledAlert[]; quiet: Set<string>; next: Map<string, PulledAlert> } {
  const next = new Map(now.map((a) => [a.fingerprint, a]));
  const deliver: PulledAlert[] = [...now];
  const quiet = new Set<string>();
  if (prev) {
    for (const [fp, a] of prev) if (!next.has(fp)) deliver.push({ ...a, status: "resolved", endsAt: at.toISOString() });
  } else {
    const cutoff = startedAt.getTime() - 2 * intervalMs;
    for (const a of now) {
      const t = a.startsAt ? Date.parse(a.startsAt) : NaN;
      if (!Number.isFinite(t) || t < cutoff) quiet.add(a.fingerprint);
    }
  }
  return { deliver, quiet, next };
}

/** The Grafana webhook body for parseAlertPayload (orgId marks it as Grafana — the same ids as webhook deliveries) */
export const asWebhookBody = (alerts: PulledAlert[]) => ({ orgId: 1, status: alerts.some((a) => a.status === "firing") ? "firing" : "resolved", alerts });

export type PullState = {
  enabled: boolean;
  host?: string;
  receivers?: string[];
  intervalSec?: number;
  auth?: "entra" | "token";
  state: "off" | "starting" | "ok" | "failed";
  /** forbidden (401/403 — role missing) · notFound · timeout · network · http · shape */
  error?: string;
  lastAt?: string;
  lastOkAt?: string;
  active?: number;
};

/** The failure reason of one poll — a code, never the response body */
export function pullError(e: unknown): string {
  const status = (e as { status?: number })?.status;
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status) return "http";
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if ((e as Error)?.message === "unexpected_shape") return "shape";
  return "network";
}

export type PullDeps = {
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
  deliver: (body: ReturnType<typeof asWebhookBody>, quiet: Set<string>) => Promise<void>;
  now?: () => Date;
};

/** One poll (exported for the tests); keeps its memory in `mem` */
export async function pollOnce(cfg: PullConfig, deps: PullDeps, mem: { prev: Map<string, PulledAlert> | null; startedAt: Date; state: PullState }): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  mem.state.lastAt = at.toISOString();
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${cfg.url}${ALERTS_PATH}`, {
      headers: { authorization: `Bearer ${await deps.token()}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`grafana ${res.status}`), { status: res.status });
    const now = activeAlerts(await res.json(), cfg.receivers);
    const step = pollStep(mem.prev, now, at, mem.startedAt, cfg.intervalMs);
    if (step.deliver.length) await deps.deliver(asWebhookBody(step.deliver), step.quiet);
    mem.prev = step.next;
    Object.assign(mem.state, { state: "ok", lastOkAt: at.toISOString(), active: now.length });
    delete mem.state.error;
  } catch (e) {
    // A failed poll keeps the previous list — never resolves alerts because Grafana did not answer
    Object.assign(mem.state, { state: "failed", error: pullError(e) });
  }
}

/** Starts polling (no overlap, unref'd timer); returns the live state for the setup screen */
export function startGrafanaAlertPull(cfg: PullConfig, deps: PullDeps): { state: PullState; stop: () => void } {
  const state: PullState = { enabled: true, host: cfg.host, receivers: cfg.receivers, intervalSec: cfg.intervalMs / 1000, auth: cfg.auth, state: "starting" };
  const mem = { prev: null as Map<string, PulledAlert> | null, startedAt: (deps.now ?? (() => new Date()))(), state };
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pollOnce(cfg, deps, mem); } finally { busy = false; }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), cfg.intervalMs);
  first.unref?.(); timer.unref?.();
  return { state, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

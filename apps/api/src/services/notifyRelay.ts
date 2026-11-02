// 알림 센터 — sending to the outbound channels. Each new alert and each firing ↔ resolved change goes once to every
// channel whose rules want it (severity · category · team · state), in that channel's payload shape
// (notifyChannels.ts). 5 s per attempt, one retry on a network error / timeout / 5xx / 429, no redirects (a webhook
// that answers with a redirect is not followed — it could point anywhere). The inbox records the result per channel.
import type { NotifyAlert, NotifyChannelTest, NotifyDelivery } from "@aud/types";
import { channelPayload, channelUrl, channelWants, type Channel } from "./notifyChannels.js";

const TIMEOUT_MS = 5000;
const RETRY_MS = 1500;

export type SendResult = { ok: boolean; status?: number; attempts: number; error?: NotifyDelivery["error"]; ms: number };

export async function sendToChannel(
  c: Channel, a: NotifyAlert, base: string | null, vars: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; retryMs?: number } = {},
): Promise<SendResult> {
  const t0 = Date.now();
  const url = channelUrl(c, vars);
  if (!url) return { ok: false, attempts: 0, error: "notConfigured", ms: 0 };
  const auth = c.authHeaderEnv ? vars[c.authHeaderEnv] : undefined;
  const body = JSON.stringify(channelPayload(c, a, base));
  const f = opts.fetchImpl ?? fetch;
  let last: SendResult = { ok: false, attempts: 0, ms: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await f(url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json; charset=utf-8", ...(auth ? { authorization: auth } : {}) },
        body,
      });
      const ok = res.status >= 200 && res.status < 300;
      last = { ok, status: res.status, attempts: attempt, ...(ok ? {} : { error: "http" as const }), ms: Date.now() - t0 };
      if (ok || !(res.status >= 500 || res.status === 429)) return last;
    } catch (e) {
      last = { ok: false, attempts: attempt, error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network", ms: Date.now() - t0 };
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, opts.retryMs ?? RETRY_MS));
  }
  return last;
}

/** Send the changed alerts to every channel that wants them; returns the deliveries per alert id */
export async function relayChanged(
  channels: Channel[], changed: NotifyAlert[], base: string | null, vars: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; retryMs?: number } = {},
): Promise<Map<string, NotifyDelivery[]>> {
  const out = new Map<string, NotifyDelivery[]>();
  await Promise.all(changed.flatMap((a) => channels.filter((c) => channelWants(c, a)).map(async (c) => {
    const r = await sendToChannel(c, a, base, vars, opts);
    const d: NotifyDelivery = { channel: c.key, at: new Date().toISOString(), ok: r.ok, attempts: r.attempts, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}) };
    out.set(a.id, [...(out.get(a.id) ?? []), d]);
  })));
  return out;
}

export const testResult = (r: SendResult): NotifyChannelTest => ({ ok: r.ok, ms: r.ms, attempts: r.attempts, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}) });

// Hubble flows through the cluster's own Hubble UI (connections file `aks.observability.hubbleUi`) — the source for
// clusters where exec into cilium-agent is off (customer connections) and ACNS flow logs are not enabled.
//
// Why Hubble UI: Hubble Relay (the official Observer API, every node merged) is mTLS-only on AKS ACNS, and its client
// certificate is an AKS-managed Secret in kube-system. The Hubble UI backend already holds that certificate and
// asks the relay for "the last 10,000 flows, then follow" (backend flow_stream/helpers.go, GET_FLOWS_LAST default) —
// so a short sample of its `service-map-stream` gives the same flows `hubble observe` would, with no exec, no Secret
// and no new permission. It is not a published API (hubble-ui ≥ 0.13 customprotocol: JSON envelope, protobuf body):
// any parse / protocol failure is state "unsupported", never guessed data.
//
// Protocol (verified against v0.13.1 on AKS, 2026-10-27): POST <url>/api/service-map-stream with
// {"meta":{"route_name":…,"channel_id"?},"body":{"content":<base64 ui.GetEventsRequest>}} → the same envelope with
// <base64 ui.GetEventsResponse>; poll the channel until done, then send is_terminated. Replies are filtered at the
// relay (FlowFilter reply=false) — the backlog is then requests, not their echoes (ephemeral-port links vanished).

import type { Env } from "../env.js";
import type { HubbleCoverage, HubbleFlow, HubbleFlowSet } from "@aud/types";
import { CacheManager } from "../infra/cacheManager.js";
import { assertSignedInForCluster, clusterConnection } from "../infra/azureClientFactory.js";
import { safeMessage } from "../infra/requestParams.js";
import { parseHubbleJsonOutput } from "./hubbleClient.js";
import { dedupeObservations, singleSourceCoverage } from "./hubbleMerge.js";

export type HubbleUiState = "ok" | "notConfigured" | "unreachable" | "unsupported" | "failed";

export function hubbleUiConfig(env: Env, clusterId: string): { url: string } | null {
  const u = clusterConnection(env, clusterId).connection.aks?.observability?.hubbleUi;
  return u ? { url: u.url.replace(/\/+$/, "") } : null;
}

// ── minimal protobuf (only what the envelope and flow.Flow need) ──

type Field = { no: number; wt: number; v?: bigint; b?: Uint8Array };

function varint(b: Uint8Array, p: number): [bigint, number] {
  let x = 0n, s = 0n;
  for (;;) {
    if (p >= b.length) throw new Error("truncated varint");
    const c = b[p++]!;
    x |= BigInt(c & 0x7f) << s;
    if (!(c & 0x80)) return [x, p];
    s += 7n;
  }
}

/** Pure: one protobuf message's fields in wire order (unknown fields kept, so newer servers still parse) */
export function pbFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let p = 0;
  while (p < b.length) {
    let tag: bigint;
    [tag, p] = varint(b, p);
    const no = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 0) { let v: bigint; [v, p] = varint(b, p); out.push({ no, wt, v }); }
    else if (wt === 2) { let l: bigint; [l, p] = varint(b, p); const n = Number(l); if (p + n > b.length) throw new Error("truncated field"); out.push({ no, wt, b: b.subarray(p, p + n) }); p += n; }
    else if (wt === 1) { out.push({ no, wt, b: b.subarray(p, p + 8) }); p += 8; }
    else if (wt === 5) { out.push({ no, wt, b: b.subarray(p, p + 4) }); p += 4; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

const dec = new TextDecoder();
const one = (f: Field[], no: number) => f.find((x) => x.no === no);
const str = (f: Field[], no: number) => { const x = one(f, no); return x?.b ? dec.decode(x.b) : ""; };
const strs = (f: Field[], no: number) => f.filter((x) => x.no === no && x.b).map((x) => dec.decode(x.b!));
const num = (f: Field[], no: number) => Number(one(f, no)?.v ?? 0);
const sub = (f: Field[], no: number) => { const x = one(f, no); return x?.b ? pbFields(x.b) : null; };
/** A packed (or unpacked) repeated varint */
const nums = (f: Field[], no: number) => f.filter((x) => x.no === no).flatMap((x) => {
  if (x.v !== undefined) return [Number(x.v)];
  const out: number[] = [];
  let p = 0;
  while (x.b && p < x.b.length) { let v: bigint; [v, p] = varint(x.b, p); out.push(Number(v)); }
  return out;
});

function writeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return out;
}
const lenField = (no: number, bytes: number[]) => [...writeVarint((no << 3) | 2), ...writeVarint(bytes.length), ...bytes];
const packed = (no: number, vals: number[]) => lenField(no, vals.flatMap(writeVarint));

const VERDICTS = ["VERDICT_UNKNOWN", "FORWARDED", "DROPPED", "ERROR", "AUDIT", "REDIRECTED", "TRACED", "TRANSLATED"];
const VERDICT_NO: Record<string, number> = { FORWARDED: 1, DROPPED: 2, ERROR: 3, AUDIT: 4, REDIRECTED: 5 };
const EVENT_TYPE_NO: Record<string, number> = { drop: 1, trace: 4, "policy-verdict": 5, l7: 129 };
const FLOW_TYPES = ["UNKNOWN_TYPE", "L3_L4", "L7", "SOCK"];
const DIRECTIONS = ["TRAFFIC_DIRECTION_UNKNOWN", "INGRESS", "EGRESS"];
// flow.proto DropReason (Cilium 1.19) — the names hubble prints; unknown numbers stay "DROP_REASON_<n>"
const DROP_REASONS: Record<number, string> = {
  130: "DROP_REASON_UNKNOWN", 132: "INVALID_SOURCE_IP", 133: "POLICY_DENIED", 134: "INVALID_PACKET_DROPPED", 135: "CT_TRUNCATED_OR_INVALID_HEADER",
  136: "CT_MISSING_TCP_ACK_FLAG", 137: "CT_UNKNOWN_L4_PROTOCOL", 139: "UNSUPPORTED_L3_PROTOCOL", 140: "MISSED_TAIL_CALL", 141: "ERROR_WRITING_TO_PACKET",
  142: "UNKNOWN_L4_PROTOCOL", 143: "UNKNOWN_ICMPV4_CODE", 144: "UNKNOWN_ICMPV4_TYPE", 145: "UNKNOWN_ICMPV6_CODE", 146: "UNKNOWN_ICMPV6_TYPE",
  147: "ERROR_RETRIEVING_TUNNEL_KEY", 150: "UNKNOWN_L3_TARGET_ADDRESS", 151: "STALE_OR_UNROUTABLE_IP", 155: "CT_MAP_INSERTION_FAILED",
  157: "IP_FRAGMENTATION_NOT_SUPPORTED", 158: "SERVICE_BACKEND_NOT_FOUND", 160: "NO_TUNNEL_OR_ENCAPSULATION_ENDPOINT", 163: "UNKNOWN_CONNECTION_TRACKING_STATE",
  164: "LOCAL_HOST_IS_UNREACHABLE", 165: "NO_CONFIGURATION_AVAILABLE_TO_PERFORM_POLICY_DECISION", 166: "UNSUPPORTED_L2_PROTOCOL", 169: "FIB_LOOKUP_FAILED",
  171: "INVALID_IDENTITY", 172: "UNKNOWN_SENDER", 174: "IS_A_CLUSTERIP", 176: "FORBIDDEN_ICMPV6_MESSAGE", 177: "DENIED_BY_LB_SRC_RANGE_CHECK",
  181: "POLICY_DENY", 189: "AUTH_REQUIRED", 194: "NO_EGRESS_GATEWAY", 195: "UNENCRYPTED_TRAFFIC", 196: "TTL_EXCEEDED", 198: "DROP_RATE_LIMITED",
  202: "DROP_HOST_NOT_READY", 203: "DROP_EP_NOT_READY", 204: "DROP_NO_EGRESS_IP",
};

function endpointJson(f: Field[] | null): Record<string, unknown> | undefined {
  if (!f) return undefined;
  return {
    ID: num(f, 1), identity: num(f, 2), namespace: str(f, 3), labels: strs(f, 4), pod_name: str(f, 5),
    workloads: f.filter((x) => x.no === 6 && x.b).map((x) => { const w = pbFields(x.b!); return { name: str(w, 1), kind: str(w, 2) }; }),
  };
}

const policyJson = (f: Field[], no: number) =>
  f.filter((x) => x.no === no && x.b).map((x) => { const p = pbFields(x.b!); return { name: str(p, 1), namespace: str(p, 2), labels: strs(p, 3), kind: str(p, 5) }; });

/**
 * Pure: a protobuf flow.Flow → the JSON object `hubble observe -o json` prints, so the existing parser (and every
 * view built on it) reads it unchanged. Only the fields the dashboard uses are mapped.
 */
export function flowJsonFromProto(b: Uint8Array): Record<string, unknown> {
  const f = pbFields(b);
  const ts = sub(f, 1);
  const time = ts ? new Date(num(ts, 1) * 1000 + Math.floor(num(ts, 2) / 1e6)).toISOString() : undefined;
  const ip = sub(f, 5);
  const l4 = sub(f, 6);
  let l4Json: Record<string, unknown> | undefined;
  if (l4) {
    const tcp = sub(l4, 1), udp = sub(l4, 2), icmp4 = sub(l4, 3), icmp6 = sub(l4, 4);
    if (tcp) {
      const fl = sub(tcp, 3);
      const flags = fl ? Object.fromEntries(["FIN", "SYN", "RST", "PSH", "ACK", "URG", "ECE", "CWR", "NS"].map((n, i) => [n, num(fl, i + 1) === 1] as const).filter(([, on]) => on)) : undefined;
      l4Json = { TCP: { source_port: num(tcp, 1), destination_port: num(tcp, 2), ...(flags && Object.keys(flags).length ? { flags } : {}) } };
    } else if (udp) l4Json = { UDP: { source_port: num(udp, 1), destination_port: num(udp, 2) } };
    else if (icmp4) l4Json = { ICMPv4: { type: num(icmp4, 1), code: num(icmp4, 2) } };
    else if (icmp6) l4Json = { ICMPv6: { type: num(icmp6, 1), code: num(icmp6, 2) } };
  }
  const l7 = sub(f, 15);
  let l7Json: Record<string, unknown> | undefined;
  if (l7) {
    const dns = sub(l7, 100), http = sub(l7, 101);
    l7Json = {
      type: http ? "HTTP" : dns ? "DNS" : "UNKNOWN",
      ...(http ? { http: { code: num(http, 1), method: str(http, 2), url: str(http, 3), protocol: str(http, 4), latency_ns: num(l7, 2) } } : {}),
      ...(dns ? { dns: { query: str(dns, 1), ips: strs(dns, 2), rcode: num(dns, 6) } } : {}),
    };
  }
  const et = sub(f, 19);
  const reply = sub(f, 26);
  const drop = num(f, 25);
  return {
    ...(time ? { time } : {}),
    verdict: VERDICTS[num(f, 2)] ?? "VERDICT_UNKNOWN",
    ...(ip ? { IP: { source: str(ip, 1), destination: str(ip, 2) } } : {}),
    ...(l4Json ? { l4: l4Json } : {}),
    source: endpointJson(sub(f, 8)) ?? {},
    destination: endpointJson(sub(f, 9)) ?? {},
    Type: FLOW_TYPES[num(f, 10)] ?? "UNKNOWN_TYPE",
    node_name: str(f, 11),
    destination_names: strs(f, 14),
    ...(l7Json ? { l7: l7Json } : {}),
    ...(et ? { event_type: { type: num(et, 1), sub_type: num(et, 2) } } : {}),
    traffic_direction: DIRECTIONS[num(f, 22)] ?? "TRAFFIC_DIRECTION_UNKNOWN",
    ...(num(f, 23) ? { policy_match_type: num(f, 23) } : {}),
    ...(drop ? { drop_reason_desc: DROP_REASONS[drop] ?? `DROP_REASON_${drop}` } : {}),
    ...(reply ? { is_reply: num(reply, 1) === 1 } : {}),
    egress_allowed_by: policyJson(f, 21001),
    ingress_allowed_by: policyJson(f, 21002),
  };
}

/** Pure: the flows inside one GetEventsResponse (Event.flow = 3 or Event.flows = 7) */
export function flowsFromEventsResponse(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const ev of pbFields(b)) {
    if (ev.no !== 3 || !ev.b) continue; // repeated Event events = 3
    for (const e of pbFields(ev.b)) {
      if (e.no === 3 && e.b) out.push(e.b);
      else if (e.no === 7 && e.b) for (const x of pbFields(e.b)) if (x.no === 1 && x.b) out.push(x.b);
    }
  }
  return out;
}

/**
 * Pure: ui.GetEventsRequest for FLOWS with the relay-side filters. No filter = requests and drops: replies are left
 * out at the relay (FlowFilter.reply=false — a flow with unknown reply state does not match it, so drops get their
 * own entry). A verdict / event type narrows the same way `hubble observe --verdict / --type` would.
 */
export function eventsRequest(opts: { verdict?: string; type?: string } = {}): Uint8Array {
  const verdict = opts.verdict ? VERDICT_NO[opts.verdict.toUpperCase()] : undefined;
  const type = opts.type ? EVENT_TYPE_NO[opts.type.toLowerCase()] : undefined;
  const filter = (parts: number[][]) => lenField(3, lenField(2, parts.flat())); // whitelist(3) → EventFilter.flow_filter(2)
  const REPLY_FALSE = lenField(15, [0]);
  const whitelist = type !== undefined
    ? [filter([lenField(6, [0x08, ...writeVarint(type)]), ...(verdict ? [packed(5, [verdict])] : [])])]
    : verdict === 2 ? [filter([packed(5, [2])])]
    : verdict ? [filter([packed(5, [verdict]), REPLY_FALSE])]
    : [filter([REPLY_FALSE]), filter([packed(5, [2])])];
  return Uint8Array.from([...packed(1, [5]), ...whitelist.flat()]); // event_types = [FLOWS]
}

type Envelope = { meta?: { channel_id?: string; is_terminated?: boolean; is_error?: boolean; is_empty?: boolean; next_datum_id?: string; poll_delay_ms?: number; errors?: Array<{ message?: string }> }; body?: { content?: string } };

class HubbleUiError extends Error { constructor(readonly state: HubbleUiState, message: string) { super(message); } }

/**
 * Pure: what a 200 answer whose body is not a JSON envelope means. An empty body or a cut-off JSON object is an
 * answer that broke off mid-way — on stg (2026-11-13 06:37:39Z) the hubble-ui backend was OOMKilled while answering
 * (256Mi limit; one 10,000-flow channel costs it tens of Mi) and the error said "unsupported", as if the protocol were
 * wrong. Anything else (an HTML page, another protocol) is "unsupported".
 */
export function nonJsonAnswer(contentType: string | null, text: string): { state: HubbleUiState; message: string } {
  const t = text.trimStart();
  if (!t || t.startsWith("{") || /json/i.test(contentType ?? "")) {
    return { state: "failed", message: `Hubble UI's answer broke off (${text.length} bytes) — its backend may have restarted (memory limit?)` };
  }
  return { state: "unsupported", message: `Hubble UI answered ${contentType || "an unknown type"} instead of the JSON envelope` };
}

type PostFn = (meta: Record<string, unknown>, body?: Uint8Array, timeoutMs?: number) => Promise<Envelope>;

function poster(url: string): PostFn {
  return async (meta, body, timeoutMs = 10_000) => {
    let res: Response;
    try {
      res = await fetch(`${url}/api/service-map-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ meta, ...(body ? { body: { content: Buffer.from(body).toString("base64") } } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new HubbleUiError("unreachable", safeMessage(e));
    }
    if (res.status === 404 || res.status === 405) throw new HubbleUiError("unsupported", `Hubble UI ${res.status}: no service-map-stream route (hubble-ui < 0.13?)`);
    if (!res.ok) throw new HubbleUiError("failed", `Hubble UI ${res.status}`);
    let text: string;
    try { text = await res.text(); } catch (e) { const a = nonJsonAnswer(res.headers.get("content-type"), ""); throw new HubbleUiError(a.state, `${a.message}: ${safeMessage(e)}`); }
    try {
      return JSON.parse(text) as Envelope;
    } catch {
      const a = nonJsonAnswer(res.headers.get("content-type"), text);
      throw new HubbleUiError(a.state, a.message);
    }
  };
}

/** How long to wait between polls: the backend's own `poll_delay_ms` (≈ 200 ms idle, its minimum while it has data), kept in 25–500 ms */
export const pollDelay = (env: Envelope) => Math.min(500, Math.max(25, Number(env.meta?.poll_delay_ms ?? 0) || 100));
/** The backlog is done once a flow this close to the moment the channel opened arrives (clocks of nodes vs this pod) */
const CAUGHT_UP_SKEW_MS = 2_000;
/** No flow for this long after data arrived = drained */
const QUIET_MS = 1_500;

/**
 * A live sample: open the stream, read the relay's backlog (≤ `limit`, ≤ `budgetMs`), close the channel.
 *
 * The backend replays the relay's last 10,000 matching flows oldest → newest, flushed every 50 ms or 500 flows, and
 * then follows. It was read as fast as possible and stopped after two empty polls (10 ms apart): a sample stopped at
 * 179–4,500 of 10,000 flows, and always the OLDEST part — the newest minute was missing, so the 1-minute window was
 * often empty and the rare drops came and went (stg probe 2026-11-13). Now: wait the backend's poll delay, and stop
 * when the replay has caught up with the moment the channel opened, after QUIET_MS without data, at `limit`, or at
 * the budget. A stream that matches nothing (a quiet filter) ends after 3 s.
 */
export async function sampleHubbleUi(
  url: string, opts: { limit: number; verdict?: string; type?: string; budgetMs?: number },
  io: { post?: PostFn; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<HubbleFlow[]> {
  const post = io.post ?? poster(url);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const opened = now();
  const deadline = opened + (opts.budgetMs ?? 12_000);
  const raws: Record<string, unknown>[] = [];
  const route = "service-map-stream";
  let msg = await post({ route_name: route }, eventsRequest(opts));
  const channel = msg.meta?.channel_id;
  if (!channel) throw new HubbleUiError("unsupported", "Hubble UI returned no channel");
  let lastData = opened;
  // The relay sorts the replay in a short buffer — once caught up, one more poll takes what was still in it
  let caughtPolls = 0;
  try {
    for (;;) {
      if (msg.meta?.is_error) throw new HubbleUiError("failed", msg.meta.errors?.map((e) => e.message).filter(Boolean).join("; ") || "Hubble UI stream error");
      const content = msg.body?.content ? Buffer.from(msg.body.content, "base64") : null;
      const got = content?.length ? flowsFromEventsResponse(content) : [];
      let caughtUp = false;
      for (const fb of got) {
        const j = flowJsonFromProto(fb);
        raws.push(j);
        const t = typeof j.time === "string" ? Date.parse(j.time) : NaN;
        if (t >= opened - CAUGHT_UP_SKEW_MS) caughtUp = true;
      }
      const t = now();
      if (got.length) lastData = t;
      if (caughtUp || caughtPolls) caughtPolls++;
      if (msg.meta?.is_terminated || caughtPolls >= 2 || raws.length >= opts.limit || t > deadline) break;
      if (raws.length ? t - lastData > QUIET_MS : t - opened > 3_000) break;
      await sleep(pollDelay(msg));
      msg = await post({ route_name: route, channel_id: channel, ...(msg.meta?.next_datum_id ? { last_datum_id: msg.meta.next_datum_id } : {}) });
    }
  } finally {
    await post({ route_name: route, channel_id: channel, is_terminated: true }, undefined, 2_000).catch(() => undefined);
  }
  const flows = parseHubbleJsonOutput(raws.slice(-opts.limit).map((flow) => JSON.stringify({ flow })).join("\n"));
  return dedupeObservations(flows).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

/** The relay always replays this many (hubble-ui GET_FLOWS_LAST default) — every stream is read whole, then cut */
export const HUBBLE_UI_SAMPLE = 10_000;

/**
 * Pure: which backend stream answers a request. Every channel makes the backend replay up to 10,000 flows and build
 * its service map (tens of Mi at once — the stg backend has 256Mi), and hubble-ui v0.13.6 keeps a little of every
 * channel for good (its per-channel data_throttler is never stopped — infra session's reading of the upstream source:
 * ≈ 3.5 MiB a channel; the stg backend's floor rose 12 → 150 MiB over four days of dashboard use). So channels are
 * few: one "requests + drops" stream serves the service map, the summaries, the flow table (any limit), a verdict or
 * an event-type filter — all filtered here. Only policy-verdict events keep their own stream: the shared stream holds
 * about two thirds of them (stg 2026-11-13, same 0.7 min: 654 vs 1,008), and the enforce-readiness counts are the
 * point of reading them. A DROPPED-only stream reached no further back than the shared one (0.85 vs 0.89 min).
 */
export function streamOf(opts: { verdict?: string; type?: string }): { key: string; type?: string } {
  return opts.type?.toLowerCase() === "policy-verdict" ? { key: "type:policy-verdict", type: "policy-verdict" } : { key: "all" };
}

/**
 * How long a cluster's sample is reused — for every user (a sample does not depend on who asks: the platform reads
 * the cluster's own Hubble UI; access to the cluster was checked before this). Two minutes keeps it to at most two
 * channels per cluster per two minutes, however many people have the views open or press "new sample".
 */
export const HUBBLE_UI_TTL_MS = 120_000;
const cache = new CacheManager<HubbleFlowSet>(30, HUBBLE_UI_TTL_MS);
const inflight = new Map<string, Promise<HubbleFlowSet>>();
const stateCache = new CacheManager<{ state: HubbleUiState; message?: string }>(20, 60_000);
/** One channel per cluster at a time — the views ask together (the security tab alone asked for two at once) */
const gates = new Map<string, Promise<unknown>>();

/** Pure-ish: run `job` after every job already queued for `key` (a failed one does not block the next) */
export function gated<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = gates.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(job);
  const tail = run.catch(() => undefined);
  gates.set(key, tail);
  void tail.then(() => { if (gates.get(key) === tail) gates.delete(key); });
  return run;
}

/** Flows for the Hubble views (one sample per cluster for HUBBLE_UI_TTL_MS, one channel per cluster at a time); verdict / type / namespace / limit applied here */
export async function getFlowsFromHubbleUi(
  env: Env, bearerToken: string | undefined, clusterId: string,
  opts: { limit: number; namespace?: string; verdict?: string; type?: string },
): Promise<HubbleFlowSet> {
  assertSignedInForCluster(env, bearerToken);
  const cfg = hubbleUiConfig(env, clusterId);
  if (!cfg) throw new HubbleUiError("notConfigured", "aks.observability.hubbleUi is not set for this connection");
  const cluster = clusterId.toLowerCase();
  const stream = streamOf(opts);
  // No user prefix: the same sample for everyone who may see this cluster (a per-user key opened a channel per user)
  const key = `hubble-ui:${cluster}:${stream.key}`;
  const set = cache.get(key) ?? await (inflight.get(key) ?? (() => {
    const job = gated(cluster, async () => {
      const again = cache.get(key); // a job queued before this one may have read the same stream
      if (again) return again;
      const read = () => sampleHubbleUi(cfg.url, { limit: HUBBLE_UI_SAMPLE, ...(stream.type ? { type: stream.type } : {}) });
      // An answer that broke off (the backend restarted under memory pressure) is worth one more try a moment later
      const flows = await read().catch(async (e) => {
        if (!(e instanceof HubbleUiError) || e.state !== "failed" || !/broke off/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1_500));
        return read();
      });
      const s = { flows, coverage: { ...singleSourceCoverage("hubble-ui", flows) } as HubbleCoverage };
      cache.set(key, s);
      stateCache.set(cluster, { state: "ok" });
      return s;
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  })());
  const verdict = opts.verdict?.toUpperCase();
  const type = stream.type ? undefined : opts.type?.toLowerCase();
  const ns = opts.namespace;
  if (!ns && !verdict && !type && set.flows.length <= opts.limit) return set;
  const flows = set.flows
    .filter((f) => (!verdict || f.verdict === verdict) && (!type || f.eventKind === type) && (!ns || f.source.namespace === ns || f.destination.namespace === ns))
    .slice(0, opts.limit);
  return { flows, coverage: { ...set.coverage, rawEvents: flows.length } };
}

/**
 * Is the Hubble UI source usable for this cluster? (/api/hubble/sources, cached 60 s). It reads the same stream the
 * views read next — a separate "tiny" probe still made the backend replay 10,000 flows, one more channel at once.
 */
export async function hubbleUiAvailability(env: Env, bearerToken: string | undefined, clusterId: string): Promise<{ state: HubbleUiState; message?: string }> {
  const cfg = hubbleUiConfig(env, clusterId);
  if (!cfg) return { state: "notConfigured" };
  const k = clusterId.toLowerCase();
  const hit = stateCache.get(k);
  if (hit) return hit;
  let out: { state: HubbleUiState; message?: string };
  try {
    await getFlowsFromHubbleUi(env, bearerToken, clusterId, { limit: HUBBLE_UI_SAMPLE });
    out = { state: "ok" };
  } catch (e) {
    out = e instanceof HubbleUiError ? { state: e.state, message: e.message } : { state: "failed", message: safeMessage(e) };
  }
  stateCache.set(k, out);
  return out;
}

export { HubbleUiError };

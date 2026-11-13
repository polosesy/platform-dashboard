import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubbleServiceEdge, HubbleServiceNode } from "@aud/types";
import { dropClass } from "../src/services/hubbleDrops.js";
import { HUBBLE_UI_SAMPLE, gated, nonJsonAnswer, pollDelay, sampleHubbleUi, streamOf } from "../src/services/hubbleUiSource.js";
import { parseHubbleJsonOutput } from "../src/services/hubbleClient.js";
import * as netMap from "../../web/src/lib/k8sNetMap.ts";

// The web module is loaded the way k8sNetMap.test.ts loads it (tsx interop puts the exports on a default object)
const { buildNetMap, emptyMemory, remember, toneOf } = ((netMap as unknown as { default?: typeof netMap }).default ?? netMap);

// 2026-11-13 stg: a Hubble UI 502 "answered something other than the JSON envelope" (its backend was OOMKilled while
// answering), samples cut at 179–4,500 of 10,000 flows (the oldest part — the 1-minute window often empty), and the
// map painting IPv6 neighbour-discovery packets as red "blocked connections". Fake names and documentation addresses only.

test("drops are grouped by Hubble's reason: policy · IPv6 packet the IPv4-only datapath does not carry · other datapath", () => {
  const f = (dropReasonDesc: string, ip?: string) => ({ verdict: "DROPPED" as const, dropReasonDesc, sourceIp: ip ?? "192.0.2.1", destinationIp: ip ? "ff02::2" : "192.0.2.2" });
  assert.equal(dropClass(f("POLICY_DENIED")), "policy");
  assert.equal(dropClass(f("POLICY_DENY")), "policy");
  assert.equal(dropClass(f("AUTH_REQUIRED")), "policy");
  assert.equal(dropClass(f("UNSUPPORTED_L3_PROTOCOL", "fe80::1")), "ipv6");
  assert.equal(dropClass(f("UNSUPPORTED_L3_PROTOCOL")), "datapath", "the same reason with IPv4 addresses is not the IPv6 case");
  assert.equal(dropClass(f("CT_MAP_INSERTION_FAILED")), "datapath");
  assert.equal(dropClass(f("")), "datapath", "no reason = a datapath drop, never harmless");
  assert.equal(dropClass({ verdict: "FORWARDED", dropReasonDesc: "" }), null);
});

test("identity 0 is reserved:unknown (an address Cilium could not map), not init", () => {
  const line = JSON.stringify({ flow: { verdict: "DROPPED", drop_reason_desc: "UNSUPPORTED_L3_PROTOCOL", source: { identity: 4321, labels: ["k8s:io.kubernetes.pod.namespace=app", "k8s:app=web"] }, destination: { identity: 0 }, IP: { source: "fe80::1", destination: "ff02::2" } } });
  const [fl] = parseHubbleJsonOutput(line);
  assert.equal(fl!.destination.workloadName, "unknown");
  assert.equal(dropClass(fl!), "ipv6");
});

test("a 200 answer that is not JSON: cut off (empty / half an object) = failed, another type = unsupported", () => {
  assert.equal(nonJsonAnswer("application/json", "").state, "failed");
  assert.equal(nonJsonAnswer("application/json", '{"meta":{"channel_id":"ab').state, "failed");
  assert.equal(nonJsonAnswer(null, "").state, "failed");
  assert.match(nonJsonAnswer("application/json", "").message, /broke off/);
  assert.equal(nonJsonAnswer("text/html", "<!doctype html><html>").state, "unsupported");
});

test("requests share backend streams: one 'requests + drops' stream for every view, own streams only for an event type or DROPPED", () => {
  assert.equal(streamOf({}).key, "all");
  assert.equal(streamOf({ verdict: "FORWARDED" }).key, "all", "FORWARDED is filtered from the shared stream");
  assert.deepEqual(streamOf({ verdict: "dropped" }), { key: "dropped", verdict: "DROPPED" });
  assert.deepEqual(streamOf({ type: "policy-verdict" }), { key: "type:policy-verdict:", type: "policy-verdict" });
  assert.equal(HUBBLE_UI_SAMPLE, 10_000);
});

test("one Hubble UI channel per cluster at a time — a failed job does not block the next", async () => {
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) => () => new Promise<string>((res, rej) => {
    log.push(`start ${name}`);
    setTimeout(() => { log.push(`end ${name}`); if (fail) rej(new Error(name)); else res(name); }, ms);
  });
  const a = gated("c1", job("a", 20, true));
  const b = gated("c1", job("b", 5));
  const other = gated("c2", job("x", 1));
  await assert.rejects(a);
  assert.equal(await b, "b");
  assert.equal(await other, "x");
  assert.deepEqual(log.filter((l) => /[ab]$/.test(l)), ["start a", "end a", "start b", "end b"]);
});

// ── the sampler against a fake backend ──
const vi = (n: number): number[] => { const o: number[] = []; let v = n; while (v > 0x7f) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); } o.push(v); return o; };
const L = (no: number, bytes: number[]) => [...vi((no << 3) | 2), ...vi(bytes.length), ...bytes];
const V = (no: number, n: number) => [...vi(no << 3), ...vi(n)];
const S = (no: number, s: string) => L(no, [...Buffer.from(s)]);
const T0 = 1_800_000_000_000;
const flowAt = (ms: number, port: number) => [
  ...L(1, [...V(1, Math.floor(ms / 1000)), ...V(2, (ms % 1000) * 1_000_000)]), ...V(2, 1),
  ...L(5, [...S(1, "192.0.2.10"), ...S(2, "192.0.2.20")]),
  ...L(6, L(1, [...V(1, 40000 + port), ...V(2, port)])),
  ...L(8, [...V(2, 1234), ...S(3, "app"), ...S(5, "web-7d9f8b6c4d-x2k9q")]),
  ...L(9, [...V(2, 5678), ...S(3, "data"), ...S(5, "api-0")]),
  ...V(10, 1), ...S(11, "node-a"), ...L(19, V(1, 4)),
];
const batch = (flows: number[][]) => ({ meta: { channel_id: "c1", poll_delay_ms: 200 }, body: { content: Buffer.from(Uint8Array.from(flows.flatMap((f) => L(3, L(3, f))))).toString("base64") } });
const empty = { meta: { channel_id: "c1", poll_delay_ms: 200 } };

test("the sampler reads the whole replay to 'now' through empty polls, waits the backend's delay and closes the channel", async () => {
  let clock = T0;
  // oldest → newest, with the backend's 50 ms flush gaps showing up as empty polls (the old loop stopped after two)
  const answers: object[] = [
    { meta: { channel_id: "c1", poll_delay_ms: 25 } },
    batch([flowAt(T0 - 60_000, 1001), flowAt(T0 - 59_000, 1002)]), empty, empty,
    batch([flowAt(T0 - 30_000, 1003)]), empty, empty,
    batch([flowAt(T0 - 400, 1004)]), // caught up with the moment the channel opened
    batch([flowAt(T0 + 600, 1005)]), // one more poll (the relay's sort buffer)
    batch([flowAt(T0 + 900, 1006)]), // never asked for
  ];
  const sent: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  const flows = await sampleHubbleUi("http://hubble-ui.invalid", { limit: 10_000 }, {
    post: async (meta) => { sent.push(meta); return (meta.is_terminated ? { meta: { is_terminated: true } } : answers.shift()) as never; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  assert.deepEqual(flows.map((f) => f.destinationPort).sort(), [1001, 1002, 1003, 1004, 1005], "the newest minute is in the sample");
  assert.ok(sleeps.every((s) => s >= 25 && s <= 500), "the backend's poll delay, kept in 25–500 ms");
  assert.equal(sleeps[1], 200);
  assert.deepEqual(sent.at(-1), { route_name: "service-map-stream", channel_id: "c1", is_terminated: true }, "the channel is closed");
});

test("the sampler stops at the budget on a stream that never catches up, and after 3 s when nothing matches", async () => {
  let clock = T0;
  const io = (answer: () => object) => ({ post: async (meta: Record<string, unknown>) => (meta.is_terminated ? { meta: {} } : answer()) as never, sleep: async (ms: number) => { clock += ms; }, now: () => clock });
  let n = 0;
  const slow = await sampleHubbleUi("http://x.invalid", { limit: 10_000, budgetMs: 5_000 }, io(() => batch([flowAt(T0 - 300_000 + n++, 2000)])));
  assert.ok(clock - T0 <= 5_500 && slow.length > 0);
  clock = T0;
  const none = await sampleHubbleUi("http://x.invalid", { limit: 10_000 }, io(() => empty));
  assert.deepEqual(none, []);
  assert.ok(clock - T0 >= 3_000 && clock - T0 < 3_600);
  assert.equal(pollDelay({ meta: { poll_delay_ms: 5 } }), 25);
  assert.equal(pollDelay({ meta: { poll_delay_ms: 9_000 } }), 500);
});

// ── the map: an IPv6 packet is not a blocked connection ──
const node = (id: string, dropsByClass?: { policy: number; ipv6: number; datapath: number }, dropped = 0): HubbleServiceNode => ({
  id, namespace: id.split("/")[0]!, workloadName: id.split("/")[1]!, identity: 1, podCount: 1, serviceType: id.startsWith("/") ? "unknown" : "workload", labels: {}, connectedTo: [],
  metrics: { totalFlows: 5, forwardedFlows: 5 - dropped, droppedFlows: dropped, httpRequestsTotal: 0, httpErrorCount: 0, avgLatencyMs: null, dnsQueryCount: 0, dnsErrorCount: 0, ...(dropsByClass ? { dropsByClass } : {}) },
});
const edge = (s: string, d: string, dropsByClass?: { policy: number; ipv6: number; datapath: number }, dropped = 0): HubbleServiceEdge => ({
  id: `${s}->${d}:0`, sourceId: s, destinationId: d, protocol: "ICMP", port: 0, bidirectional: false, verdict: dropped ? "DROPPED" : "FORWARDED",
  metrics: { flowCount: 5, droppedCount: dropped, httpRequestCount: 0, httpErrorRate: 0, avgLatencyMs: null, flowsPerSecond: null, ...(dropsByClass ? { dropsByClass, dropReasons: ["UNSUPPORTED_L3_PROTOCOL"] } : {}) },
});

test("map: IPv6-only drops are a grey dotted line and leave the card's status alone; policy = red ■, other datapath = ▲", () => {
  const ipv6 = { policy: 0, ipv6: 3, datapath: 0 };
  assert.equal(toneOf(edge("app/web", "/unknown", ipv6, 3)), "dropIpv6");
  assert.equal(toneOf(edge("app/web", "data/api", { policy: 2, ipv6: 0, datapath: 0 }, 2)), "drop");
  assert.equal(toneOf(edge("app/web", "data/api", { policy: 0, ipv6: 0, datapath: 1 }, 1)), "dropOther");
  assert.equal(toneOf(edge("app/web", "data/api", undefined, 1)), "drop", "an older API without the split keeps the red line");

  const mem = remember(emptyMemory(), {
    nodes: [node("app/web", ipv6, 3), node("/unknown", ipv6, 3), node("data/api", { policy: 0, ipv6: 0, datapath: 1 }, 1), node("data/db", { policy: 1, ipv6: 0, datapath: 0 }, 1)],
    edges: [edge("app/web", "/unknown", ipv6, 3), edge("data/api", "data/db", { policy: 1, ipv6: 0, datapath: 1 }, 2)],
  }, T0, 60_000);
  const map = buildNetMap(mem);
  const status = Object.fromEntries(map.cards.map((c) => [c.id, c.status]));
  assert.equal(status["app/web"], "ok", "IPv6 neighbour discovery does not turn a workload red");
  assert.equal(status["data/api"], "warn");
  assert.equal(status["data/db"], "danger");
  assert.equal(map.cards.find((c) => c.id === "/unknown")?.kind, "platform", "identity 0 sits with the cluster's own parts");
  assert.deepEqual([map.totals.dropLinks, map.totals.otherDropLinks, map.totals.ipv6DropLinks], [1, 0, 1]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsRequest, flowJsonFromProto, flowsFromEventsResponse, pbFields } from "../src/services/hubbleUiSource.js";
import { parseHubbleJsonOutput } from "../src/services/hubbleClient.js";
import { pickSource } from "../src/services/hubbleSources.js";

// Hand-built protobuf (field numbers from cilium api/v1/flow/flow.proto and hubble-ui ui.proto v0.13.1); fake names only
const vi = (n: number): number[] => { const o: number[] = []; let v = n >>> 0; while (v > 0x7f) { o.push((v & 0x7f) | 0x80); v >>>= 7; } o.push(v); return o; };
const key = (no: number, wt: number) => vi((no << 3) | wt);
const V = (no: number, n: number) => [...key(no, 0), ...vi(n)];
const L = (no: number, bytes: number[]) => [...key(no, 2), ...vi(bytes.length), ...bytes];
const S = (no: number, s: string) => L(no, [...Buffer.from(s)]);

const endpoint = (ns: string, pod: string, workload: string, identity: number) =>
  [...V(2, identity), ...S(3, ns), ...S(4, `k8s:io.kubernetes.pod.namespace=${ns}`), ...S(5, pod), ...L(6, [...S(1, workload), ...S(2, "Deployment")])];

function flowBytes(opts: { verdict: number; drop?: number; reply?: boolean; type?: number; dport?: number } ) {
  return [
    ...L(1, [...V(1, 1_800_000_000), ...V(2, 5_000_000)]),             // time
    ...V(2, opts.verdict),
    ...L(5, [...S(1, "192.0.2.10"), ...S(2, "192.0.2.20")]),           // IP
    ...L(6, L(1, [...V(1, 41000), ...V(2, opts.dport ?? 8080), ...L(3, V(2, 1))])), // l4.TCP + SYN
    ...L(8, endpoint("app", "web-7d9f8b6c4d-x2k9q", "web", 1234)),
    ...L(9, endpoint("data", "api-0", "api", 5678)),
    ...V(10, 1),                                                         // L3_L4
    ...S(11, "node-a"),
    ...L(19, V(1, opts.type ?? 4)),                                      // event_type
    ...V(22, 2),                                                         // EGRESS
    ...(opts.drop ? V(25, opts.drop) : []),
    ...(opts.reply !== undefined ? L(26, V(1, opts.reply ? 1 : 0)) : []),
    ...L(21001, [...S(1, "allow-web"), ...S(2, "app"), ...S(5, "CiliumNetworkPolicy")]),
  ];
}

test("a protobuf flow.Flow becomes the hubble JSON the existing parser reads (same HubbleFlow as `hubble observe -o json`)", () => {
  const [f] = parseHubbleJsonOutput(JSON.stringify({ flow: flowJsonFromProto(Uint8Array.from(flowBytes({ verdict: 1, reply: false, type: 5 }))) }));
  assert.ok(f);
  assert.equal(f.time, new Date(1_800_000_000_005).toISOString());
  assert.deepEqual([f.verdict, f.l4Protocol, f.sourcePort, f.destinationPort, f.trafficDirection, f.isReply, f.nodeName], ["FORWARDED", "TCP", 41000, 8080, "EGRESS", false, "node-a"]);
  assert.deepEqual([f.source.namespace, f.source.workloadName, f.source.identity, f.destination.namespace, f.destination.workloadName], ["app", "web", 1234, "data", "api"]);
  assert.deepEqual([f.sourceIp, f.destinationIp, f.tcpFlags, f.eventKind], ["192.0.2.10", "192.0.2.20", "SYN", "policy-verdict"]);
  assert.deepEqual(f.allowedBy?.map((p) => p.name), ["allow-web"]);
  const [d] = parseHubbleJsonOutput(JSON.stringify({ flow: flowJsonFromProto(Uint8Array.from(flowBytes({ verdict: 2, drop: 133, type: 1 }))) }));
  assert.deepEqual([d!.verdict, d!.dropReasonDesc, d!.eventKind], ["DROPPED", "POLICY_DENIED", "drop"]);
});

test("flows are found in both event shapes of a GetEventsResponse (Event.flow = 3, Event.flows = 7)", () => {
  const fl = flowBytes({ verdict: 1, reply: false });
  const resp = Uint8Array.from([...S(1, "node-a"), ...L(3, L(3, fl)), ...L(3, L(7, [...L(1, fl), ...L(1, fl)]))]);
  assert.equal(flowsFromEventsResponse(resp).length, 3);
  assert.deepEqual(flowsFromEventsResponse(Uint8Array.from(S(1, "node-a"))), [], "a status-only message has no flows");
});

test("the request asks for FLOWS with replies filtered at the relay (drops kept separately — unknown reply state never matches reply=false)", () => {
  const req = pbFields(eventsRequest());
  assert.deepEqual(req.filter((x) => x.no === 1).map((x) => [...x.b!]), [[5]], "event_types = [FLOWS] (packed)");
  const wl = req.filter((x) => x.no === 3).map((x) => pbFields(pbFields(x.b!).find((y) => y.no === 2)!.b!));
  assert.deepEqual(wl.map((ff) => ff.map((y) => [y.no, [...y.b!]])), [[[15, [0]]], [[5, [2]]]]);
  const dropped = pbFields(eventsRequest({ verdict: "DROPPED" })).filter((x) => x.no === 3);
  assert.equal(dropped.length, 1);
  const pv = pbFields(pbFields(pbFields(eventsRequest({ type: "policy-verdict" })).find((x) => x.no === 3)!.b!)[0]!.b!);
  assert.deepEqual(pv.map((y) => [y.no, [...y.b!]]), [[6, [0x08, 5]]], "event_type filter {type: 5}");
});

test("truncated protobuf is an error, not a half-read flow", () => {
  assert.throws(() => pbFields(Uint8Array.from([0x0a, 0x05, 0x01])));
});

test("source order: exec > ACNS flow logs > Hubble UI > metrics > none", () => {
  const base = { exec: { allowed: false }, flowLogs: { state: "notEnabled" as const, rows1h: 0, newest: null }, hubbleUi: { state: "notConfigured" as const }, metrics: { state: "noWorkspace" as const } };
  assert.equal(pickSource(base), "none");
  assert.equal(pickSource({ ...base, metrics: { state: "ok" } }), "metrics");
  assert.equal(pickSource({ ...base, hubbleUi: { state: "ok" }, metrics: { state: "ok" } }), "hubbleUi");
  assert.equal(pickSource({ ...base, hubbleUi: { state: "ok" }, flowLogs: { state: "ok", rows1h: 5, newest: null } }), "flowLogs");
  assert.equal(pickSource({ ...base, exec: { allowed: true } }), "exec");
});

test("Cilium reserved identities: 6 = remote-node, 7 = kube-apiserver, 9/10 = world (they were swapped)", () => {
  const ep = (identity: number) => JSON.stringify({ flow: { verdict: "FORWARDED", source: { identity }, destination: { identity: 2 }, IP: { source: "192.0.2.1", destination: "192.0.2.2" } } });
  const names = parseHubbleJsonOutput([6, 7, 9, 10].map(ep).join("\n")).map((f) => f.source.workloadName);
  assert.deepEqual(names, ["remote-node", "kube-apiserver", "world", "world"]);
});

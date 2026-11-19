// 네트워크 경로 v2 (2026-11-19, Datadog Network Path + End User Device Monitoring): the probe keeps every traceroute probe
// by probe and end-to-end probes; the API parses (services/netPath.ts), the page aggregates (web lib/netPathGraph.ts).
// Synthetic documentation addresses (RFC 5737) — the shapes of a real Windows PowerShell 5.1 run of scripts/netpath-probe.ps1
// (2026-11-19 on a lab PC: 3 traceroutes × 18 TTLs, 12 TTLs answered = `tracert -d` at the same TTLs, 6 silent in both;
// 10 TCP 443 probes, loss / average / jitter = an independent recount of the raw times).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NetPathRun } from "@aud/types";
import { addRuns, clearNetPathMemory, e2eOf, hopInfoOf, parseNetPath, parseNetPathMany, scopeOf } from "../src/services/netPath.js";
import * as gNs from "../../web/src/lib/netPathGraph.ts";
import * as vNs from "../../web/src/lib/netPathView.ts";

const G = ((gNs as unknown as { default?: typeof gNs }).default ?? gNs) as typeof gNs;
const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;

const A = { lan: "192.168.1.1", isp: "100.64.0.1", t1: "198.51.100.1", e1: "198.51.100.21", e2: "198.51.100.22", t4: "198.51.100.40", dst: "203.0.113.10" };
type Hop = { ttl: number; ip: string | null; ms: number | null; st: "x" | "d" | "-" };
const h = (ttl: number, ip: string | null, ms: number | null, st?: Hop["st"]): Hop => ({ ttl, ip, ms, st: st ?? (ip ? "x" : "-") });
/** one traceroute: LAN → CGNAT → transit → (ECMP e1 | e2) → silent → t4 → destination */
const pass = (ecmp: string, extra = 0): Hop[] => [
  h(1, A.lan, 1.2 + extra), h(2, A.isp, 5.1 + extra), h(3, A.t1, 9.0 + extra), h(4, ecmp, ecmp === A.e1 ? 18 : 21), h(5, null, null), h(6, A.t4, 30 + extra), h(7, A.dst, 33 + extra, "d"),
];
const doc = (o: Record<string, unknown> = {}) => ({
  format: "aud-netpath/2", target: "login.example.com", targetIp: A.dst, device: "lab-pc", startedAt: "2026-11-19T01:00:00.000Z",
  protocol: "icmp", maxHops: 30, timeoutMs: 1000,
  passes: [{ hops: pass(A.e1) }, { hops: pass(A.e2) }, { hops: pass(A.e1, 1) }],
  e2e: { protocol: "tcp", port: 443, rtt: [30, 32, -1, 31, 35] }, link: { type: "Wireless80211", mbps: 287 }, ...o,
});

test("parse aud-netpath/2: passes as measured, per-TTL hops over them, end-to-end computed from the raw times", () => {
  const r = parseNetPath(JSON.stringify(doc()));
  assert.equal(r.source, "aud-netpath/2");
  assert.equal(r.passes!.length, 3);
  assert.deepEqual(r.passes![0]!.map((p) => [p.ttl, p.ip, p.dest]), [[1, A.lan, false], [2, A.isp, false], [3, A.t1, false], [4, A.e1, false], [5, null, false], [6, A.t4, false], [7, A.dst, true]]);
  assert.equal(r.probes, 3, "probes = traceroutes");
  assert.equal(r.reached, true);
  // TTL 4: two addresses over three traceroutes (ECMP) — the busiest first
  assert.deepEqual([r.hops[3]!.ip, r.hops[3]!.others, r.hops[3]!.sent, r.hops[3]!.received, r.hops[3]!.rttAvg], [A.e1, [A.e2], 3, 3, 19]);
  assert.deepEqual([r.hops[4]!.ip, r.hops[4]!.lossPct], [null, 100]);
  // e2e: 5 probes, one lost (-1): loss 20 %, average of 4, jitter over the 2 consecutive answered pairs (|32−30|, |35−31|) = 3
  assert.deepEqual({ ...r.e2e, rtt: undefined }, { protocol: "tcp", port: 443, rtt: undefined, sent: 5, received: 4, lossPct: 20, rttMin: 30, rttAvg: 32, rttMax: 35, jitter: 3 });
  assert.deepEqual(r.link, { type: "Wireless80211", mbps: 287 });
  // ConvertTo-Json quirks: one pass as a bare object, its one hop as a bare object, one e2e time as a bare number
  const one = parseNetPath(JSON.stringify(doc({ passes: { hops: h(1, A.dst, 3, "d") }, e2e: { protocol: "icmp", port: null, rtt: 4 } })));
  assert.deepEqual([one.passes!.length, one.passes![0]!.length, one.reached, one.e2e!.sent, one.e2e!.jitter], [1, 1, true, 1, null]);
  // a silent probe never carries an address or a time
  const odd = parseNetPath(JSON.stringify(doc({ passes: [{ hops: [{ ttl: 1, ip: A.lan, ms: 3, st: "-" }] }] })));
  assert.deepEqual(odd.passes![0]![0], { ttl: 1, ip: null, rtt: null, dest: false });
  assert.throws(() => parseNetPath(JSON.stringify(doc({ passes: [{ hops: [h(1, "not-an-ip", 1)] }] }))), /netpath_unknown_format/);
});

test("e2e jitter: consecutive answered probes only; under two pairs = null", () => {
  assert.equal(e2eOf("tcp", 443, [10, null, 12, 14, 11]).jitter, 2.5, "|14−12| and |11−14|");
  assert.equal(e2eOf("tcp", 443, [10, null, 12]).jitter, null);
  assert.deepEqual([e2eOf("icmp", null, [null, null]).lossPct, e2eOf("icmp", null, [null, null]).rttAvg], [100, null]);
});

test("-Lookup answers (Team Cymru TXT, PTR) → AS, name, prefix, country — junk dropped", () => {
  assert.deepEqual(hopInfoOf({ ptr: "Core1.Example.NET.", origin: "64500 64501 | 198.51.100.0/24 | US | arin | 2006-07-13", as: "64500 | US | arin | 2006-07-13 | EXAMPLE-NET - Example Networks, LLC, US" }),
    { name: "core1.example.net", asn: 64500, prefix: "198.51.100.0/24", country: "US", asName: "EXAMPLE-NET - Example Networks, LLC, US" });
  assert.deepEqual(hopInfoOf({ ptr: "bad name!", origin: "x | y" }), {});
  assert.equal(hopInfoOf({ origin: "64500 | 198.51.100.0/24 | US | arin | x", as: "64501 | US | arin | x | OTHER" }).asName, undefined, "an AS answer for another AS is not this one's name");
  const r = parseNetPath(JSON.stringify(doc({ lookup: { [A.t1]: { origin: "64500 | 198.51.100.0/24 | US | arin | 2006-07-13", as: "64500 | US | arin | 2006-07-13 | EXAMPLE-NET" } } })));
  assert.deepEqual(r.hopInfo, { [A.t1]: { asn: 64500, prefix: "198.51.100.0/24", country: "US", asName: "EXAMPLE-NET" } });
});

test("an upload of many runs: one per line (-Repeat / -OutFile), a JSON array, a pretty mtr — a bad line fails all", async () => {
  const lines = [doc({ startedAt: "2026-11-19T01:00:00Z" }), doc({ startedAt: "2026-11-19T01:05:00Z" }), doc({ startedAt: "2026-11-19T01:10:00Z" })].map((d) => JSON.stringify(d)).join("\r\n");
  assert.equal(parseNetPathMany("﻿" + lines).length, 3);
  assert.equal(parseNetPathMany(JSON.stringify([doc(), doc()])).length, 2);
  assert.equal(parseNetPathMany(JSON.stringify({ report: { mtr: { dst: A.dst }, hubs: [{ count: 1, host: A.dst, "Loss%": 0, Snt: 3, Avg: 2, Best: 1, Wrst: 3 }] } }, null, 2)).length, 1);
  assert.throws(() => parseNetPathMany(`${JSON.stringify(doc())}\nnot json`), /netpath_not_json/);
  assert.throws(() => parseNetPathMany(`${JSON.stringify(doc())}\n{"hello":1}`), /netpath_unknown_format/);
  clearNetPathMemory();
  const runs = await addRuns(undefined, lines, { by: "tester" });
  assert.equal(runs.length, 3);
  assert.equal(new Set(runs.map((r) => r.id)).size, 3);
});

const run = (id: string, at: string, o: Record<string, unknown> = {}): NetPathRun => ({ ...parseNetPath(JSON.stringify(doc({ startedAt: at, ...o }))), id, uploadedAt: at });

test("graph: a node per address per TTL, an edge per way the traceroutes went — counts add up", () => {
  const runs = [run("r1", "2026-11-19T01:00:00Z"), run("r2", "2026-11-19T01:05:00Z")];
  const g = G.buildGraph(runs, { hideUnknown: false });
  assert.equal(g.passes, 6);
  assert.equal(g.completed, 6);
  // source + 6 single hops (1,2,3,5*,6) … : lan, isp, t1, e1, e2, *5, t4, dst = 8 + source
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), [G.DEST_ID, G.SOURCE_ID, "*5", `1|${A.lan}`, `2|${A.isp}`, `3|${A.t1}`, `4|${A.e1}`, `4|${A.e2}`, `6|${A.t4}`].sort());
  const out = (id: string) => g.edges.filter((e) => e.from === id).reduce((n, e) => n + e.count, 0);
  assert.equal(out(G.SOURCE_ID), g.passes, "every traceroute leaves the source once");
  assert.equal(g.edges.find((e) => e.to === `4|${A.e1}`)!.count, 4, "two of three per run went via e1");
  assert.equal(g.edges.find((e) => e.to === `4|${A.e2}`)!.count, 2);
  assert.equal(g.nodes.find((n) => n.id === `4|${A.e1}`)!.traversed, 4);
  assert.ok(g.edges.every((e) => e.measured));
  // latency added on an edge: node average − previous node average
  const e34 = g.edges.find((e) => e.from === `3|${A.t1}` && e.to === `4|${A.e1}`)!;
  const t1 = g.nodes.find((n) => n.id === `3|${A.t1}`)!.rttAvg!, e1 = g.nodes.find((n) => n.id === `4|${A.e1}`)!.rttAvg!;
  assert.equal(e34.addedMs, Math.round((e1 - t1) * 10) / 10);
  // hidden unknown hops: the edges bridge them and say how many they skipped
  const hidden = G.buildGraph(runs, { hideUnknown: true });
  assert.ok(!hidden.nodes.some((n) => n.kind === "unknown"));
  const bridge = hidden.edges.filter((e) => e.to === `6|${A.t4}`);
  assert.deepEqual(bridge.map((e) => e.skipped), [1, 1]);
  assert.equal(bridge.reduce((n, e) => n + e.count, 0), 6);
  assert.equal(hidden.unknownTtls, 1);
  // a node's scope is its own address's (an unknown hop has none — it once borrowed the TTL's busiest address's)
  assert.equal(g.nodes.find((n) => n.kind === "unknown")!.scope, null);
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.32.0.1", "192.168.0.1", "100.64.0.1", "100.128.0.1", "169.254.1.1", "198.51.100.1", "x"]) assert.equal(G.scopeOfIp(ip), scopeOf(ip), ip);
});

test("graph: older summary runs are one dashed chain (pairing not measured); loss that carries on turns the edge red", () => {
  const v1 = parseNetPath(JSON.stringify({ format: "aud-netpath/1", target: "login.example.com", targetIp: A.dst, device: "lab-pc", startedAt: "2026-11-18T05:00:00Z", probes: 4, reached: true,
    hops: [{ ttl: 1, addresses: { [A.lan]: 4 }, sent: 4, received: 4, rtt: [1, 1, 1, 1] }, { ttl: 2, addresses: { [A.t1]: 3 }, sent: 4, received: 3, rtt: [9, 9, 9] }, { ttl: 3, addresses: { [A.dst]: 3 }, sent: 4, received: 3, rtt: [20, 20, 20] }] }));
  const g = G.buildGraph([{ ...v1, id: "v1", uploadedAt: v1.startedAt }], { hideUnknown: true });
  assert.equal(g.unpaired, true);
  assert.ok(g.edges.every((e) => !e.measured));
  // loss from TTL 2 carries on to the destination → those edges are "loss"; the first is not
  assert.equal(g.lossFrom, 2);
  assert.deepEqual(g.edges.map((e) => [e.to, e.state]), [[`1|${A.lan}`, "ok"], [`2|${A.t1}`, "loss"], [G.DEST_ID, "loss"]]);
  // my own threshold: orange only when set
  const slow = G.buildGraph([run("r", "2026-11-19T01:00:00Z")], { hideUnknown: true, slowMs: 8 });
  assert.ok(slow.edges.some((e) => e.state === "slow"));
  assert.ok(G.buildGraph([run("r", "2026-11-19T01:00:00Z")], { hideUnknown: true }).edges.every((e) => e.state === "ok"));
});

test("groups by AS / segment — consecutive hops sharing a key, unknown hops join; collapsing keeps the counts", () => {
  const as = (asn: number) => ({ origin: `${asn} | 198.51.100.0/24 | US | arin | x`, as: `${asn} | US | arin | x | NET-${asn}` });
  const r = run("r", "2026-11-19T01:00:00Z", { lookup: { [A.t1]: as(64500), [A.e1]: as(64500), [A.e2]: as(64500), [A.t4]: as(64500), [A.dst]: as(64511) } });
  for (const hideUnknown of [true, false]) {
    const g = G.buildGraph([r], { hideUnknown });
    const groups = G.groupsOf(g, "asn");
    assert.equal(groups.length, 1, `hideUnknown ${hideUnknown}`);
    assert.equal(groups[0]!.key, "AS64500");
    assert.deepEqual(groups[0]!.nodeIds.filter((id) => !id.startsWith("*")).sort(), [`3|${A.t1}`, `4|${A.e1}`, `4|${A.e2}`, `6|${A.t4}`].sort());
    const c = G.collapse(g, groups, new Set([groups[0]!.id]));
    const grp = c.nodes.find((n) => "group" in n)! as gNs.GroupNode;
    assert.equal(grp.hops, 4);
    assert.equal(grp.traversed, 3, "traceroutes entering the group");
    assert.equal(c.edges.filter((e) => e.from === G.SOURCE_ID).reduce((n, e) => n + e.count, 0), 3);
    assert.ok(!c.edges.some((e) => e.from === e.to));
    assert.equal(c.edges.filter((e) => e.to === grp.id).reduce((n, e) => n + e.count, 0), 3);
    // the edge into the group: up to its first hop, not across it
    const into = c.edges.find((e) => e.to === grp.id)!;
    assert.equal(into.addedMs, Math.round((grp.firstAvg! - g.nodes.find((n) => n.id === `2|${A.isp}`)!.rttAvg!) * 10) / 10);
  }
  // two groups side by side, both collapsed: the second is entered from the first (2026-11-19: it said 0 traversals)
  const two = run("r2", "2026-11-19T01:00:00Z", { lookup: { [A.t1]: as(64500), [A.e1]: as(64500), [A.e2]: as(64500), [A.t4]: as(64510), [A.dst]: as(64511) },
    passes: [0, 1, 2].map((i) => ({ hops: [...pass(i === 1 ? A.e2 : A.e1).slice(0, 6), h(7, "198.51.100.41", 31), { ...pass(A.e1)[6]!, ttl: 8 }] })) });
  const lookup2 = { ...two.hopInfo!, "198.51.100.41": two.hopInfo![A.t4]! };
  const g2 = G.buildGraph([{ ...two, hopInfo: lookup2 }], { hideUnknown: true });
  const gs2 = G.groupsOf(g2, "asn");
  assert.deepEqual(gs2.map((x) => x.key), ["AS64500", "AS64510"]);
  const c2 = G.collapse(g2, gs2, new Set(gs2.map((x) => x.id)));
  assert.deepEqual(c2.nodes.filter((n) => "group" in n).map((n) => n.traversed), [3, 3]);
  // segments: own network (private) · the way · destination; IP = no groups
  const g = G.buildGraph([r], { hideUnknown: true });
  assert.deepEqual(G.groupsOf(g, "segment").map((x) => x.key), ["transit"]);
  assert.deepEqual(G.groupsOf(g, "ip"), []);
});

test("layout · search · health bar · previous range · routes · comparison · labels", () => {
  const runs = [run("r1", "2026-11-19T01:00:00Z"), run("r2", "2026-11-19T01:05:00Z", { e2e: { protocol: "tcp", port: 443, rtt: [-1, -1] } }), run("r3", "2026-11-19T01:10:00Z")];
  const g = G.buildGraph(runs, { hideUnknown: true });
  const pos = G.layoutPath(g.nodes);
  assert.equal(pos.get(G.SOURCE_ID)!.col, 0);
  assert.equal(pos.get(G.DEST_ID)!.col, Math.max(...[...pos.values()].map((p) => p.col)), "the destination is the last column");
  assert.equal(pos.get(`4|${A.e1}`)!.y, -pos.get(`4|${A.e2}`)!.y, "two in a column sit around the middle");
  assert.ok(Math.abs(pos.get(`4|${A.e1}`)!.y) > 0);
  assert.deepEqual([...G.matchHops(g.nodes, "198.51.100.2")!].sort(), [`4|${A.e1}`, `4|${A.e2}`].sort());
  assert.equal(G.matchHops(g.nodes, " "), null);
  const pts = G.runPoints(runs);
  assert.deepEqual(pts.map((p) => [p.id, p.reachable, G.pointLevel(p)]), [["r1", true, "warn"], ["r2", false, "danger"], ["r3", true, "warn"]], "r1/r3 lost one of five TCP probes");
  assert.deepEqual(pts.map((p) => p.hops), [7, 7, 7], "hop count = the TTL the destination answered at");
  assert.deepEqual(G.previousRange(pts, pts[2]!.at, pts[2]!.at), ["r2"], "one run picked → the run before");
  assert.deepEqual(G.previousRange(pts, pts[1]!.at, pts[2]!.at), ["r1"], "a range → the same length before it");
  assert.deepEqual(G.previousRange(pts, pts[0]!.at, pts[2]!.at), []);
  assert.equal(G.routesOf(runs), 2, "via e1 or via e2");
  const before = G.buildGraph([run("b", "2026-11-19T00:55:00Z", { passes: [{ hops: pass(A.e1) }] })], { hideUnknown: true });
  const rows = G.compareHops(g, before);
  assert.deepEqual(rows.filter((x) => x.only).map((x) => [x.ip, x.only]), [[A.e2, "a"]]);
  assert.ok(rows.find((x) => x.ip === A.dst)!.deltaMs !== null);
  assert.deepEqual([G.edgeLabel({ addedMs: null }), G.edgeLabel({ addedMs: -3 }), G.edgeLabel({ addedMs: 0.4 }), G.edgeLabel({ addedMs: 4.25 }), G.edgeLabel({ addedMs: 63.4 })], [null, "<1 ms", "<1 ms", "4.3 ms", "63 ms"]);
  assert.deepEqual(["Wireless80211", "Ethernet", "GigabitEthernet", "Ppp", "Wwanpp", "Loopback", undefined].map(G.linkKind), ["wifi", "ethernet", "ethernet", "vpn", "cellular", "other", null]);
});

test("pooled end-to-end: loss and latency over every probe, jitter only within a run (never across two runs)", () => {
  const a = run("a", "2026-11-19T01:00:00Z", { e2e: { protocol: "tcp", port: 443, rtt: [10, 12] } });
  const b = run("b", "2026-11-19T01:05:00Z", { e2e: { protocol: "tcp", port: 443, rtt: [50, 54, -1] } });
  const m = G.mergedE2e([a, b])!;
  assert.deepEqual([m.sent, m.received, m.lossPct, m.rttAvg, m.jitter, m.runs], [5, 4, 20, 31.5, 3, 2], "jitter = (|12−10| + |54−50|) / 2, not |50−12|");
  // per-TTL merge = the input of the latency profile: answers over all probes
  const hops = G.mergedHops([a, b]);
  assert.equal(hops.find((x) => x.ttl === 4)!.sent, 6);
  assert.equal(V.pathView({ hops, reached: true, targetIp: A.dst }).end.hops, 7);
});

test("the probe keeps Datadog's defaults and the page's commands use its parameters", () => {
  const ps = readFileSync(new URL("../../../scripts/netpath-probe.ps1", import.meta.url), "utf8");
  for (const [name, value] of [["Queries", "3"], ["MaxHops", "30"], ["TimeoutMs", "1000"], ["Port", "443"], ["E2eProtocol", "'tcp'"]]) {
    assert.match(ps, new RegExp(`\\$${name} = ${value}`), name);
  }
  assert.match(ps, /\[switch\]\$Lookup/);
  assert.doesNotMatch(ps, /\$Lookup = \$true/, "lookup is opt-in");
  for (const cmd of [V.probeCommand("x.example.com"), V.probeRepeatCommand("x.example.com"), V.probeLookupCommand("x.example.com")]) {
    for (const p of cmd.split(".ps1\"")[1]!.matchAll(/ -([A-Z][A-Za-z]+)/g)) assert.match(ps, new RegExp(`\\$${p[1]}\\b`), `${p[1]} in the script`);
  }
  // nothing but ASCII (Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page)
  assert.ok([...ps].every((c) => c.charCodeAt(0) < 128));
});

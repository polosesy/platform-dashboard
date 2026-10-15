import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, DiagramSpec, LivePeering } from "@aud/types";
import { generateDiagramSpec, NODE_BINDINGS } from "../src/services/specGenerator.js";
// Web pure modules (tsx resolves the .ts sources; same pattern as liveLayout.test.ts)
import * as peeringNs from "../../web/src/lib/livePeering.ts";
import * as hybridNs from "../../web/src/lib/liveHybrid.ts";
import * as layoutNs from "../../web/src/lib/liveLayout.ts";
import * as styleNs from "../../web/src/lib/liveStyle.ts";
import * as scopeNs from "../../web/src/lib/liveScope.ts";

const P = ((peeringNs as unknown as { default?: typeof peeringNs }).default ?? peeringNs) as typeof peeringNs;
const H = ((hybridNs as unknown as { default?: typeof hybridNs }).default ?? hybridNs) as typeof hybridNs;
const L = ((layoutNs as unknown as { default?: typeof layoutNs }).default ?? layoutNs) as typeof layoutNs;
const St = ((styleNs as unknown as { default?: typeof styleNs }).default ?? styleNs) as typeof styleNs;
const Sc = ((scopeNs as unknown as { default?: typeof scopeNs }).default ?? scopeNs) as typeof scopeNs;

// ── synthetic hub & spoke (fake IDs only) ──
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers";
const OTHER = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-x/providers";
const id = (type: string, name: string, sub = SUB) => `${sub}/${type}/${name}`.toLowerCase();
const n = (kind: ArchitectureNode["kind"], azureId: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({
  id: azureId, kind, name: azureId.split("/").pop()!, azureId, location: "koreacentral", resourceGroup: "rg", ...extra,
});
const e = (kind: ArchitectureEdge["kind"], source: string, target: string, metadata?: ArchitectureEdge["metadata"]): ArchitectureEdge => ({ id: `${kind}:${source}->${target}`, kind, source, target, metadata });

const HUB = id("microsoft.network/virtualnetworks", "vnet-hub");
const SPOKE = id("microsoft.network/virtualnetworks", "vnet-spoke");
const FAR = id("microsoft.network/virtualnetworks", "vnet-spoke", OTHER); // same name, another subscription, not in the graph
const GW = id("microsoft.network/virtualnetworkgateways", "vgw-hub");
const CONN = id("microsoft.network/connections", "cn-branch");
const LNG = id("microsoft.network/localnetworkgateways", "lng-branch");

const side = (name: string, remoteId: string, extra: Record<string, unknown> = {}) => ({
  name, remoteId, remoteName: remoteId.split("/").pop(), state: "Connected", sync: "FullyInSync", provisioning: "Succeeded",
  access: true, forwarded: false, gatewayTransit: false, useRemoteGateways: false, remoteSpace: ["10.1.0.0/16"], ...extra,
});

function graph(): ArchitectureGraph {
  return {
    nodes: [
      n("vnet", HUB, {
        endpoint: "10.0.0.0/16",
        metadata: {
          vnetPeerings: [
            side("hub-to-spoke", SPOKE, { gatewayTransit: true }),
            side("hub-to-far", FAR, { remoteSpace: ["10.9.0.0/16"] }),
            side("hub-to-old", id("microsoft.network/virtualnetworks", "vnet-gone"), { state: "Initiated", access: null, forwarded: null, gatewayTransit: null, useRemoteGateways: null, remoteSpace: [] }),
          ],
        },
      }),
      n("vnet", SPOKE, { endpoint: "10.1.0.0/16", metadata: { vnetPeerings: [side("spoke-to-hub", HUB, { useRemoteGateways: true, remoteSpace: ["10.0.0.0/16"] })] } }),
      n("subnet", `${HUB}/subnets/gatewaysubnet`, { endpoint: "10.0.255.0/27" }),
      n("subnet", `${SPOKE}/subnets/snet-app`, { endpoint: "10.1.1.0/24" }),
      n("vnetGateway", GW, {
        metadata: {
          sku: "VpnGw1", activeActive: false, enableBgp: false,
          s2s: [{
            connectionId: CONN, name: "cn-branch", type: "IPsec", status: "Connected", protocol: "IKEv2", enableBgp: false, policyBased: false,
            connectionMode: "Default", dpd: 45, ingressBytes: 2048, egressBytes: 4096, tunnels: null, nat: false,
            lng: { id: LNG, name: "lng-branch", prefixes: ["192.168.10.0/24"], peerIp: "203.0.113.10", fqdn: null, bgp: false },
          }],
        },
      }),
    ],
    edges: [
      e("contains", HUB, `${HUB}/subnets/gatewaysubnet`), e("contains", SPOKE, `${SPOKE}/subnets/snet-app`),
      e("attached-to", `${HUB}/subnets/gatewaysubnet`, GW),
      e("peering", HUB, SPOKE, { peeringState: "Connected", stateA: "Connected", stateB: "Connected" }),
    ],
  } as unknown as ArchitectureGraph;
}

async function spec(): Promise<DiagramSpec> {
  return (await generateDiagramSpec(graph(), "00000000-0000-0000-0000-000000000000", "manual")).spec;
}
const peersOf = (s: DiagramSpec, label: string) => P.parsePeerings(s.nodes.find((x) => x.label === label)?.metadata?.peerings);

test("spec: each VNet keeps every peering by link name — same-name peers stay apart, an outside peer has no id and no ARM id", async () => {
  const s = await spec();
  const hub = peersOf(s, "vnet-hub");
  assert.deepEqual(hub.map((p) => p.key).sort(), ["hub-to-far", "hub-to-old", "hub-to-spoke"]);
  const near = hub.find((p) => p.key === "hub-to-spoke")!;
  const far = hub.find((p) => p.key === "hub-to-far")!;
  assert.equal(near.name, far.name, "both peers are called vnet-spoke");
  assert.ok(near.id, "the peer on the diagram has its node id");
  assert.equal(far.id, null, "a VNet outside the graph has no node to open");
  const raw = s.nodes.find((x) => x.label === "vnet-hub")!.metadata!.peerings!;
  assert.ok(!raw.includes("/subscriptions/"), "no remote ARM id reaches the web");
  // unknown flags stay unknown — never guessed false
  const old = hub.find((p) => p.key === "hub-to-old")!;
  assert.equal(old.access, null);
  assert.equal(old.gatewayTransit, null);
});

test("spec: gateway transit only when both sides agree and both are Connected; the other side is attached", async () => {
  const s = await spec();
  const near = peersOf(s, "vnet-hub").find((p) => p.key === "hub-to-spoke")!;
  assert.equal(near.transit, "provides");
  assert.equal(near.other?.useRemoteGateways, true);
  const back = peersOf(s, "vnet-spoke")[0]!;
  assert.equal(back.transit, "uses");
  assert.equal(peersOf(s, "vnet-hub").find((p) => p.key === "hub-to-far")!.other, undefined, "no other side to compare");

  // one side's flag alone decides nothing
  const g = graph();
  const sp = g.nodes.find((x) => x.id === SPOKE)!;
  sp.metadata = { vnetPeerings: [side("spoke-to-hub", HUB, { useRemoteGateways: true, state: "Initiated" })] };
  const s2 = (await generateDiagramSpec(g, "00000000-0000-0000-0000-000000000000", "manual")).spec;
  assert.equal(peersOf(s2, "vnet-hub").find((p) => p.key === "hub-to-spoke")!.transit, null);
});

test("spec: an S2S connection becomes an on-premises site card (resource = the connection) with a hybrid line from the gateway", async () => {
  const s = await spec();
  const gw = s.nodes.find((x) => x.label === "vgw-hub")!;
  const site = s.nodes.find((x) => x.resourceKind === "onPremSite")!;
  assert.ok(site, "one site per connection");
  assert.equal(site.label, "lng-branch");
  assert.equal(site.azureResourceId, CONN, "Resource Health and BitsIn/Out are read on the connection");
  assert.equal(site.metadata?.gatewayNodeId, gw.id);
  assert.deepEqual(JSON.parse(site.metadata!.lng!).prefixes, ["192.168.10.0/24"]);
  assert.equal(gw.metadata?.s2sCount, "1");
  assert.equal(gw.metadata?.sku, "VpnGw1");
  const line = s.edges.find((x) => x.edgeKind === "hybrid")!;
  assert.deepEqual([line.source, line.target], [gw.id, site.id]);
  // the API reads these for the kinds (CARD_CELLS checks the card side)
  assert.ok(NODE_BINDINGS.onPremSite?.bitsIn && NODE_BINDINGS.onPremSite?.bitsOut);
  assert.equal(Sc.edgeLayer(line), "hybrid");
  assert.equal(St.liveEdgeStyleKey(line), "hybrid");
  assert.deepEqual(St.relationLabel(line, new Map(s.nodes.map((x) => [x.id, x]))), { key: "ld.rel.s2s", vars: { proto: "IKEv2" } });
});

// VNet ↔ VNet is not a line in a generated spec (the header's peering row is the interaction); a diagram that does
// draw one (the sample) gets these looks
const peeringLine = (s: DiagramSpec) => ({
  id: "peer-line", source: s.nodes.find((x) => x.label === "vnet-hub")!.id, target: s.nodes.find((x) => x.label === "vnet-spoke")!.id,
  edgeKind: "peering" as const, peeringState: "Connected", peeringTransit: true, bindings: {},
});

test("a peering line: transit label; not Connected is grey, never red or dashed", async () => {
  const s = await spec();
  assert.ok(!s.edges.some((x) => x.edgeKind === "peering"), "peerings are the VNet header's row, not lines between boxes");
  const byId = new Map(s.nodes.map((x) => [x.id, x]));
  const line = peeringLine(s);
  assert.equal(St.relationLabel(line, byId)?.key, "ld.rel.peeringTransit");
  const off = { ...line, peeringState: "Disconnected" };
  assert.equal(St.liveEdgeStyleKey(off), "peeringInactive");
  assert.equal(St.relationLabel(off, byId)?.key, "ld.rel.peeringInactive");
  const look = St.LIVE_EDGE_LOOK.peeringInactive;
  assert.ok(!("dash" in look) || !look.dash, "not dashed: a configuration fact, not weak evidence");
});

// ── web: what needs attention, order, how many chips fit ──
const peer = (key: string, extra: Partial<LivePeering> = {}): LivePeering => ({
  key, link: key, id: `n-${key}`, name: key, state: "Connected", sync: "FullyInSync", provisioning: "Succeeded",
  access: true, forwarded: false, gatewayTransit: false, useRemoteGateways: false, remoteSpace: ["10.1.0.0/16"],
  remoteCurrentSpace: null, complete: true, transit: null, ...extra,
});

test("peeringIssue: warn for not Connected / out of sync / half transit, neutral for access off, unknown stays unknown", () => {
  assert.deepEqual(P.peeringIssue(peer("a")), { tone: "ok", reasons: [] });
  assert.deepEqual(P.peeringIssue(peer("a", { state: "Initiated" })).reasons, ["ld.peering.state.Initiated"]);
  assert.equal(P.peeringIssue(peer("a", { sync: "RemoteNotInSync" })).tone, "warn");
  assert.deepEqual(P.peeringIssue(peer("a", { remoteCurrentSpace: ["10.1.0.0/16", "10.2.0.0/16"] })).reasons, ["ld.peering.syncNeeded"]);
  assert.equal(P.peeringIssue(peer("a", { remoteCurrentSpace: ["10.1.0.0/16"] })).tone, "ok", "same set = in sync");
  assert.deepEqual(P.peeringIssue(peer("a", { useRemoteGateways: true, other: { state: "Connected", sync: null, access: true, forwarded: false, gatewayTransit: false, useRemoteGateways: false } })).reasons, ["ld.peering.transitHalf"]);
  assert.equal(P.peeringIssue(peer("a", { useRemoteGateways: true })).tone, "ok", "the other side unseen: not called half");
  assert.equal(P.peeringIssue(peer("a", { access: false })).tone, "neutral");
  assert.equal(P.peeringIssue(peer("a", { state: "Unknown" })).tone, "unknown");
});

test("sortPeerings: problems, then transit, then on the diagram, then name — deterministic", () => {
  const list = [peer("d"), peer("c", { id: null }), peer("b", { transit: "provides" }), peer("a", { state: "Disconnected" }), peer("e", { state: "Unknown" })];
  assert.deepEqual(P.sortPeerings(list).map((p) => p.key), ["a", "e", "b", "d", "c"]);
  assert.deepEqual(P.sortPeerings([...list].reverse()).map((p) => p.key), ["a", "e", "b", "d", "c"]);
});

test("peeringChipFit: ten peerings on a normal VNet width leave room for the summary and '+n' — the row never overflows", () => {
  const { SUMMARY_W, NAME_W, MORE_W, GAP, PAD } = P.PEER_CHIP;
  for (const w of [300, 560, 900, 1400]) {
    const fit = P.peeringChipFit(w, 10);
    const used = 2 * PAD + SUMMARY_W + fit * (NAME_W + GAP) + (fit < 10 ? GAP + MORE_W : 0);
    assert.ok(used <= w + GAP, `width ${w}: ${fit} chips use ${used}px`);
  }
  assert.equal(P.peeringChipFit(2000, 3), 3, "all fit — no '+n'");
  assert.equal(P.peeringChipFit(100, 4), 0);
  assert.equal(P.peeringChipFit(800, 0), 0);
  assert.deepEqual(P.peeringSummary([peer("a", { state: "Initiated" }), peer("b", { transit: "uses" }), peer("c")]), { n: 3, problems: 1, provides: 0, uses: 1 });
});

test("peeringPairOf / siteOfEdge: the panel compares both sides from the diagram; a missing side is null, not guessed", async () => {
  const s = await spec();
  const line = peeringLine(s);
  const pair = P.peeringPairOf(s, line)!;
  assert.deepEqual([pair.a.label, pair.b.label], ["vnet-hub", "vnet-spoke"]);
  assert.equal(pair.a.peering?.key, "hub-to-spoke");
  assert.equal(pair.b.peering?.key, "spoke-to-hub");
  const spokeLess = { ...s, nodes: s.nodes.map((x) => (x.label === "vnet-spoke" ? { ...x, metadata: { ...x.metadata, peerings: "[]" } } : x)) };
  assert.equal(P.peeringPairOf(spokeLess, line)!.b.peering, null);
  assert.equal(P.peeringPairOf(s, s.edges.find((x) => x.edgeKind === "hybrid")), null);
  const site = P.siteOfEdge(s, s.edges.find((x) => x.edgeKind === "hybrid"))!;
  assert.equal(site.resourceKind, "onPremSite");
  assert.deepEqual(H.hybridFacts("onPremSite", site.metadata), { kind: "site", prefixes: 1, bgp: false, nat: false, status: "Connected" });
  assert.deepEqual(H.hybridFacts("vnetGateway", s.nodes.find((x) => x.label === "vgw-hub")!.metadata), { kind: "gateway", s2s: 1, sku: "VpnGw1", activeActive: false, bgp: false });
});

test("layout: the VNet with the most peerings comes first, its header grows by one peering row, sites go to the on-premises lane", async () => {
  const s = await spec();
  const out = L.liveLayout(s);
  const all = new Map([...out.items, ...out.lanes.map((l) => [l.id, l] as const)]);
  const abs = (id: string): { x: number; y: number } => {
    const b = all.get(id)!;
    const p = b.parent ? abs(b.parent) : { x: 0, y: 0 };
    return { x: p.x + b.x, y: p.y + b.y };
  };
  const nid = (label: string) => s.nodes.find((x) => x.label === label)!.id;
  const hub = abs(nid("vnet-hub"));
  const spoke = abs(nid("vnet-spoke"));
  assert.ok(hub.x < spoke.x || (hub.x === spoke.x && hub.y < spoke.y), "hub before its spokes");
  assert.ok(L.hasPeerings(s.nodes.find((x) => x.label === "vnet-hub")!));
  const site = s.nodes.find((x) => x.resourceKind === "onPremSite")!;
  const lane = out.lanes.find((l) => l.lane === "onprem");
  assert.ok(lane, "an on-premises lane");
  assert.equal(lane!.label, "ld.lane.onprem");
  assert.equal(out.items.get(site.id)!.parent, lane!.id);
  assert.ok(abs(site.id).x < hub.x, "on the left, next to the inbound side");
});

test("layout: the on-premises lane stays below the inbound lane after the inbound cards are re-stacked (no overlap)", async () => {
  const s = await spec();
  const gw = s.nodes.find((x) => x.label === "vgw-hub")!;
  const extra = [
    { id: "internet-in-x", label: "Internet", icon: "internet", resourceKind: "internet", bindings: {}, metadata: { direction: "ingress" } },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `fd-${i}`, label: `fd-${i}`, icon: "frontDoor", resourceKind: "frontDoor", bindings: {} })),
  ] as DiagramSpec["nodes"];
  const edges = [
    ...s.edges,
    ...extra.slice(1).map((n) => ({ id: `in-${n.id}`, source: "internet-in-x", target: n.id, edgeKind: "network" as const, flowType: "ingress" as const, bindings: {} })),
    ...extra.slice(1).map((n) => ({ id: `o-${n.id}`, source: n.id, target: gw.id, edgeKind: "network" as const, bindings: {} })),
  ];
  const out = L.liveLayout({ ...s, nodes: [...s.nodes, ...extra], edges });
  const inbound = out.lanes.find((l) => l.lane === "ingress")!;
  const onprem = out.lanes.find((l) => l.lane === "onprem")!;
  assert.ok(inbound && onprem);
  // both lanes are top-level (absolute) boxes
  assert.equal(inbound.parent, null);
  assert.equal(onprem.parent, null);
  assert.ok(onprem.y >= inbound.y + inbound.h + 24, `on-prem top ${onprem.y} vs inbound bottom ${inbound.y + inbound.h}`);
  const site = out.items.get(s.nodes.find((x) => x.resourceKind === "onPremSite")!.id)!;
  assert.ok(site.y >= 0 && site.y + site.h <= onprem.h, "the site card stays inside its lane");
});

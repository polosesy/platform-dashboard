import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec } from "@aud/types";
import { activeRoutes, resolveAfdWaf, wafPolicyFacts, type AfdConfig, type WafPolicyFacts } from "../src/services/frontDoorConfig.js";
import { edgeBindings, NODE_BINDINGS } from "../src/services/specGenerator.js";
import * as wafNs from "../../web/src/lib/liveWaf.ts";
import * as scopeNs from "../../web/src/lib/liveScope.ts";

const W = ((wafNs as unknown as { default?: typeof wafNs }).default ?? wafNs) as typeof wafNs;
const Sc = ((scopeNs as unknown as { default?: typeof scopeNs }).default ?? scopeNs) as typeof scopeNs;

// ── synthetic profile (fake ids only) ──
const P = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.cdn/profiles/fd-x";
const POL = (n: string) => `/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.network/frontdoorwebapplicationfirewallpolicies/${n}`;
const CD = (n: string) => `${P}/customdomains/${n}`;
const EP = (n: string) => `${P}/afdendpoints/${n}`;

function cfg(extra: Partial<AfdConfig> = {}): AfdConfig {
  return {
    endpoints: [{ name: "ep1", hostName: "ep1.example.net", enabled: true }, { name: "ep-off", hostName: "off.example.net", enabled: false }],
    routes: [
      { endpoint: "ep1", name: "r1", originGroup: "g1", enabled: true, customDomains: [CD("www"), CD("api")], linkToDefaultDomain: true },
      { endpoint: "ep1", name: "r2", originGroup: "g2", enabled: true, customDomains: [CD("shop")], linkToDefaultDomain: false },
      { endpoint: "ep1", name: "r3", originGroup: "g3", enabled: false, customDomains: [CD("old")] },
      { endpoint: "ep-off", name: "r4", originGroup: "g4", enabled: true, customDomains: [CD("parked")] },
    ],
    origins: [],
    customDomainHosts: { [CD("www")]: "www.example.com", [CD("api")]: "api.example.com", [CD("shop")]: "shop.example.com" },
    securityPolicies: [
      { wafPolicyId: POL("prevent"), domains: [CD("www"), EP("ep1")], patterns: ["/*"] },
      { wafPolicyId: POL("detect"), domains: [CD("api"), CD("unused")], patterns: ["/*"] },
    ],
    ...extra,
  };
}
const policy = (name: string, mode: string, extra: Partial<WafPolicyFacts> = {}): WafPolicyFacts =>
  ({ name, sku: "Premium_AzureFrontDoor", mode, enabled: true, managed: [{ type: "Microsoft_DefaultRuleSet", version: "2.1", action: "Block" }], customRules: 2, ...extra });
const wafs = () => new Map([[POL("prevent"), policy("prevent", "Prevention")], [POL("detect"), policy("detect", "Detection")]]);

test("served domains: active routes on enabled endpoints only, the endpoint domain unless the route unlinked it", () => {
  assert.deepEqual(activeRoutes(cfg()).map((r) => r.name), ["r1", "r2"], "disabled route and the route of a disabled endpoint take no traffic");
  const w = resolveAfdWaf(P, cfg(), wafs());
  assert.equal(w.counts.served, 4, "ep1 + www + api + shop");
  assert.deepEqual(w.domains.map((d) => [d.host, d.state]).sort(), [
    ["api.example.com", "detect"], ["ep1.example.net", "prevent"], ["shop.example.com", "none"], ["www.example.com", "prevent"],
  ]);
  assert.equal(w.state, "partial");
  assert.deepEqual(w.unserved, ["unused"], "associated with a WAF, served by no route: listed, not counted");
  assert.deepEqual(w.policies.map((p) => [p.name, p.domains]), [["detect", ["api.example.com"]], ["prevent", ["ep1.example.net", "www.example.com"]]]);
});

test("profile state: all prevent / all detect / all none; unknown never becomes none", () => {
  const prevAll = cfg({ securityPolicies: [{ wafPolicyId: POL("prevent"), domains: [CD("www"), CD("api"), CD("shop"), EP("ep1")], patterns: ["/*"] }] });
  assert.equal(resolveAfdWaf(P, prevAll, wafs()).state, "prevent");
  const detAll = cfg({ securityPolicies: [{ wafPolicyId: POL("detect"), domains: [CD("www"), CD("api"), CD("shop"), EP("ep1")], patterns: ["/*"] }] });
  assert.equal(resolveAfdWaf(P, detAll, wafs()).state, "detect");
  assert.equal(resolveAfdWaf(P, cfg({ securityPolicies: [] }), wafs()).state, "none");
  // security policies unreadable → unreadable, every domain unknown
  const unread = resolveAfdWaf(P, cfg({ securityPolicies: null }), wafs());
  assert.equal(unread.state, "unreadable");
  assert.equal(unread.counts.none, 0);
  assert.equal(unread.counts.unknown, 4);
  assert.equal(unread.readError, "securityPolicies");
  // WAF policies not in Resource Graph (other subscription / no access) → those domains unknown
  const noRg = resolveAfdWaf(P, prevAll, null);
  assert.equal(noRg.state, "unknown");
  assert.equal(noRg.readError, "wafPolicies");
  assert.ok(noRg.domains.every((d) => d.state === "unknown" && d.reason === "policyUnreadable"));
  // only prevent + unknown → unknown (not partial: nothing known fails to block)
  const half = new Map([[POL("prevent"), policy("prevent", "Prevention")]]);
  assert.equal(resolveAfdWaf(P, cfg({ securityPolicies: [{ wafPolicyId: POL("prevent"), domains: [CD("www"), CD("shop"), EP("ep1")], patterns: ["/*"] }, { wafPolicyId: POL("gone"), domains: [CD("api")], patterns: ["/*"] }] }), half).state, "unknown");
  assert.equal(resolveAfdWaf(P, cfg({ routes: [] }), wafs()).state, "noDomains");
});

test("disabled policy, path-scoped association and a domain in two policies are named, not guessed", () => {
  const sp = [
    { wafPolicyId: POL("off"), domains: [CD("www")], patterns: ["/*"] },
    { wafPolicyId: POL("prevent"), domains: [CD("api"), CD("shop")], patterns: ["/api/*"] },
    { wafPolicyId: POL("detect"), domains: [EP("ep1"), CD("shop")], patterns: ["/*"] },
  ];
  const m = new Map([...wafs(), [POL("off"), policy("off", "Prevention", { enabled: false })]]);
  const w = resolveAfdWaf(P, cfg({ securityPolicies: sp }), m);
  const st = Object.fromEntries(w.domains.map((d) => [d.host, [d.state, d.reason ?? ""]]));
  assert.deepEqual(st["www.example.com"], ["disabled", ""]);
  assert.deepEqual(st["api.example.com"], ["unknown", "pathScoped"]);
  assert.deepEqual(st["shop.example.com"], ["unknown", "conflict"]);
  assert.deepEqual(st["ep1.example.net"], ["detect", ""]);
  assert.equal(w.state, "partial");
});

test("WAF policy rows: Standard has no managed sets (custom only), an absent array stays null, enabled state read", () => {
  const std = wafPolicyFacts({ name: "p", sku: { name: "Standard_AzureFrontDoor" }, properties: { policySettings: { mode: "Prevention", enabledState: "Enabled" }, customRules: { rules: [1, 2, 3] } } });
  assert.deepEqual(std, { name: "p", sku: "Standard_AzureFrontDoor", mode: "Prevention", enabled: true, managed: null, customRules: 3 });
  const prem = wafPolicyFacts({ name: "q", sku: { name: "Premium_AzureFrontDoor" }, properties: { policySettings: { mode: "Detection", enabledState: "Disabled" }, managedRules: { managedRuleSets: [{ ruleSetType: "Microsoft_DefaultRuleSet", ruleSetVersion: "2.1", ruleSetAction: "Log" }] } } });
  assert.equal(prem.enabled, false);
  assert.deepEqual(prem.managed, [{ type: "Microsoft_DefaultRuleSet", version: "2.1", action: "Log" }]);
});

test("card chip: prevention neutral, gaps orange with n/m, unknown never orange, no chip without a served domain", () => {
  const meta = (state: string, counts: Partial<wafNs.WafCounts> = {}) => ({ wafState: state, wafCounts: JSON.stringify({ served: 7, prevent: 0, detect: 0, disabled: 0, none: 0, unknown: 0, ...counts }) });
  assert.deepEqual(W.wafChip(meta("prevent", { prevent: 7 }))?.tone, undefined);
  assert.equal(W.wafChip(meta("prevent", { prevent: 7 }))?.key, "ld.chip.waf.prevent");
  const partial = W.wafChip(meta("partial", { prevent: 3, detect: 4 }))!;
  assert.deepEqual([partial.key, partial.vars, partial.tone], ["ld.chip.waf.ratio", { n: 3, m: 7 }, "public"]);
  assert.equal(W.wafChip(meta("detect", { detect: 7 }))?.tone, "public");
  assert.equal(W.wafChip(meta("none", { none: 7 }))?.tone, "public");
  for (const s of ["unknown", "unreadable"]) assert.notEqual(W.wafChip(meta(s, { unknown: 7 }))?.tone, "public", `${s} is not risk`);
  assert.equal(W.wafChip(meta("noDomains", { served: 0 })), null);
  assert.equal(W.wafChip({}), null);
  assert.equal(W.wafChip({ wafState: "bogus" }), null);
});

test("WAF verdict counts are read for the panel only — never a health rule (no baseline: attack or false positives)", () => {
  const b = NODE_BINDINGS.frontDoorAfd!;
  assert.equal(b.wafBlock?.filter, "Action eq 'Block'");
  assert.equal(b.wafBlock?.window, "PT1H");
  assert.ok(b.wafTotal && !b.wafTotal.filter);
  assert.ok(!(b.health?.rules ?? []).some((r) => r.metric.startsWith("waf")));
});

// ── Internet → Front Door in a one-VNet view ──
const node = (id: string, extra: Partial<DiagramNodeSpec> = {}): DiagramNodeSpec => ({ id, label: id, icon: "vm", bindings: {}, ...extra });
const edge = (id: string, source: string, target: string, extra: Partial<DiagramEdgeSpec> = {}): DiagramEdgeSpec => ({ id, source, target, bindings: {}, ...extra });
const inet = (id: string) => node(id, { icon: "internet", resourceKind: "internet", metadata: { direction: "ingress", entryCount: "9" } });
function afdSpec(): DiagramSpec {
  return {
    id: "t", name: "t",
    nodes: [
      node("vnet-a", { icon: "vnet", nodeType: "group", resourceKind: "vnet" }),
      node("snet-a", { icon: "subnet", nodeType: "group", resourceKind: "subnet", parentId: "vnet-a" }),
      node("agw", { icon: "appGateway", resourceKind: "appGateway", parentId: "snet-a" }),
      node("vnet-b", { icon: "vnet", nodeType: "group", resourceKind: "vnet" }),
      node("snet-b", { icon: "subnet", nodeType: "group", resourceKind: "subnet", parentId: "vnet-b" }),
      node("lbi", { icon: "lb", resourceKind: "lb", parentId: "snet-b" }),
      inet("internet-in-vnet-a"), inet("internet-in-external"),
      node("afd", { icon: "frontDoor", resourceKind: "frontDoor" }),
      node("afd2", { icon: "frontDoor", resourceKind: "frontDoor" }),
    ],
    edges: [
      edge("in-agw", "internet-in-vnet-a", "agw", { flowType: "ingress", edgeKind: "network" }),
      edge("in-afd", "internet-in-external", "afd", { flowType: "ingress", edgeKind: "network" }),
      edge("in-afd2", "internet-in-external", "afd2", { flowType: "ingress", edgeKind: "network" }),
      edge("afd-agw", "afd", "agw", { edgeKind: "network", origin: { name: "o1", group: "g", evidence: "ipMatch" } }),
      edge("afd2-lbi", "afd2", "lbi", { edgeKind: "privateLink", origin: { name: "o2", group: "g", evidence: "cfg" } }),
    ],
  } as DiagramSpec;
}

test("scope: Front Door in view keeps its Internet side — re-pointed to the one Internet card, same edge id", () => {
  const s = Sc.scopeSpec(afdSpec(), new Set(["vnet-a"]));
  const inets = s.nodes.filter((n) => n.resourceKind === "internet");
  assert.deepEqual(inets.map((n) => n.id), ["internet-in-vnet-a"], "one Internet card");
  const e = s.edges.find((x) => x.id === "in-afd")!;
  assert.equal(e.source, "internet-in-vnet-a");
  assert.ok(s.edges.some((x) => x.id === "in-agw"), "the gateway's own inbound line stays");
  assert.equal(inets[0]!.metadata?.entryCount, "2", "lines drawn in this view, not the subscription's 9");
  assert.ok(!s.edges.some((x) => x.id === "in-afd2"), "a Front Door not in view brings nothing");
});

test("scope: no Internet card of its own → the external one comes in; several VNets → no choosing, the external one", () => {
  const b = Sc.scopeSpec(afdSpec(), new Set(["vnet-b"]));
  assert.deepEqual(b.nodes.filter((n) => n.resourceKind === "internet").map((n) => n.id), ["internet-in-external"]);
  assert.equal(b.edges.find((x) => x.id === "in-afd2")?.source, "internet-in-external");
  // one Internet card in view (only vnet-a has a public entry): the Internet is one network — re-pointed
  assert.equal(Sc.scopeSpec(afdSpec(), new Set(["vnet-a", "vnet-b"])).edges.find((x) => x.id === "in-afd2")?.source, "internet-in-vnet-a");
  // each VNet with its own Internet card: no choosing between them
  const two = () => {
    const s = afdSpec();
    return { ...s, nodes: [...s.nodes, inet("internet-in-vnet-b")], edges: [...s.edges, edge("in-lbi", "internet-in-vnet-b", "lbi", { flowType: "ingress", edgeKind: "network" })] };
  };
  const ab = Sc.scopeSpec(two(), new Set(["vnet-a", "vnet-b"]));
  assert.deepEqual(ab.nodes.filter((n) => n.resourceKind === "internet").map((n) => n.id).sort(), ["internet-in-external", "internet-in-vnet-a", "internet-in-vnet-b"]);
  assert.equal(ab.edges.find((x) => x.id === "in-afd")?.source, "internet-in-external");
  // deterministic under another edge order
  const shuffled = { ...two(), edges: [...two().edges].reverse() };
  const again = Sc.scopeSpec(shuffled, new Set(["vnet-a", "vnet-b"]));
  assert.deepEqual(again.nodes.map((n) => n.id).sort(), ab.nodes.map((n) => n.id).sort());
  // nothing selected: the same spec
  const full = afdSpec();
  assert.equal(Sc.scopeSpec(full, new Set()), full);
});

test("Internet → App Gateway that is also a Front Door origin: the line stays, with the 'may include Front Door' caveat", () => {
  const s = afdSpec();
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const line = s.edges.find((e) => e.id === "in-agw")!;
  assert.ok(edgeBindings(line, byId, new Set(), new Set(["agw"])).caveats?.includes("ld.edge.caveat.viaFrontDoor"));
  assert.ok(!(edgeBindings(line, byId, new Set(), new Set()).caveats ?? []).includes("ld.edge.caveat.viaFrontDoor"));
  const toAfd = s.edges.find((e) => e.id === "in-afd")!;
  assert.ok(!(edgeBindings(toAfd, byId, new Set(), new Set(["afd"])).caveats ?? []).includes("ld.edge.caveat.viaFrontDoor"), "only gateways");
});

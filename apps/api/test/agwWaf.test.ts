import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgwWaf } from "../src/services/agwWaf.js";
import type { WafPolicyFacts } from "../src/services/wafCoverage.js";

// ── synthetic gateway (fake ids only) ──
const GW = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.network/applicationgateways/agw-x";
const POL = (n: string) => `/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.network/applicationgatewaywebapplicationfirewallpolicies/${n}`;
const ref = (kind: string, name: string) => ({ id: `${GW}/${kind}/${name}` });
const listener = (name: string, fe: "pub" | "priv", policy?: string) => ({ name, properties: { frontendIPConfiguration: ref("frontendIPConfigurations", fe), ...(policy ? { firewallPolicy: { id: POL(policy) } } : {}) } });
const rule = (name: string, l: string, pathMap?: string) => ({ name, properties: { httpListener: ref("httpListeners", l), ...(pathMap ? { urlPathMap: ref("urlPathMaps", pathMap) } : {}) } });

function gw(extra: Record<string, unknown> = {}) {
  return {
    sku: { tier: "WAF_v2" },
    frontendIPConfigurations: [
      { name: "pub", properties: { publicIPAddress: { id: "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.network/publicipaddresses/pip" } } },
      { name: "priv", properties: { privateIPAddress: "10.0.0.10" } },
    ],
    httpListeners: [listener("l-web", "pub"), listener("l-api", "pub"), listener("l-int", "priv"), listener("l-unused", "pub")],
    requestRoutingRules: [rule("r1", "l-web"), rule("r2", "l-api"), rule("r3", "l-int")],
    urlPathMaps: [],
    ...extra,
  };
}
const pol = (name: string, mode: string, enabled = true): WafPolicyFacts => ({ id: POL(name), name, sku: null, mode, enabled, managed: [{ type: "Microsoft_DefaultRuleSet", version: "2.1", action: null }], customRules: 1 });
const wafs = (...ps: WafPolicyFacts[]) => new Map(ps.map((p) => [p.id!, p]));

test("gateway policy covers every rule-bound listener; only public ones count, an unused listener is not a unit", () => {
  const w = resolveAgwWaf(gw({ firewallPolicy: { id: POL("gw") } }), wafs(pol("gw", "Prevention")))!;
  assert.equal(w.unit, "listener");
  assert.deepEqual(w.counts, { served: 2, prevent: 2, detect: 0, disabled: 0, none: 0, unknown: 0 });
  assert.equal(w.state, "prevent");
  assert.deepEqual(w.domains.map((d) => [d.host, d.kind, d.level]), [["l-api", "public", "gateway"], ["l-int", "private", "gateway"], ["l-web", "public", "gateway"]]);
  assert.deepEqual(w.policies.map((p) => [p.name, p.level, p.domains]), [["gw", "gateway", ["l-api", "l-int", "l-web"]]]);
});

test("a listener policy overrides the gateway's; a path policy in another state makes the listener unknown", () => {
  const props = gw({
    firewallPolicy: { id: POL("gw") },
    httpListeners: [listener("l-web", "pub", "det"), listener("l-api", "pub")],
    requestRoutingRules: [rule("r1", "l-web"), rule("r2", "l-api", "pm")],
    urlPathMaps: [{ name: "pm", properties: { pathRules: [{ name: "admin", properties: { firewallPolicy: { id: POL("off") } } }] } }],
  });
  const w = resolveAgwWaf(props, wafs(pol("gw", "Prevention"), pol("det", "Detection"), pol("off", "Prevention", false)))!;
  const st = Object.fromEntries(w.domains.map((d) => [d.host, [d.state, d.reason ?? "", d.level ?? ""]]));
  assert.deepEqual(st["l-web"], ["detect", "", "listener"]);
  assert.deepEqual(st["l-api"], ["unknown", "pathScoped", ""]);
  assert.equal(w.state, "partial");
  assert.ok(w.policies.some((p) => p.name === "off" && p.level === "path"));
});

test("v1 inline WAF configuration: prevention / detection / disabled", () => {
  for (const [cfg, state] of [[{ enabled: true, firewallMode: "Prevention" }, "prevent"], [{ enabled: true, firewallMode: "Detection" }, "detect"], [{ enabled: false, firewallMode: "Prevention" }, "disabled"]] as const) {
    const w = resolveAgwWaf(gw({ sku: { tier: "WAF" }, webApplicationFirewallConfiguration: cfg }), wafs())!;
    assert.ok(w.domains.filter((d) => d.kind === "public").every((d) => d.state === state && d.level === "legacy"), state);
    assert.equal(w.policies[0]?.level, "legacy");
  }
});

test("Standard_v2 with public listeners: no WAF, and the SKU cannot run one; private-only counts nothing; no rule → null", () => {
  const std = resolveAgwWaf(gw({ sku: { tier: "Standard_v2" } }), wafs())!;
  assert.equal(std.state, "none");
  assert.equal(std.skuNoWaf, true);
  const priv = resolveAgwWaf(gw({ httpListeners: [listener("l-int", "priv")], requestRoutingRules: [rule("r", "l-int")] }), wafs())!;
  assert.equal(priv.counts.served, 0);
  assert.equal(priv.state, "noDomains");
  assert.equal(resolveAgwWaf(gw({ requestRoutingRules: [] }), wafs()), null);
});

test("an unreadable policy is unknown, a failed policy query says so — never 'no WAF'", () => {
  const missing = resolveAgwWaf(gw({ firewallPolicy: { id: POL("gone") } }), wafs())!;
  assert.ok(missing.domains.every((d) => d.state === "unknown" && d.reason === "policyUnreadable"));
  assert.equal(missing.state, "unknown");
  const failed = resolveAgwWaf(gw({ firewallPolicy: { id: POL("gw") } }), null)!;
  assert.equal(failed.readError, "wafPolicies");
  assert.equal(failed.counts.none, 0);
});

// Evidence ladder for metric-poor resources (PE, public IP, DNS, gateways) and the new AGC / Front Door / instance
// helpers. Synthetic inputs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEvidence } from "../src/services/healthEvidence.js";
import { rhSupported } from "../src/services/resourceHealthCollector.js";
import { agcFacts, resolveAgcCluster } from "../src/services/agc.js";
import { resolveAfdOrigins, type AfdConfig } from "../src/services/frontDoorConfig.js";
import { buildAddressIndex } from "../src/services/backendMembers.js";
import * as statusNs from "../../web/src/lib/liveStatus.ts";
import * as instNs from "../../web/src/lib/liveInstance.ts";

const S = ((statusNs as unknown as { default?: typeof statusNs }).default ?? statusNs) as typeof statusNs;
const I = ((instNs as unknown as { default?: typeof instNs }).default ?? instNs) as typeof instNs;
const pe = (metrics: Record<string, number | null>, conns = ["Approved"], prov = "Succeeded") =>
  resolveEvidence({ kind: "privateEndpoint", health: "unknown", judged: false, metrics, provisioningState: prov, peConnections: conns });

test("PE: traffic both ways in the hour → observed, health stays unknown (not counted as ok)", () => {
  const e = pe({ bytesIn: 120, bytesOut: 900 });
  assert.equal(e.basis, "observed");
  assert.equal(e.health, "unknown");
  assert.ok(e.reasons.includes("ld.ev.twoWay"));
});

test("PE: 0 and no series are different facts; one way is said", () => {
  assert.deepEqual(pe({ bytesIn: 0, bytesOut: 0 }).reasons, ["ld.ev.idle"]);
  assert.deepEqual(pe({ bytesIn: null, bytesOut: null }).reasons, ["ld.ev.noSeries"]);
  assert.deepEqual(pe({ bytesIn: 5, bytesOut: 0 }).reasons, ["ld.ev.oneWay"]);
  assert.equal(pe({ bytesIn: null, bytesOut: null }).basis, "configured");
});

test("PE: Rejected / Disconnected = warning (never critical); Pending = info only", () => {
  for (const st of ["Rejected", "Disconnected"]) {
    const e = pe({ bytesIn: 9, bytesOut: 9 }, [st]);
    assert.equal(e.health, "warning", st);
  }
  const p = pe({ bytesIn: null, bytesOut: null }, ["Pending"]);
  assert.equal(p.health, "unknown");
  assert.ok(p.reasons.includes("ld.ev.pePending"));
  assert.equal(pe({}, ["Approved"], "Failed").health, "warning");
});

test("Resource Health: Degraded / Unavailable outrank activity; Available = ok; Unknown is no evidence", () => {
  const base = { kind: "natGateway", health: "unknown" as const, judged: false, metrics: {}, provisioningState: "Succeeded" };
  assert.equal(resolveEvidence({ ...base, rh: "Unavailable" }).health, "critical");
  assert.equal(resolveEvidence({ ...base, rh: "Degraded" }).health, "warning");
  assert.deepEqual([resolveEvidence({ ...base, rh: "Available" }).health, resolveEvidence({ ...base, rh: "Available" }).basis], ["ok", "resourceHealth"]);
  const u = resolveEvidence({ ...base, rh: "Unknown" });
  assert.notEqual(u.health, "ok");
  assert.ok(u.reasons.includes("ld.ev.rhUnknown"));
  assert.equal(rhSupported("/subscriptions/0/resourcegroups/rg/providers/microsoft.network/natgateways/n"), true);
  assert.equal(rhSupported("/subscriptions/0/resourcegroups/rg/providers/microsoft.network/privateendpoints/p"), false, "PE is not on the Learn list");
});

test("quality rules keep precedence; NSG / unused public IP = notApplicable", () => {
  assert.equal(resolveEvidence({ kind: "lb", health: "ok", judged: true, metrics: {}, provisioningState: "Succeeded" }).basis, "metric");
  assert.equal(resolveEvidence({ kind: "lb", health: "critical", judged: true, metrics: {} }).health, "critical");
  assert.equal(resolveEvidence({ kind: "nsg", health: "unknown", judged: false, metrics: {} }).basis, "notApplicable");
  assert.equal(resolveEvidence({ kind: "publicIP", health: "unknown", judged: false, metrics: {}, unused: true }).basis, "notApplicable");
  // compute keeps unknown (power state speaks for it), plumbing shows "configured"
  assert.equal(resolveEvidence({ kind: "vm", health: "unknown", judged: false, metrics: {}, provisioningState: "Succeeded" }).basis, "none");
  assert.equal(resolveEvidence({ kind: "vnetGateway", health: "unknown", judged: false, metrics: {}, provisioningState: "Succeeded" }).basis, "configured");
});

test("card status: observed is not green ok; configured grey; notApplicable has no glyph", () => {
  const o = S.cardStatus("unknown", undefined, undefined, "observed");
  assert.equal(o.key, "ld.status.observed");
  assert.equal(o.tone, "info");
  assert.equal(S.cardStatus("unknown", undefined, undefined, "configured").tone, "neutral");
  assert.equal(S.cardStatus("unknown", undefined, undefined, "notApplicable").glyph, "");
  assert.equal(S.cardStatus("unknown", "running", undefined, "configured").key, "ld.power.running", "power state first");
  assert.equal(S.cardStatus("warning", undefined, undefined, "observed").key, "ld.status.warning");
});

test("AKS instance health from node conditions", () => {
  assert.equal(I.instanceHealth(undefined).status, "unknown");
  assert.equal(I.instanceHealth([{ type: "Ready", status: "True" }]).status, "ok");
  assert.equal(I.instanceHealth([{ type: "Ready", status: "False" }]).status, "critical");
  assert.equal(I.instanceHealth([{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "True" }]).status, "warning");
});

const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups";
test("AGC: children fold into the controller; cluster by node RG, else the only cluster in the VNet", () => {
  const agc = `${SUB}/mc_rg/providers/microsoft.servicenetworking/trafficcontrollers/alb`;
  const f = agcFacts([
    { id: `${agc}/associations/a1`, type: "microsoft.servicenetworking/trafficcontrollers/associations", properties: { subnet: { id: `${SUB}/net/providers/microsoft.network/virtualnetworks/v/subnets/snet-agc` }, provisioningState: "Succeeded" } },
    { id: `${agc}/frontends/fe1`, type: "microsoft.servicenetworking/trafficcontrollers/frontends", properties: { fqdn: "abc.fz12.alb.azure.com" } },
    { id: `${agc}/frontends/fe2`, type: "microsoft.servicenetworking/trafficcontrollers/frontends", properties: { fqdn: "def.fz12.alb.azure.com", publicNetworkAccess: "Disabled" } },
  ]).get(agc)!;
  assert.equal(f.associations[0]!.subnetId?.endsWith("/snet-agc"), true);
  assert.deepEqual(f.frontends.map((x) => x.public), [true, false]);
  const V = `${SUB}/net/providers/microsoft.network/virtualnetworks/v`;
  const c1 = { id: "aks1", nodeResourceGroup: "MC_rg", vnetIds: new Set([V]) };
  const c2 = { id: "aks2", nodeResourceGroup: "MC_other", vnetIds: new Set([V]) };
  assert.deepEqual(resolveAgcCluster({ resourceGroup: "mc_rg", vnetIds: new Set([V]) }, [c1, c2]), { targetId: "aks1", evidence: "nodeRg" });
  assert.deepEqual(resolveAgcCluster({ resourceGroup: "rg-net", vnetIds: new Set([V]) }, [c1]), { targetId: "aks1", evidence: "sameVnet" });
  assert.deepEqual(resolveAgcCluster({ resourceGroup: "rg-net", vnetIds: new Set([V]) }, [c1, c2]), { candidates: 2 });
  assert.deepEqual(resolveAgcCluster({ resourceGroup: "rg-net", vnetIds: new Set(["other"]) }, [c1]), { candidates: 0 });
});

test("Front Door origins: Private Link > azureOrigin > IP owner > host name; exactly one or nothing", () => {
  const LB = `${SUB}/rg/providers/microsoft.network/loadbalancers/lb`;
  const SITE = `${SUB}/rg/providers/microsoft.web/sites/app`;
  const NIC = `${SUB}/rg/providers/microsoft.network/networkinterfaces/nic`, VM = `${SUB}/rg/providers/microsoft.compute/virtualmachines/vm`;
  const idx = buildAddressIndex([
    { address: "203.0.113.5", targetId: LB, source: "pip" },
    { address: "203.0.113.6", targetId: NIC, source: "pip" },
    { address: "app.azurewebsites.net", targetId: SITE, source: "site" },
  ]);
  const cfg: AfdConfig = {
    endpoints: [{ name: "ep", hostName: "ep.z01.azurefd.net", enabled: true }],
    routes: [{ endpoint: "ep", name: "r", originGroup: "g1", enabled: true }, { endpoint: "ep", name: "off", originGroup: "g2", enabled: false }],
    origins: [
      { group: "g1", name: "o-lb", hostName: "203.0.113.5", enabled: true },
      { group: "g1", name: "o-vm", hostName: "203.0.113.6", enabled: true },
      { group: "g1", name: "o-site", hostName: "app.azurewebsites.net", enabled: true },
      { group: "g1", name: "o-ext", hostName: "198.51.100.9", enabled: true },
      { group: "g1", name: "o-off", hostName: "203.0.113.5", enabled: false },
      { group: "g2", name: "o-unrouted", hostName: "203.0.113.5", enabled: true },
      { group: "g1", name: "o-az", hostName: "x", azureOriginId: SITE, enabled: true },
    ],
  };
  const r = resolveAfdOrigins(cfg, idx, new Set([LB, SITE, VM]), (id) => (id === NIC ? VM : id));
  assert.deepEqual(r.links.map((l) => `${l.origin}:${l.rel}:${l.targetId.split("/").pop()}`).sort(), ["o-az:EDGE-06:app", "o-lb:EDGE-05:lb", "o-site:EDGE-04:app", "o-vm:EDGE-05:vm"].sort());
  assert.equal(r.external, 1);
  assert.equal(r.unusedGroups, 1, "a group no enabled route uses draws nothing");
});

test("AKS node readiness from the platform metric: the series at 1 is the current state", async () => {
  const { parseNodeReady } = await import("../src/services/edgeDetailService.js");
  const s = (node: string, status2: string, v: number) => ({ metadatavalues: [{ name: { value: "node" }, value: node }, { name: { value: "status2" }, value: status2 }], data: [{ average: 0 }, { average: v }] });
  const m = parseNodeReady([s("aks-a-vmss000000", "Ready", 1), s("aks-a-vmss000000", "Unknown", 0), s("aks-a-vmss000001", "NotReady", 1), s("aks-a-vmss000002", "Ready", 0)]);
  assert.deepEqual([...m.entries()].sort(), [["aks-a-vmss000000", "Ready"], ["aks-a-vmss000001", "NotReady"]]);
  assert.equal(I.instanceHealth([{ type: "Ready", status: "True" }], "platformMetric").reason, "ld.inst.readyMetric");
  assert.equal(I.instanceHealth([{ type: "Ready", status: "Unknown" }], "platformMetric").status, "critical", "kubelet stopped reporting");
});

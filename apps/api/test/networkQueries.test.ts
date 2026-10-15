// VNet traffic: KQL builders (scope, injection, units), label masking, mappers, coverage classification, the
// live-or-sample route helper, and the web's tab / risky-port rules. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  binMinutes,
  blockedQuery,
  endpointLabel,
  groupLabel,
  internetQuery,
  mapBlocked,
  mapInternet,
  mapOverview,
  mapTalkers,
  normDir,
  normProto,
  overviewQuery,
  scopePrefix,
  snapRange,
  talkersQuery,
  threatQuery,
} from "../src/services/networkQueries.js";
import { buildFlowCoverage } from "../src/services/flowLogCoverage.js";
import { laState } from "../src/services/networkFlows.js";
import { HttpError, respondLiveOrSignin } from "../src/infra/requestParams.js";
import * as tabsNs from "../../web/src/app/network/tabs.ts";

const { NET_TABS, isRiskyPort } = ((tabsNs as unknown as { default?: typeof tabsNs }).default ?? tabsNs) as typeof tabsNs;

const SUB = "22222222-2222-2222-2222-222222222222";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const T = "NTANetAnalytics";

test("ranges snap to the allowed set; bins follow the range", () => {
  assert.deepEqual([60, 360, 1440, 10080].map(binMinutes), [10, 10, 60, 360]);
  assert.equal(snapRange(15), 1440);
  assert.equal(snapRange(10080), 10080);
  assert.equal(scopePrefix(SUB.toUpperCase(), "RG-A/VNet-Hub"), `${SUB}/rg-a/vnet-hub/`);
});

test("every builder is scoped and time-bounded; injected text appears only escaped", () => {
  const evil = `${SUB}/a'b"c\\d/`;
  const qs = [
    overviewQuery(T, 1440, evil),
    talkersQuery(T, 1440, evil, "subnet", 20),
    talkersQuery(T, 1440, evil, "port", 20),
    blockedQuery(T, 1440, evil, 20),
    internetQuery(T, 1440, evil, "in", 20),
  ];
  for (const q of qs) {
    assert.match(q, /TimeGenerated > ago\(1440m\)/);
    assert.ok(q.includes(String.raw`startswith "${SUB}/a'b\"c\\d/"`), "kqlString-escaped prefix");
    assert.ok(!q.includes(`a'b"c\\d/"`.replace(/\\/g, "")), "no raw quote");
  }
  const inet = internetQuery(T, 60, `${SUB}/`, "in", 10);
  assert.match(inet, /mv-expand/);
  assert.ok(!/sum\(Bytes\)/.test(inet), "no byte sums after the expansion (records only)");
  assert.match(inet, /"ExternalPublic", "MaliciousFlow"\)/);
  assert.match(internetQuery(T, 60, `${SUB}/`, "out", 10), /"AzurePublic"/);
  assert.match(talkersQuery(T, 60, `${SUB}/`, "subnet", 5), /by S, D/);
  assert.match(talkersQuery(T, 60, `${SUB}/`, "port", 5), /by Port = toint\(DestPort\), Proto/);
  assert.match(blockedQuery(T, 60, `${SUB}/`, 5), /column_ifexists\("AclRule"/);
  assert.match(threatQuery(60, [`1.2.3.4"`]), /Ip in \("1\.2\.3\.4\\""\)/);
});

test("labels drop the subscription and mask GUIDs; normalizers", () => {
  assert.equal(endpointLabel(`${SUB}/rg-a/vnet-hub/snet-app`), "rg-a/vnet-hub/snet-app");
  assert.equal(endpointLabel(`/subscriptions/${SUB}/resourceGroups/rg-a/providers/Microsoft.Network/virtualNetworks/vnet-hub/subnets/snet-app`), "rg-a/vnet-hub/snet-app");
  assert.equal(endpointLabel("10.0.0.4"), "10.0.0.4");
  assert.equal(groupLabel(`${SUB}/rg-a/nsg-app`), "nsg-app");
  assert.equal(groupLabel(`/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg-web`), "nsg-web");
  assert.equal(normProto("T"), "TCP");
  assert.equal(normProto("U"), "UDP");
  assert.equal(normDir("I"), "in");
  assert.equal(normDir("Outbound"), "out");
  assert.equal(normDir(""), null);
});

test("mappers: totals fold, nothing identifying leaves, malicious first", () => {
  const ov = mapOverview([
    { T: "2026-10-14T01:00:00Z", FT: "IntraVNet", Bytes: 100, Allowed: 3, Denied: 1, Records: 2 },
    { T: "2026-10-14T00:00:00Z", FT: "ExternalPublic", Bytes: 50, Allowed: 1, Denied: 4, Records: 1 },
    { T: "2026-10-14T01:00:00Z", FT: "ExternalPublic", Bytes: 10, Allowed: 0, Denied: 0, Records: 1 },
  ]);
  assert.deepEqual(ov.totals, { bytes: 160, allowedFlows: 4, deniedFlows: 5, records: 4 });
  assert.deepEqual(ov.series.map((s) => s.bytes), [50, 110], "sorted by time");
  assert.equal(ov.byFlowType[0]!.flowType, "IntraVNet");

  const t = mapTalkers([{ S: `${SUB}/rg/vnet/a`, D: `${SUB}/rg/vnet/b`, Bytes: 5, Allowed: 1, Denied: 0 }], "subnet");
  const b = mapBlocked([{ Grp: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg-a`, Rule: "DefaultRule_DenyAllInBound", Dir: "in", Port: 22, Proto: "T", Flows: 9, Records: 3, Sources: ["203.0.113.4"], Last: "2026-10-14T00:00:00Z" }]);
  const i = mapInternet([
    { Ip: "203.0.113.4", Records: 10, AllowedRec: 10, DeniedRec: 0, MalRec: 0, Types: ["ExternalPublic"], Targets: [`${SUB}/rg/vnet/snet`], Ports: [443] },
    { Ip: "198.51.100.7", Records: 1, AllowedRec: 0, DeniedRec: 1, MalRec: 1, Types: ["MaliciousFlow"], Targets: [], Ports: [22] },
  ], "in", new Map([["198.51.100.7", { threat: "Botnet", detail: `seen at ${SUB}` }]]));
  const json = JSON.stringify({ t, b, i });
  assert.ok(!GUID.test(json.replace(/…[0-9a-f]{4}/g, "")), json);
  assert.ok(!json.includes("/subscriptions/"));
  assert.equal(b[0]!.group, "nsg-a");
  assert.equal(b[0]!.protocol, "TCP");
  assert.deepEqual(i.map((r) => r.ip), ["198.51.100.7", "203.0.113.4"], "malicious first");
  assert.equal(i[0]!.threat, "Botnet");
});

test("Log Analytics failures that are workspace states vs real errors", () => {
  assert.equal(laState(new Error("LogAnalytics 403: InsufficientAccessError: no access")), "noAccess");
  assert.equal(laState(new Error("LogAnalytics 400: BadArgumentError: Failed to resolve table or column expression named 'NTANetAnalytics'")), "noTable");
  assert.equal(laState(new Error("LogAnalytics 400: BadArgumentError: syntax")), null);
  assert.equal(laState(new HttpError(403, "connection_forbidden", "x")), null, "connection refusals are the request's answer");
});

// ── coverage ──

const vnetId = `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.network/virtualnetworks`;
const nsgId = (n: string) => `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.network/networksecuritygroups/${n}`;
const ws = `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.operationalinsights/workspaces/law-net`;

test("coverage: VNet / partial / NSG-only / none, enabled only, workspace match, legacy and unmapped counts", () => {
  const vnetRows = [
    { vnet: `${vnetId}/hub`, name: "hub", resourceGroup: "rg", location: "koreacentral", subnet: `${vnetId}/hub/subnets/a`, nsg: nsgId("nsg-a") },
    { vnet: `${vnetId}/spoke`, name: "spoke", resourceGroup: "rg", location: "koreacentral", subnet: `${vnetId}/spoke/subnets/b`, nsg: "" },
    { vnet: `${vnetId}/legacy`, name: "legacy", resourceGroup: "rg", location: "koreacentral", subnet: `${vnetId}/legacy/subnets/c`, nsg: nsgId("nsg-c") },
    { vnet: `${vnetId}/bare`, name: "bare", resourceGroup: "rg", location: "koreacentral" },
    { vnet: `${vnetId}/off`, name: "off", resourceGroup: "rg", location: "koreacentral" },
  ];
  const flowLogs = [
    { t: `${vnetId}/hub`, enabled: true, ta: true, interval: 10, ws, retention: 30, retentionOn: true },
    { t: nsgId("nsg-a"), enabled: true, ta: true, interval: 60, ws },
    { t: `${vnetId}/spoke/subnets/b`, enabled: true, ta: false, ws: "" },
    { t: nsgId("nsg-c"), enabled: true, ta: false },
    { t: `${vnetId}/off`, enabled: false, ta: true, interval: 10, ws },
    { t: `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.network/networkinterfaces/nic-1`, enabled: true },
  ];
  const workspaces = [{ id: ws, name: "law-net", customerId: "55555555-5555-5555-5555-555555555555" }];
  const out = buildFlowCoverage({ flowLogs, vnetRows, workspaces, configuredWorkspaceId: "55555555-5555-5555-5555-555555555555" });
  const by = Object.fromEntries(out.vnets.map((v) => [v.name, v]));
  assert.equal(by.hub!.kind, "vnet");
  assert.equal(by.hub!.trafficAnalytics, true);
  assert.equal(by.hub!.intervalMin, 10, "VNet-side logs only — the NSG log's 60 is not this VNet's interval");
  assert.equal(by.hub!.workspaceMatches, true);
  assert.equal(by.hub!.workspace, "law-net");
  assert.equal(by.hub!.nsgLegacy, 1, "the NSG flow log is counted to migrate");
  assert.equal(by.spoke!.kind, "partial", "a subnet id contains /virtualnetworks/ but is a subnet");
  assert.equal(by.spoke!.trafficAnalytics, false);
  assert.equal(by.legacy!.kind, "nsgOnly");
  assert.equal(by.bare!.kind, "none");
  assert.equal(by.off!.kind, "none", "a disabled log does not cover");
  assert.equal(by.off!.disabledLogs, 1);
  assert.equal(out.unmappedFlowLogs, 1, "the NIC flow log");
  assert.deepEqual(out.vnets.map((v) => v.kind), ["none", "none", "nsgOnly", "partial", "vnet"], "worst first");
  assert.deepEqual(out.vnets.slice(0, 2).map((v) => v.name), ["bare", "off"], "then by name");
  const other = buildFlowCoverage({ flowLogs, vnetRows, workspaces, configuredWorkspaceId: "66666666-6666-6666-6666-666666666666" });
  assert.equal(other.vnets.find((v) => v.name === "hub")!.workspaceMatches, false);
  assert.equal(buildFlowCoverage({ flowLogs, vnetRows, workspaces: [], configuredWorkspaceId: "x" }).vnets.find((v) => v.name === "hub")!.workspaceMatches, null, "unknown workspace → unknown");
  assert.ok(!JSON.stringify(out).includes("/subscriptions/"));
});

// ── route helper: sample only for anonymous ──

function fakeRes() {
  const r = { statusCode: 200, body: undefined as unknown, headersSent: false, writableEnded: false, headers: {} as Record<string, string>,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader(k: string, v: string) { r.headers[k] = v; } };
  return r;
}

test("respondLiveOrSignin: anonymous → sample; signed-in errors are coded and masked, never sample data", async () => {
  const sample = () => ({ items: [1], source: "mock" as const });
  let res = fakeRes();
  await respondLiveOrSignin(res as never, async () => { throw new HttpError(401, "signin_required", "x"); }, sample, "network_query_failed");
  assert.deepEqual(res.body, { items: [1], source: "mock", note: "signin_required" });

  res = fakeRes();
  await respondLiveOrSignin(res as never, async () => { throw new HttpError(403, "consent_required", `AADSTS65001 app '${SUB}' Trace ID: ${SUB}`); }, sample, "network_query_failed");
  assert.equal(res.statusCode, 403);
  const body = res.body as { error: string; message: string; source?: string };
  assert.equal(body.error, "consent_required");
  assert.ok(!GUID.test(body.message) && body.source === undefined);

  res = fakeRes();
  const origError = console.error;
  console.error = () => {};
  try {
    await respondLiveOrSignin(res as never, async () => { throw new Error(`boom /subscriptions/x ${SUB}`); }, sample, "network_query_failed");
  } finally {
    console.error = origError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal((res.body as { error: string }).error, "network_query_failed");
  assert.ok(!JSON.stringify(res.body).includes(SUB));

  res = fakeRes();
  await respondLiveOrSignin(res as never, async () => ({ state: "disabled", source: "live" }), sample, "x");
  assert.deepEqual(res.body, { state: "disabled", source: "live" });
});

test("web: tabs and the Internet-exposed management port rule", () => {
  assert.deepEqual([...NET_TABS], ["overview", "talkers", "blocked", "internet", "coverage"]);
  assert.equal(isRiskyPort({ port: 22, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 3 }), true);
  assert.equal(isRiskyPort({ port: 22, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 0 }), false, "only when allowed from the Internet");
  assert.equal(isRiskyPort({ port: 443, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 9 }), false);
});

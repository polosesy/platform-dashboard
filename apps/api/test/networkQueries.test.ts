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
  mapEnd,
  mapInternet,
  mapMap,
  mapQuery,
  mapOverview,
  mapTalkers,
  normDir,
  normProto,
  freshnessQuery,
  overviewQuery,
  scopeClause,
  snapRange,
  talkersQuery,
  targetVnetKey,
  threatQuery,
} from "../src/services/networkQueries.js";
import { buildFlowCoverage, pickFlowWorkspaces } from "../src/services/flowLogCoverage.js";
import { laState, observedByVnet, sectionWorkspaces } from "../src/services/networkFlows.js";
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
});

test("scope: the flow log's target VNet first; subnet forms (with and without the subscription) only as a fallback", () => {
  const one = scopeClause({ subscriptionId: SUB.toUpperCase(), vnet: "RG-A/VNet-Hub" });
  assert.ok(one.includes(`Tgt == "${SUB}/rg-a/vnet-hub"`), one);
  assert.ok(one.includes(`Tgt startswith "${SUB}/rg-a/vnet-hub/"`), "a subnet flow log's target");
  assert.ok(one.includes(`startswith "rg-a/vnet-hub/"`), "VNet-flow-log rows write subnets without the subscription");
  assert.ok(one.includes(`SrcSubnet) startswith "${SUB}/rg-a/vnet-hub/"`), "NSG-era rows carry it");
  assert.ok(one.includes(`(isempty(Tgt) or TType !in~ ("VirtualNetwork", "Subnet"))`), "subnets only when the target is not a VNet/subnet");
  const all = scopeClause({ subscriptionId: SUB });
  assert.ok(all.includes(`Tgt startswith "${SUB}/"`));
  assert.ok(all.includes(`column_ifexists("SrcSubscription"`));
  assert.equal(targetVnetKey(`${SUB}/RG-A/vnet-hub`), "rg-a/vnet-hub");
  assert.equal(targetVnetKey(`${SUB}/rg-a/vnet-hub/snet-1`), "rg-a/vnet-hub");
  assert.equal(targetVnetKey("rg-a/vnet-hub"), null, "no subscription → not a target");
  const fr = freshnessQuery(T, { subscriptionId: SUB });
  assert.ok(fr.includes(`K = "table"`), "the table's existence apart from rows in scope");
  assert.ok(fr.includes("by Tgt"));
  assert.ok(overviewQuery(T, 60, { subscriptionId: SUB }).includes(`iff(SVm startswith "unknown-rg/", "", SVm)`), "unknown VMs are blanked, not one VM");
  assert.ok(talkersQuery(T, 60, { subscriptionId: SUB }, "vm", 5).includes("coalesce(SVm, SrcIp)"));
});

test("every builder is scoped and time-bounded; injected text appears only escaped", () => {
  const evil = { subscriptionId: SUB, vnet: `a'b"c\\d` };
  const qs = [
    overviewQuery(T, 1440, evil),
    talkersQuery(T, 1440, evil, "subnet", 20),
    talkersQuery(T, 1440, evil, "port", 20),
    blockedQuery(T, 1440, evil, 20),
    internetQuery(T, 1440, evil, "in", 20),
  ];
  for (const q of qs) {
    assert.match(q, /TimeGenerated > ago\(1440m\)/);
    assert.ok(q.includes(String.raw`Tgt == "${SUB}/a'b\"c\\d"`), "kqlString-escaped target");
    assert.ok(q.includes(String.raw`startswith "a'b\"c\\d/"`), "kqlString-escaped subnet form");
    assert.ok(!q.includes(`a'b"c`), "no raw quote");
  }
  const S = { subscriptionId: SUB };
  const inet = internetQuery(T, 60, S, "in", 10);
  assert.match(inet, /mv-expand/);
  assert.ok(!/sum\(Bytes\)/.test(inet), "no byte sums after the expansion (records only)");
  assert.match(inet, /"ExternalPublic", "MaliciousFlow"\)/);
  assert.match(internetQuery(T, 60, S, "out", 10), /"AzurePublic"/);
  assert.match(talkersQuery(T, 60, S, "subnet", 5), /by S, D/);
  assert.match(talkersQuery(T, 60, S, "port", 5), /by Port = toint\(DestPort\), Proto/);
  assert.match(blockedQuery(T, 60, S, 5), /column_ifexists\("AclRule"/);
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
  assert.equal(laState(new Error("LogAnalytics 400: BadArgumentError: The request had some invalid properties · A semantic error occurred. · Operator source expression should be table or column")), "noTable", "a fuzzy union with every table missing");
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
  const cov = (extra: Partial<Parameters<typeof buildFlowCoverage>[0]> = {}) => buildFlowCoverage({
    flowLogs, vnetRows, workspaces, readWorkspaceIds: ["55555555-5555-5555-5555-555555555555"],
    flowLogsRead: true, watcherRegions: new Set(["koreacentral"]), subscriptionReadable: null, observed: null, ...extra,
  });
  const out = cov();
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
  assert.equal(by.hub!.config, "read");
  const other = cov({ readWorkspaceIds: ["66666666-6666-6666-6666-666666666666"] });
  assert.equal(other.vnets.find((v) => v.name === "hub")!.workspaceMatches, false);
  assert.equal(cov({ workspaces: [] }).vnets.find((v) => v.name === "hub")!.workspaceMatches, null, "unknown workspace → unknown");
  assert.ok(!JSON.stringify(out).includes("/subscriptions/"));
});

test("coverage: settings not visible are 'unknown', never 'none'; arriving rows prove a VNet flow log", () => {
  // A connection with Reader on the VNet's resource group only: Resource Graph shows the VNet, no Network Watcher, no flow log
  const vnetRows = [
    { vnet: `${vnetId}/stg`, name: "stg", resourceGroup: "RG", location: "koreacentral", subnet: `${vnetId}/stg/subnets/a` },
    { vnet: `${vnetId}/quiet`, name: "quiet", resourceGroup: "rg", location: "koreacentral" },
  ];
  const observed = observedByVnet([
    { name: "law-stg", targets: [{ tgt: `${SUB}/rg/stg`, rows: 155_984, last: "2026-10-29T00:07:38Z" }, { tgt: `${SUB}/rg/stg/subnets/a`, rows: 1, last: "2026-10-28T00:00:00Z" }] },
  ]);
  assert.deepEqual(observed.get("rg/stg"), { rows7d: 155_985, lastRow: "2026-10-29T00:07:38Z", vnetLevel: true, workspaces: ["law-stg"] });
  const base = { flowLogs: [], vnetRows, workspaces: [], readWorkspaceIds: ["55555555-5555-5555-5555-555555555555"], flowLogsRead: true, watcherRegions: new Set<string>(), subscriptionReadable: false };
  const hidden = Object.fromEntries(buildFlowCoverage({ ...base, observed }).vnets.map((v) => [v.name, v]));
  assert.equal(hidden.stg!.kind, "vnet", "the rows prove it");
  assert.equal(hidden.stg!.config, "hidden");
  assert.equal(hidden.stg!.trafficAnalytics, true);
  assert.equal(hidden.stg!.workspace, "law-stg");
  assert.equal(hidden.stg!.workspaceMatches, true);
  assert.equal(hidden.stg!.intervalMin, null, "interval and retention are settings — unknown");
  assert.deepEqual(hidden.stg!.observed, { rows7d: 155_985, lastRow: "2026-10-29T00:07:38Z" });
  assert.equal(hidden.quiet!.kind, "unknown", "no rows and no visible settings → unknown, not none");
  assert.deepEqual(hidden.quiet!.observed, { rows7d: 0, lastRow: null });
  // Same subscription read at subscription scope: no flow log really means none
  assert.equal(buildFlowCoverage({ ...base, subscriptionReadable: true, observed }).vnets.find((v) => v.name === "quiet")!.kind, "none");
  // A visible Network Watcher in the region is enough to trust "none"
  assert.equal(buildFlowCoverage({ ...base, watcherRegions: new Set(["koreacentral"]), observed: null }).vnets.find((v) => v.name === "quiet")!.kind, "none");
  // The flow-log query failed → unknown everywhere
  assert.equal(buildFlowCoverage({ ...base, flowLogsRead: false, subscriptionReadable: true, observed: null }).vnets.find((v) => v.name === "quiet")!.kind, "unknown");
  // Rows only from a subnet flow log → partial
  const sub = observedByVnet([{ name: "w", targets: [{ tgt: `${SUB}/rg/quiet/subnets/x`, rows: 3, last: null }] }]);
  assert.equal(buildFlowCoverage({ ...base, observed: sub }).vnets.find((v) => v.name === "quiet")!.kind, "partial");
});

test("workspaces: the flow log's own TA workspace when the subscription's connection reads it; others named, not read", () => {
  const W = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-0000-0000-00000000000${n}`;
  const arm = (name: string) => `/subscriptions/${SUB}/resourcegroups/rg/providers/microsoft.operationalinsights/workspaces/${name}`;
  const workspaces = [
    { id: arm("law-stg"), name: "law-stg", customerId: W(1) },
    { id: arm("law-hub"), name: "law-hub", customerId: W(2) },
  ];
  const flowLogs = [
    { t: `${vnetId}/stg`, enabled: true, ta: true, ws: arm("law-stg") },
    { t: `${vnetId}/spoke`, enabled: true, ta: true, ws: arm("law-hub") },
    { t: `${vnetId}/off`, enabled: false, ta: true, ws: arm("law-off") },
    { t: `${vnetId}/hidden`, enabled: true, ta: true, ws: arm("law-unreadable") },
  ];
  // A customer connection listing only law-stg
  const cust = pickFlowWorkspaces({ flowLogs, workspaces, listed: [W(1)], listedElsewhere: new Set(), homeReads: false, envWorkspace: W(9) });
  assert.deepEqual(cust.read, [{ id: W(1), name: "law-stg", via: "flowLog" }]);
  assert.deepEqual(cust.unlisted, ["law-hub", "law-unreadable"], "named so the connection file can list them; the disabled log's is not");
  // Listed but no flow log names it (settings hidden): read via the connection
  assert.deepEqual(pickFlowWorkspaces({ flowLogs: [], workspaces, listed: [W(1)], listedElsewhere: new Set(), homeReads: false }).read, [{ id: W(1), name: "law-stg", via: "connection" }]);
  // Home: flow-log workspaces no other connection lists, then the env setting
  const home = pickFlowWorkspaces({ flowLogs, workspaces, listed: [], listedElsewhere: new Set([W(2)]), homeReads: true, envWorkspace: W(9).toUpperCase() });
  assert.deepEqual(home.read.map((r) => [r.name, r.via]), [["law-stg", "flowLog"], ["…0009", "env"]]);
  assert.deepEqual(home.unlisted, ["law-hub", "law-unreadable"], "a workspace another connection lists is read with that identity, not home's");
  assert.ok(!JSON.stringify([cust, home]).includes("/subscriptions/"));
});

test("sections read the workspaces with rows; none with rows → the first that answered", () => {
  assert.deepEqual(sectionWorkspaces([{ id: "a", state: "empty", rows7d: 0 }, { id: "b", state: "ok", rows7d: 5 }, { id: "c", state: "ok", rows7d: 2 }]), ["b", "c"]);
  assert.deepEqual(sectionWorkspaces([{ id: "a", state: null, rows7d: null }, { id: "b", state: "noTable", rows7d: null }]), ["b"]);
  assert.deepEqual(sectionWorkspaces([{ id: "a", state: null, rows7d: null }]), ["a"]);
  assert.deepEqual(sectionWorkspaces([]), []);
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
  assert.deepEqual([...NET_TABS], ["map", "overview", "talkers", "blocked", "internet", "coverage"], "the map first, like Pod traffic");
  assert.equal(isRiskyPort({ port: 22, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 3 }), true);
  assert.equal(isRiskyPort({ port: 22, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 0 }), false, "only when allowed from the Internet");
  assert.equal(isRiskyPort({ port: 443, protocol: "TCP", bytes: 1, allowedFlows: 1, deniedFlows: 0, publicInAllowed: 9 }), false);
});

// ── traffic map ──

const SUBX = "00000000-0000-0000-0000-000000000000";

test("map query: one line per (source, destination); the end without a subnet is its FlowType class; both outside → one '*' row", () => {
  const q = mapQuery("NTANetAnalytics", 1440, { subscriptionId: SUBX }, 150);
  assert.match(q, /FT in \("ExternalPublic", "MaliciousFlow"\), "internet", FT == "AzurePublic", "azure"/);
  assert.match(q, /FT in \("S2S", "P2S", "ExpressRoute"\), "onprem"/);
  assert.match(q, /S = iff\(isnotempty\(SrcSubnet\), tolower\(SrcSubnet\), strcat\("@", Cls\)\)/);
  assert.match(q, /Outside = S startswith "@" and D startswith "@"/);
  assert.match(q, /Keep = S == "\*" or Rk <= 150 or Dn > 0 or Mal > 0/, "denied / malicious lines survive the top N");
  assert.ok(q.includes("Tgt startswith"), "scoped like every section (TargetResourceId)");
});

test("map rows: subscription stripped from subnet ends, classes kept, '*' counted not drawn, duplicates merged", () => {
  const rows = [{
    Omitted: 3,
    Rows: [
      { S: "*", D: "*", Bytes: 900, Rec: 12, A: 0, Dn: 0, Mal: 0 },
      { S: "@internet", D: `${SUBX}/rg-a/vnet-a/snet-web`, Bytes: 5000, A: 10, Dn: 4, Rec: 7, Mal: 1, Last: "2026-10-29T03:00:00Z",
        P: [{ p: 22, pr: "T", b: 10, a: 0, d: 4 }, { p: 443, pr: "T", b: 4990, a: 10, d: 0 }], DP: [22] },
      { S: "rg-a/vnet-a/snet-web", D: "rg-a/vnet-a/snet-app", Bytes: 3000, A: 8, Dn: 0, Rec: 4, Mal: 0, Last: "2026-10-29T02:00:00Z", P: [{ p: 8080, pr: "T", b: 3000, a: 8, d: 0 }], DP: [] },
      { S: `${SUBX}/rg-a/vnet-a/snet-web`, D: "rg-a/vnet-a/snet-app", Bytes: 1000, A: 2, Dn: 0, Rec: 1, Mal: 0, Last: "2026-10-29T04:00:00Z", P: [], DP: [] },
      { S: "@nowhere", D: "rg-a/vnet-a/snet-app", Bytes: 1, A: 1, Dn: 0, Rec: 1, Mal: 0, P: [], DP: [] },
    ],
  }];
  const m = mapMap(rows);
  assert.deepEqual(m.unplaced, { bytes: 900, records: 12 });
  assert.equal(m.omitted, 3);
  assert.deepEqual(m.edges.map((e) => `${e.src}>${e.dst}:${e.bytes}`), ["@internet>rg-a/vnet-a/snet-web:5000", "rg-a/vnet-a/snet-web>rg-a/vnet-a/snet-app:4000"]);
  const inet = m.edges[0]!;
  assert.deepEqual([inet.deniedFlows, inet.maliciousRecords, inet.deniedPorts, inet.ports[0]!.port, inet.ports[0]!.proto], [4, 1, [22], 443, "TCP"]);
  assert.equal(m.edges[1]!.last, "2026-10-29T04:00:00Z", "the newest record of the merged rows");
  assert.ok(!JSON.stringify(m).includes(SUBX), "no subscription in the answer");
  assert.equal(mapEnd("@internet"), "@internet");
  assert.equal(mapEnd("@x"), null);
  assert.equal(mapEnd("10.0.0.4"), null, "an IP is no map end");
});

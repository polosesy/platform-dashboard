import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServiceTagIndex, isPrivateV4, lookupServiceTag } from "../src/services/azureServiceTags.js";
import { firewallRules, keyAuthOf, networkRulesOf, privateEndpointIps, subnetName } from "../src/services/azureEndpoints.js";
import { paasExposure, paasPath } from "../src/services/policyInsights.js";

// Synthetic prefixes (RFC 5737 documentation ranges) in the shape of the Service Tag Discovery API
const index = buildServiceTagIndex([
  { name: "AzureCloud", properties: { addressPrefixes: ["198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32"] } },
  { name: "AzureCloud.koreacentral", properties: { region: "koreacentral", addressPrefixes: ["198.51.100.0/25"] } },
  { name: "AzureActiveDirectory", properties: { addressPrefixes: ["198.51.100.128/25"] } },
  { name: "AzureResourceManager", properties: { addressPrefixes: ["203.0.113.0/24"] } },
  { name: "AzureResourceManager.KoreaCentral", properties: { region: "koreacentral", addressPrefixes: ["203.0.113.0/24"] } },
  { name: "AzureMonitor.KoreaCentral", properties: { region: "koreacentral", addressPrefixes: ["203.0.113.16/28"] } },
]);

test("service tags: a named service beats AzureCloud, the narrowest prefix wins, a regional tag breaks ties, IPv6 skipped", () => {
  assert.equal(lookupServiceTag(index, "198.51.100.130")?.service, "AzureActiveDirectory");
  const cloud = lookupServiceTag(index, "198.51.100.7")!;
  assert.deepEqual([cloud.service, cloud.tag, cloud.prefix], ["AzureCloud", "AzureCloud.koreacentral", "198.51.100.0/25"]);
  assert.equal(lookupServiceTag(index, "203.0.113.20")?.tag, "AzureMonitor.KoreaCentral");
  assert.equal(lookupServiceTag(index, "203.0.113.40")?.tag, "AzureResourceManager.KoreaCentral");
  assert.equal(lookupServiceTag(index, "192.0.2.1"), null);
  assert.equal(lookupServiceTag(index, "not-an-ip"), null);
  assert.ok(index.entries.every((e) => e.len <= 32));
});

test("private ranges: RFC 1918 and CGNAT are never the Internet", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.6.10", "100.64.0.1"]) assert.ok(isPrivateV4(ip), ip);
  for (const ip of ["172.32.0.1", "192.0.2.1", "100.128.0.1", "11.0.0.1"]) assert.ok(!isPrivateV4(ip), ip);
});

test("Private Endpoint IPs: PE → target joined through the NIC that carries privateEndpoint.id", () => {
  const m = privateEndpointIps(
    [{ peId: "/sub/pe-a", target: "/SUB/RG/MONGO" }, { peId: "/sub/pe-b", target: "/sub/rg/mongo" }, { peId: "/sub/pe-c", target: "" }],
    [{ pe: "/SUB/PE-A", ip: "10.0.3.6" }, { pe: "/sub/pe-b", ip: "10.0.3.7" }, { pe: "/sub/pe-b", ip: "" }],
  );
  assert.deepEqual([...m.entries()], [["/sub/rg/mongo", ["10.0.3.6", "10.0.3.7"]]]);
});

test("network rules and key auth: who else can reach the PaaS endpoint", () => {
  assert.equal(networkRulesOf("microsoft.cache/redisenterprise", {})?.noIpFirewall, true);
  const st = networkRulesOf("microsoft.storage/storageaccounts", { networkAcls: { defaultAction: "Deny", ipRules: [{ value: "192.0.2.1" }], virtualNetworkRules: [{ id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet-other/subnets/aks-nodes" }] } })!;
  assert.deepEqual([st.defaultAction, st.ipRules, st.vnetRules], ["Deny", 1, ["vnet-other/aks-nodes"]]);
  assert.equal(networkRulesOf("microsoft.documentdb/databaseaccounts", { ipRules: [] })?.defaultAction, "Allow", "Cosmos: no IP rule and no VNet filter = every network");
  assert.equal(networkRulesOf("microsoft.dbforpostgresql/flexibleservers", {}), null, "rules live in a child resource");
  assert.equal(firewallRules("microsoft.dbforpostgresql/flexibleservers", [{ properties: { startIpAddress: "192.0.2.1", endIpAddress: "192.0.2.1" } }]).defaultAction, "Deny");
  assert.equal(firewallRules("microsoft.dbforpostgresql/flexibleservers", [{ properties: { startIpAddress: "0.0.0.0", endIpAddress: "255.255.255.255" } }]).defaultAction, "Allow");
  assert.equal(firewallRules("microsoft.cache/redis", []).defaultAction, "Allow", "Azure Cache for Redis: no rule = every address");
  assert.equal(firewallRules("microsoft.documentdb/mongoclusters", []).defaultAction, "Deny");
  assert.equal(keyAuthOf("microsoft.storage/storageaccounts", {}), "on", "unset allowSharedKeyAccess = allowed");
  assert.equal(keyAuthOf("microsoft.eventhub/namespaces", { disableLocalAuth: true }), "off");
  assert.equal(keyAuthOf("microsoft.keyvault/vaults", {}), null);
  assert.equal(subnetName("/x/virtualNetworks/v1/subnets/s1"), "v1/s1");
});

test("exposure (configuration) and path (observed) are separate verdicts", () => {
  const deny = { defaultAction: "Deny" as const, ipRules: 1, vnetRules: null, source: "t" };
  assert.equal(paasExposure("Disabled", null), "closed");
  assert.equal(paasExposure("Enabled", deny), "restricted");
  assert.equal(paasExposure("Enabled", { ...deny, defaultAction: "Allow" }), "open");
  assert.equal(paasExposure("Enabled", { defaultAction: "Allow", ipRules: null, vnetRules: null, noIpFirewall: true, source: "t" }), "open");
  assert.equal(paasExposure("Enabled", null), "unknown", "rules not read is never open");
  assert.equal(paasExposure(null, deny), "unknown");
  assert.equal(paasPath(["10.0.3.5"]), "private");
  assert.equal(paasPath(["198.51.100.1"]), "public");
  assert.equal(paasPath(["10.0.3.5", "198.51.100.1"]), "mixed");
});

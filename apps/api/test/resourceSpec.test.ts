import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceSpec } from "../src/services/resourceSpec.js";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const msg = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;
const kv = (facts: Array<{ k: string; v: unknown }>) => Object.fromEntries(facts.map((f) => [f.k, f.v]));

test("PostgreSQL flexible server: SKU, tier, version, storage, HA, backup, access, delegated subnet", () => {
  const f = kv(resourceSpec("Microsoft.DBforPostgreSQL/flexibleServers", {
    sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
    properties: {
      version: "16", storage: { storageSizeGB: 128, autoGrow: "Enabled" }, highAvailability: { mode: "ZoneRedundant" },
      backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" },
      network: { publicNetworkAccess: "Disabled", delegatedSubnetResourceId: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/snet-psql" },
    },
  }));
  assert.deepEqual(f, { sku: "Standard_D2ds_v5", tier: "GeneralPurpose", version: "16", storageGb: 128, autoGrow: true, ha: "ZoneRedundant", backupDays: 14, geoBackup: false, publicAccess: false, delegatedSubnet: "snet-psql" });
});

test("AKS: version, tier, pools and nodes, network, private / Entra / local accounts", () => {
  const f = kv(resourceSpec("microsoft.containerservice/managedclusters", {
    sku: { name: "Base", tier: "Standard" },
    properties: {
      currentKubernetesVersion: "1.30.4",
      agentPoolProfiles: [{ count: 3, vmSize: "Standard_D4s_v5" }, { count: 2, vmSize: "Standard_D4s_v5" }],
      networkProfile: { networkPlugin: "azure", networkPluginMode: "overlay", networkDataplane: "cilium", outboundType: "userDefinedRouting" },
      apiServerAccessProfile: { enablePrivateCluster: true }, aadProfile: { managed: true, enableAzureRBAC: true }, disableLocalAccounts: true,
    },
  }));
  assert.deepEqual([f.kubernetesVersion, f.tier, f.pools, f.nodes, f.nodeSizes, f.networkPlugin, f.dataplane], ["1.30.4", "Standard", 2, 5, "Standard_D4s_v5", "azure overlay", "cilium"]);
  assert.deepEqual([f.privateCluster, f.entra, f.azureRbac, f.localAccounts], [true, true, true, false]);
});

test("Cosmos DB, Redis, Storage, Key Vault — and what Azure did not report is left out", () => {
  const cosmos = kv(resourceSpec("microsoft.documentdb/databaseaccounts", { kind: "MongoDB", properties: { consistencyPolicy: { defaultConsistencyLevel: "Session" }, locations: [{}, {}], capabilities: [{ name: "EnableServerless" }] } }));
  assert.deepEqual(cosmos, { api: "MongoDB", consistency: "Session", regions: 2, serverless: true });
  const redis = kv(resourceSpec("microsoft.cache/redis", { properties: { sku: { name: "Premium", family: "P", capacity: 1 }, redisVersion: "6.0", enableNonSslPort: false } }));
  assert.deepEqual(redis, { sku: "Premium P1", version: "6.0", nonSslPort: false });
  const st = kv(resourceSpec("microsoft.storage/storageaccounts", { sku: { name: "Standard_ZRS" }, kind: "StorageV2", properties: { accessTier: "Hot", allowBlobPublicAccess: false } }));
  assert.deepEqual(st, { sku: "Standard_ZRS", kind: "StorageV2", accessTier: "Hot", blobPublicAccess: false });
  const kvlt = kv(resourceSpec("microsoft.keyvault/vaults", { properties: { sku: { name: "standard" }, enableRbacAuthorization: true } }));
  assert.deepEqual(kvlt, { sku: "standard", rbac: true, purgeProtection: false }, "purge protection off when absent (Azure omits false)");
  assert.deepEqual(resourceSpec("microsoft.unknown/things", {}), []);
});

test("every fact key the extractor can produce has a ko / en label", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/services/resourceSpec.ts"), "utf8");
  const keys = new Set([...src.matchAll(/\["([a-zA-Z]+)", /g)].map((m) => m[1]!));
  assert.ok(keys.size > 60, `found ${keys.size}`);
  for (const k of keys) assert.ok(msg.T[`ld.spec.${k}`]?.ko && msg.T[`ld.spec.${k}`]?.en, `ld.spec.${k}`);
});

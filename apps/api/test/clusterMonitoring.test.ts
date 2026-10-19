// A cluster's managed Prometheus workspace comes from its own data collection rule associations — never "the first
// workspace in the subscription" (stg read prd's workspace that way).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterMonitorAccounts, dcrIdsOf, monitorAccountsOf } from "../src/services/clusterMonitoring.js";
import type { ArmFetcher } from "../src/infra/azureClientFactory.js";

const S = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups";
const STG = `${S}/rg-mon/providers/Microsoft.Monitor/accounts/amw-stg`;
const PRD = `${S}/rg-mon/providers/Microsoft.Monitor/accounts/amw-prd`;
const DCR = `${S}/rg-mon/providers/Microsoft.Insights/dataCollectionRules/dcr-stg-prom`;
const CLUSTER = `${S}/rg-aks/providers/Microsoft.ContainerService/managedClusters/aks-stg`;

test("rule ids and workspace ids: unique, lower-case, ARM ids only", () => {
  assert.deepEqual(dcrIdsOf([{ properties: { dataCollectionRuleId: DCR } }, { properties: { dataCollectionRuleId: DCR.toUpperCase() } }, { properties: {} }, { properties: { dataCollectionRuleId: "https://evil.example/x" } }]), [DCR.toLowerCase()]);
  assert.deepEqual(monitorAccountsOf([{ properties: { destinations: { monitoringAccounts: [{ accountResourceId: STG }, { accountResourceId: "not-an-id" }] } } }]), [STG.toLowerCase()]);
});

test("two workspaces in one subscription: the cluster gets the one its rule writes to", async () => {
  const calls: string[] = [];
  const fetcher = {
    fetchJson: async (url: string) => {
      calls.push(url);
      if (url.includes("/dataCollectionRuleAssociations")) return { value: [{ properties: { dataCollectionRuleId: DCR } }] };
      if (url.toLowerCase().startsWith(`https://management.azure.com${DCR.toLowerCase()}`)) return { properties: { destinations: { monitoringAccounts: [{ accountResourceId: STG }] } } };
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as ArmFetcher;
  assert.deepEqual(await clusterMonitorAccounts(fetcher, CLUSTER), [STG.toLowerCase()]);
  assert.ok(!calls.some((u) => u.includes("/providers/Microsoft.Monitor/accounts?")), "no subscription-wide workspace listing");
  assert.ok(!(await clusterMonitorAccounts(fetcher, CLUSTER)).includes(PRD.toLowerCase()));
});

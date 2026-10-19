// Which Azure Monitor workspace (managed Prometheus) belongs to an AKS cluster — by the cluster's own data collection
// rule associations (DCRA → DCR → destinations.monitoringAccounts), never "the first workspace in the subscription":
// with stg and prd workspaces in one subscription that read the other environment's metrics, and a workspace in a
// separate monitoring subscription was never found. Pure part tested from apps/api/test/clusterMonitoring.test.ts.
import type { ArmFetcher } from "../infra/azureClientFactory.js";
import { debug } from "../infra/logger.js";

type Dcra = { properties?: { dataCollectionRuleId?: string } };
type Dcr = { properties?: { destinations?: { monitoringAccounts?: Array<{ accountResourceId?: string }> } } };

const ARM = "https://management.azure.com";
const isArmId = (id: unknown): id is string => typeof id === "string" && /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\//i.test(id);

/** Pure: data collection rule ids from a cluster's associations (unique, lower-case, ARM ids only) */
export function dcrIdsOf(associations: Dcra[]): string[] {
  return [...new Set(associations.map((a) => a.properties?.dataCollectionRuleId).filter(isArmId).map((x) => x.toLowerCase()))].sort();
}

/** Pure: Azure Monitor workspace ids a set of rules sends metrics to (unique, lower-case) */
export function monitorAccountsOf(dcrs: Dcr[]): string[] {
  const out = new Set<string>();
  for (const d of dcrs) for (const m of d.properties?.destinations?.monitoringAccounts ?? []) if (isArmId(m.accountResourceId)) out.add(m.accountResourceId.toLowerCase());
  return [...out].sort();
}

/**
 * The cluster's Azure Monitor workspaces: its DCR associations → each rule → its monitoring-account destinations.
 * A rule that cannot be read is skipped (the caller says "unknown", never another workspace).
 */
export async function clusterMonitorAccounts(fetcher: ArmFetcher, clusterId: string): Promise<string[]> {
  const assoc = await fetcher.fetchJson<{ value?: Dcra[] }>(`${ARM}${clusterId}/providers/Microsoft.Insights/dataCollectionRuleAssociations?api-version=2022-06-01`);
  const rules = await Promise.all(dcrIdsOf(assoc.value ?? []).map((id) =>
    fetcher.fetchJson<Dcr>(`${ARM}${id}?api-version=2022-06-01`).catch((e) => { debug(`[amw] rule not read: ${String(e).slice(0, 120)}`); return null; })));
  return monitorAccountsOf(rules.filter((r): r is Dcr => !!r));
}

/** The workspace's Prometheus query endpoint, or null */
export async function prometheusQueryEndpoint(fetcher: ArmFetcher, accountId: string): Promise<string | null> {
  const ws = await fetcher.fetchJson<{ properties?: { metrics?: { prometheusQueryEndpoint?: string } } }>(`${ARM}${accountId}?api-version=2023-04-03`);
  const ep = ws.properties?.metrics?.prometheusQueryEndpoint;
  return typeof ep === "string" && /^https:\/\/[a-z0-9.-]+\.prometheus\.monitor\.azure\.com\/?$/i.test(ep) ? ep : null;
}

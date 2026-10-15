// Application Gateway for Containers (microsoft.servicenetworking/trafficcontrollers): its child resources folded
// into the parent, and which AKS cluster it serves. Pure — tested from apps/api/test/frontDoor.test.ts.
// Catalog rows AGC-01..05. Learn: components https://learn.microsoft.com/azure/application-gateway/for-containers/application-gateway-for-containers-components
// · networking https://learn.microsoft.com/azure/application-gateway/for-containers/container-networking

export type AgcChildRow = { id: string; type?: string; properties?: Record<string, unknown> };
export type AgcFacts = {
  associations: Array<{ name: string; subnetId?: string; state?: string }>;
  frontends: Array<{ name: string; fqdn?: string; public: boolean; state?: string }>;
  wafPolicyId?: string;
};

const parentOf = (id: string) => id.toLowerCase().split("/").slice(0, 9).join("/");
const nameOf = (id: string) => id.split("/").pop() ?? "";

/** associations / frontends / securityPolicies rows → facts per traffic controller id (lower-case) */
export function agcFacts(rows: AgcChildRow[]): Map<string, AgcFacts> {
  const out = new Map<string, AgcFacts>();
  const get = (id: string) => out.get(id) ?? out.set(id, { associations: [], frontends: [] }).get(id)!;
  for (const r of rows) {
    const t = (r.type ?? "").toLowerCase(), p = r.properties ?? {};
    const f = get(parentOf(r.id));
    if (t.endsWith("/associations")) {
      const subnetId = (p.subnet as { id?: string } | undefined)?.id?.toLowerCase();
      f.associations.push({ name: nameOf(r.id), ...(subnetId ? { subnetId } : {}), state: String(p.provisioningState ?? "") || undefined });
    } else if (t.endsWith("/frontends")) {
      // A frontend is public unless it says publicNetworkAccess Disabled (private frontends are newer)
      f.frontends.push({ name: nameOf(r.id), fqdn: String(p.fqdn ?? "").toLowerCase() || undefined, public: String(p.publicNetworkAccess ?? "Enabled") !== "Disabled", state: String(p.provisioningState ?? "") || undefined });
    } else if (t.endsWith("/securitypolicies")) {
      const waf = (p.wafPolicy as { id?: string } | undefined)?.id;
      if (waf) f.wafPolicyId = waf.toLowerCase();
    }
  }
  return out;
}

export type AgcCluster =
  | { targetId: string; evidence: "nodeRg" | "sameVnet" }
  | { candidates: number };

/**
 * The AKS cluster behind an AGC (AGC-04), first match:
 * (a) the AGC sits in the node resource group of exactly one cluster whose agent pools are in the association's VNet
 *     — a managed ALB deployment creates it there → nodeRg (configuration-strong);
 * (b) exactly one cluster has agent pools in that VNet — AGC reaches pods in the same VNet → sameVnet (weaker,
 *     drawn dashed);
 * otherwise no line: `candidates` clusters in that VNet (0 = none / another VNet).
 */
export function resolveAgcCluster(
  agc: { resourceGroup: string; vnetIds: ReadonlySet<string> },
  clusters: ReadonlyArray<{ id: string; nodeResourceGroup?: string; vnetIds: ReadonlySet<string> }>,
): AgcCluster {
  const inVnet = clusters.filter((c) => [...c.vnetIds].some((v) => agc.vnetIds.has(v)));
  const byRg = inVnet.filter((c) => (c.nodeResourceGroup ?? "").toLowerCase() === agc.resourceGroup.toLowerCase());
  if (byRg.length === 1) return { targetId: byRg[0]!.id, evidence: "nodeRg" };
  if (inVnet.length === 1) return { targetId: inVnet[0]!.id, evidence: "sameVnet" };
  return { candidates: inVnet.length };
}

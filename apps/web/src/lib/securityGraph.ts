// AKS 보안 점검 › 그래프 탐색 (보안 고도화 P5, pure) — the facts the other views already hold, joined per workload into
// one graph: exposure · image · runtime · Kubernetes permissions · Azure identity (workload identity + IMDS path) ·
// network · the Azure resources it talks to (their public access, key auth, Defender recommendations) · GitOps. A question is an AND of conditions; each condition answers yes / no / unknown for a workload, with
// the evidence grade it rests on. Unknown is never "no": a workload with no "no" but an unknown is listed apart
// ("can't tell"), so missing data never hides a match nor invents one.

import type { EvidenceKind, NetNode, PolicyInsightsResponse, WiIdentity, WiRoleAssignment, WorkloadIdentityResponse, WorkloadRiskRow } from "@aud/types";

export type FactState = "yes" | "no" | "unknown";
/** `detail`: what was found (yes) or why it can't be told (unknown) — message keys + values, rendered by the view */
export type Fact = { state: FactState; ev: EvidenceKind; detail?: string; reason?: UnknownReason };
export type UnknownReason = "wiNotLoaded" | "rolesNotRead" | "imdsUnknown" | "vulnNoSource" | "vulnNotScanned" | "networkUnavailable"
  | "paasConfigUnknown" | "defenderUnknown";

export const CONDITIONS = [
  { key: "exposed", group: "exposure" },
  { key: "exposedPublic", group: "exposure" },
  { key: "vulnSevere", group: "image" },
  { key: "vulnExploited", group: "image" },
  { key: "weakRuntime", group: "runtime" },
  { key: "hostAccess", group: "runtime" },
  { key: "tokenMounted", group: "k8s" },
  { key: "rbacSecrets", group: "k8s" },
  { key: "rbacTakeover", group: "k8s" },
  { key: "azureIdentity", group: "azure" },
  { key: "imdsIdentity", group: "azure" },
  { key: "keyVaultRole", group: "azure" },
  { key: "storageWriteRole", group: "azure" },
  { key: "unusedRole", group: "azure" },
  { key: "rolePrivileged", group: "azure" },
  { key: "roleBroad", group: "azure" },
  { key: "noEgressPolicy", group: "network" },
  { key: "egressExternal", group: "network" },
  { key: "talksKeyVault", group: "network" },
  { key: "talksStorage", group: "network" },
  { key: "paasOpen", group: "paas" },
  { key: "paasPublicPath", group: "paas" },
  { key: "paasKeyAuth", group: "paas" },
  { key: "paasDefenderHigh", group: "paas" },
  { key: "gitops", group: "ops" },
] as const;
export type CondKey = (typeof CONDITIONS)[number]["key"];
export type CondGroup = (typeof CONDITIONS)[number]["group"];
export const COND_GROUPS: CondGroup[] = ["exposure", "image", "runtime", "k8s", "azure", "network", "paas", "ops"];
const KEYS = new Set<string>(CONDITIONS.map((c) => c.key));

/** Questions people ask first (Wiz-style toxic combinations, phrased as conditions) */
export const PRESETS: Array<{ id: string; keys: CondKey[] }> = [
  { id: "exposedVulnerable", keys: ["exposed", "vulnSevere"] },
  { id: "secretsToKeyVault", keys: ["rbacSecrets", "talksKeyVault"] },
  { id: "imdsKeyVault", keys: ["imdsIdentity", "keyVaultRole"] },
  { id: "takeoverWeakRuntime", keys: ["rbacTakeover", "tokenMounted", "weakRuntime"] },
  { id: "exposedNoEgress", keys: ["exposed", "noEgressPolicy", "egressExternal"] },
  { id: "unusedAzurePermission", keys: ["unusedRole"] },
  { id: "vulnerableToWeakPaas", keys: ["vulnSevere", "paasDefenderHigh"] },
  { id: "exposedPrivileged", keys: ["exposed", "rolePrivileged"] },
];

/** One reachable Azure identity of a workload — by workload identity (FIC) or by the node pool's IMDS */
export type ReachIdentity = { id: string; name: string; via: "wi" | "imds"; roles: WiRoleAssignment[]; rolesRead: boolean };

export type GraphWorkload = {
  /** Insights row id "namespace/name" */
  id: string;
  namespace: string;
  name: string;
  kind: string;
  managed: boolean;
  facts: Record<CondKey, Fact>;
  identities: ReachIdentity[];
  /** Azure PaaS it was observed talking to, with what is known about each */
  paas: GraphPaas[];
  /** Risk combinations it is part of */
  issueIds: string[];
};

export type GraphPaas = Pick<NetNode, "label" | "path" | "exposure" | "keyAuth" | "defender"> & { type: string };

const BROAD = new Set(["root", "managementGroup", "subscription"]);

const yes = (ev: EvidenceKind, detail?: string): Fact => ({ state: "yes", ev, ...(detail ? { detail } : {}) });
const no = (ev: EvidenceKind): Fact => ({ state: "no", ev });
const unknown = (reason: UnknownReason): Fact => ({ state: "unknown", ev: "unk", reason });
const has = (row: WorkloadRiskRow, k: keyof WorkloadRiskRow["cells"]) => !!row.cells[k];
const roleText = (r: WiRoleAssignment) => `${r.roleName} @ ${r.scope.label}`;

/** Identities a workload can obtain a token for: its service account's federated identity, and the IMDS path of its node pools */
function reachable(row: WorkloadRiskRow, wi: WorkloadIdentityResponse): { list: ReachIdentity[]; imdsKnown: boolean } {
  const wid = `w:${row.namespace}/${row.kind}/${row.name}`;
  const byId = new Map<string, WiIdentity>(wi.identities.map((i) => [i.id, i]));
  const out: ReachIdentity[] = [];
  const add = (i: WiIdentity | undefined, via: ReachIdentity["via"]) => {
    if (!i || out.some((x) => x.id === i.id && x.via === via)) return;
    out.push({ id: i.id, name: i.name ?? i.clientIdTail, via, roles: i.roles, rolesRead: i.rolesStatus === "ok" });
  };
  const w = wi.workloads.find((x) => x.id === wid);
  const sa = w ? wi.serviceAccounts.find((s) => s.id === w.saId) : undefined;
  if (sa?.identityId) add(byId.get(sa.identityId), "wi");
  const pools = w?.pools ?? wi.otherWorkloads.find((x) => x.id === wid)?.pools ?? [];
  if (wi.imds.podAccess !== "restricted") for (const i of wi.identities) if (i.pools?.some((p) => pools.includes(p))) add(i, "imds");
  return { list: out, imdsKnown: wi.imds.podAccess !== null && wi.imds.pools === "ok" };
}

/** Every workload's facts. `wi` undefined/null = the workload identity view was not read (its conditions are unknown). */
export function buildGraph(insights: PolicyInsightsResponse, wi?: WorkloadIdentityResponse | null): GraphWorkload[] {
  const net = insights.network;
  const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
  const scanned = new Set((insights.vulns?.byImage ?? []).map((v) => v.image));
  return insights.rows.map((row) => {
    const paas = net.edges
      .filter((e) => e.from === row.id && e.count > e.dropped) // only dropped = never left (same rule as the network map)
      .map((e) => nodeById.get(e.to))
      .filter((n) => n?.kind === "paas")
      .map((n) => ({ label: n!.label, type: n!.azureType ?? "", path: n!.path, exposure: n!.exposure, keyAuth: n!.keyAuth, defender: n!.defender }));
    const talks = (re: RegExp): Fact => (!net.available ? unknown("networkUnavailable")
      : paas.some((p) => re.test(p.type)) ? yes("obs", paas.filter((p) => re.test(p.type)).map((p) => p.label).join(", ")) : no("obs"));
    // A property of the PaaS it talks to: yes on any hit; else unknown when some target's value is not known; else no
    const onPaas = (hit: (p: GraphPaas) => boolean, known: (p: GraphPaas) => boolean, ev: EvidenceKind, reason: UnknownReason, text: (p: GraphPaas) => string = (p) => p.label): Fact => {
      if (!net.available) return unknown("networkUnavailable");
      const hits = paas.filter(hit);
      if (hits.length) return yes(ev, hits.map(text).join(", "));
      return paas.some((p) => !known(p)) ? unknown(reason) : no(ev);
    };
    const vulnFact = (match: boolean): Fact => (match ? yes("cfg", row.cells.vuln)
      : !insights.vulns ? unknown("vulnNoSource")
        : row.images.some((i) => scanned.has(i)) ? no("cfg") : unknown("vulnNotScanned"));

    const reach = wi ? reachable(row, wi) : null;
    const viaWi = reach?.list.filter((x) => x.via === "wi") ?? [];
    const viaImds = reach?.list.filter((x) => x.via === "imds") ?? [];
    const azure = (pick: (r: WiRoleAssignment) => boolean, from: ReachIdentity[], ev: EvidenceKind = "cfg"): Fact => {
      if (!wi || !reach) return unknown("wiNotLoaded");
      const hits = from.flatMap((i) => i.roles.filter(pick).map((r) => `${i.name} (${i.via === "wi" ? "WI" : "IMDS"}): ${roleText(r)}`));
      if (hits.length) return yes(ev, hits.slice(0, 4).join(" · ") + (hits.length > 4 ? ` +${hits.length - 4}` : ""));
      return from.some((i) => !i.rolesRead) ? unknown("rolesNotRead") : no(ev);
    };
    const imdsFact = (): Fact => {
      if (!wi || !reach) return unknown("wiNotLoaded");
      const withRoles = viaImds.filter((i) => i.roles.length);
      if (withRoles.length) return yes(reach.imdsKnown ? "cfg" : "unk", withRoles.map((i) => `${i.name}: ${i.roles.length}`).join(" · "));
      return reach.imdsKnown || wi.imds.podAccess === "restricted" ? no("cfg") : unknown("imdsUnknown");
    };
    const keys = row.rbacKeys ?? [];
    const facts: Record<CondKey, Fact> = {
      exposed: has(row, "exposure") ? yes("cfg", row.cells.exposure) : no("cfg"),
      exposedPublic: row.weights.exposure === "crit" ? yes("cfg", row.cells.exposure) : no("cfg"),
      vulnSevere: vulnFact(row.weights.vuln === "crit" || row.weights.vuln === "warn"),
      vulnExploited: vulnFact(row.weights.vuln === "crit"),
      weakRuntime: has(row, "root") || has(row, "privEsc") ? yes("cfg", [row.cells.root, row.cells.privEsc].filter(Boolean).join(" · ")) : no("cfg"),
      hostAccess: has(row, "host") ? yes("cfg", row.cells.host) : no("cfg"),
      tokenMounted: has(row, "automount") ? yes("cfg", row.cells.automount) : no("cfg"),
      rbacSecrets: keys.some((k) => k === "secrets" || k === "clusterAdmin" || k === "wildcard") ? yes("perm", row.cells.highRbac) : no("perm"),
      rbacTakeover: row.weights.highRbac === "crit" ? yes("perm", row.cells.highRbac) : no("perm"),
      azureIdentity: azure(() => true, viaWi),
      imdsIdentity: imdsFact(),
      keyVaultRole: azure((r) => r.data?.svc === "keyVault", reach?.list ?? []),
      storageWriteRole: azure((r) => r.data?.svc === "storage" && r.data.write, reach?.list ?? []),
      unusedRole: azure((r) => r.usage?.state === "unused", reach?.list ?? [], "obs"),
      noEgressPolicy: has(row, "noEgress") ? yes("cfg") : no("cfg"),
      egressExternal: !net.available ? unknown("networkUnavailable") : has(row, "extEgress") ? yes("obs", row.cells.extEgress) : no("obs"),
      talksKeyVault: talks(/vault/i),
      talksStorage: talks(/storage/i),
      rolePrivileged: azure((r) => r.privileged !== null, reach?.list ?? []),
      roleBroad: azure((r) => BROAD.has(r.scope.level), reach?.list ?? []),
      paasOpen: onPaas((p) => p.exposure === "open", (p) => !!p.exposure && p.exposure !== "unknown", "cfg", "paasConfigUnknown"),
      paasPublicPath: onPaas((p) => p.path === "public" || p.path === "mixed", () => true, "obs", "paasConfigUnknown", (p) => `${p.label} (${p.path})`),
      paasKeyAuth: onPaas((p) => p.keyAuth === "on", (p) => p.keyAuth === "off", "cfg", "paasConfigUnknown"),
      paasDefenderHigh: onPaas((p) => p.defender?.state === "ok" && p.defender.high > 0, (p) => p.defender?.state === "ok", "cfg", "defenderUnknown",
        (p) => `${p.label}: High ${p.defender?.state === "ok" ? p.defender.high : 0}`),
      gitops: row.source ? yes("cfg", `Argo CD ${row.source.app}`) : no("cfg"),
    };
    return {
      id: row.id, namespace: row.namespace, name: row.name, kind: row.kind, managed: row.managed, facts,
      identities: reach?.list ?? [], paas, issueIds: [...new Set(row.combos.map((c) => c.issueId).filter((x): x is string => !!x))],
    };
  });
}

export type QueryResult = { matches: GraphWorkload[]; maybe: GraphWorkload[]; total: number };

/** AND of the conditions: all yes = match; no "no" but some unknown = can't tell; any "no" = out */
export function runQuery(graph: GraphWorkload[], keys: CondKey[], opts: { includeManaged?: boolean } = {}): QueryResult {
  const pool = graph.filter((w) => opts.includeManaged || !w.managed);
  if (!keys.length) return { matches: [], maybe: [], total: pool.length };
  const matches: GraphWorkload[] = [], maybe: GraphWorkload[] = [];
  for (const w of pool) {
    const states = keys.map((k) => w.facts[k].state);
    if (states.includes("no")) continue;
    (states.every((s) => s === "yes") ? matches : maybe).push(w);
  }
  const order = (a: GraphWorkload, b: GraphWorkload) => b.issueIds.length - a.issueIds.length || a.id.localeCompare(b.id);
  return { matches: matches.sort(order), maybe: maybe.sort(order), total: pool.length };
}

/** "exposed.vulnSevere" ⇄ ["exposed","vulnSevere"] — unknown keys dropped, order kept, no duplicates */
export const encodeQuery = (keys: CondKey[]) => keys.join(".");
export function decodeQuery(s: string | null | undefined): CondKey[] {
  return [...new Set((s ?? "").split(".").filter((k) => KEYS.has(k)))] as CondKey[];
}

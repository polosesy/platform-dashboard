// Integrated risk — joins three existing responses (Defender posture, the subscription graph, cluster
// policy insights) on evidence only. Pure: no React, no "@/" aliases (unit-tested from apps/api/test).
//
// Rules
// - A key is (resource group, ARM type, name), lowercase, with GUIDs masked the way the API masks Defender
//   names ("…abcd"). A link needs exactly one graph node with that key; 2+ is counted as ambiguous, 0 as no match.
//   Name-only, partial or guessed-type matches never link.
// - Without the provider ("vaults" could be Key Vault or Recovery Services) colliding types are not linked.
// - Absorbed nodes count for their tile only when the absorption is 1:1 (NIC → VM, scale set → AKS,
//   public IP → owner). NSGs are absorbed into the first association only, so they never link.
// - Unknown stays unknown: a shared public IP or an LB with no rule data is an "unk" link — never coloured as risk
//   and never counted in the summary numbers.
// - No ARM or subscription IDs in the result. The only GUIDs are recommendation keys — Defender assessment
//   definition IDs, identical in every tenant, not identifiers of the customer's resources.

import type {
  ArchitectureGraph,
  EvidenceKind,
  PolicyInsightsResponse,
  PostureDomain,
  PostureSeverity,
  SecurityPostureResponse,
} from "@aud/types";
import { buildArchModel, type ArchModel } from "./archModel";
import { maskGuids } from "./mask";

export type RiskRelation = "cluster" | "nodepool" | "egress" | "entry" | "backend";
export type RiskLink = { rel: RiskRelation; ev: EvidenceKind };
export type RiskRec = { key: string; title: string; severity: PostureSeverity; domain: PostureDomain };
export type RiskAlert = { id: string; title: string; severity: string; intent?: string };
export type RiskIssueRef = { id: string; title: string; sev: "crit" | "warn" };

export type RiskRow = {
  /** Stable React key (masked, no IDs) */
  key: string;
  name: string;
  /** Graph node kind (aks, lb, keyVault, …) */
  kind: string;
  resourceGroup: string;
  links: RiskLink[];
  recs: RiskRec[];
  alerts: RiskAlert[];
  issues: RiskIssueRef[];
  /** Internet entry from configuration: cfg = public IP with inbound rules, unk = public IP, rules unknown */
  internet: "cfg" | "unk" | null;
  /** Every link is "unk" — listed apart, not counted */
  uncertain: boolean;
};

export type RiskGap = "recommendations" | "alerts" | "hubble" | "azureMatch" | "clusterNotInGraph" | "insightsPartial";

export type IntegratedRisk = {
  mode: "live" | "sample";
  rows: RiskRow[];
  stats: {
    /** Cluster risk issues (combinations + local accounts) */
    issues: number;
    /** Azure resources linked to the cluster with evidence (cluster row excluded) */
    linkedAssets: number;
    /** Distinct High recommendations on linked resources — a lower bound (Defender lists ≤5 samples) */
    highRecs: number;
    /** Distinct active alerts on the cluster, its node pools or an LB/App Gateway with inbound rules to it */
    linkedAlerts: number;
  };
  coverage: {
    /** Recommendations with more unhealthy resources than samples — the rest is not known */
    truncatedRecs: number;
    /** ARM samples (resource group known) and how many matched exactly one graph node */
    armSamples: number;
    matchedSamples: number;
    /** Samples that cannot be joined (Entra users, subscriptions, …) */
    nonArmSamples: number;
    /** Keys with 2+ graph candidates, or a colliding type without provider */
    ambiguous: number;
  };
  unlinked: {
    /** High recommendations with no sample on a linked resource */
    highRecs: number;
    /** Cluster issues that do not reach any Azure resource */
    issues: number;
    /** Active alerts on nothing linked */
    alerts: number;
    /** Egress targets not found in this subscription's graph (other subscription, name mismatch, RG unknown) */
    egressTargets: number;
  };
  gaps: RiskGap[];
};

export type RiskJoinInput = {
  posture: SecurityPostureResponse;
  graph: ArchitectureGraph;
  insights: PolicyInsightsResponse;
  /** Selected cluster's ARM ID (from the cluster list) */
  clusterArmId: string;
};

const lower = (s: string) => s.toLowerCase();
const norm = (s: string) => lower(maskGuids(s));

/** Last-segment types shared by several providers — without the provider they are ambiguous */
const COLLIDING = new Set(["vaults", "servers", "flexibleservers", "namespaces", "workspaces", "accounts", "databases", "registries"]);
/** Absorptions that are 1:1 (NSGs are absorbed into one of possibly many associations) */
const ONE_TO_ONE = new Set(["nic", "vmss", "publicIP"]);

/** rg / full type / last type / name of an ARM ID, or null for non-resource IDs */
export function armParts(id: string): { rg: string; full: string; last: string; name: string } | null {
  const parts = id.trim().split("/");
  const lo = parts.map(lower);
  const rgIdx = lo.indexOf("resourcegroups");
  const provIdx = lo.lastIndexOf("providers");
  if (rgIdx < 0 || provIdx < 0 || parts.length - provIdx < 4) return null;
  const rg = parts[rgIdx + 1] ?? "";
  const name = parts[parts.length - 1] ?? "";
  if (!rg || !name) return null;
  const full = [lo[provIdx + 1], ...lo.slice(provIdx + 2).filter((_, i) => i % 2 === 0)].join("/");
  return { rg, full, last: lo[parts.length - 2]!, name };
}

type Index = { full: Map<string, string[]>; last: Map<string, string[]> };
type Lookup =
  | { status: "matched"; node: string; tile: string | null; via: string | null }
  | { status: "ambiguous" | "none" | "unlinkable" };

function buildIndex(graph: ArchitectureGraph): Index {
  const full = new Map<string, string[]>();
  const last = new Map<string, string[]>();
  const put = (m: Map<string, string[]>, k: string, id: string) => { const a = m.get(k); if (a) { if (!a.includes(id)) a.push(id); } else m.set(k, [id]); };
  for (const n of graph.nodes) {
    const p = armParts(n.azureId ?? n.id);
    if (!p) continue;
    const id = lower(n.id);
    put(full, `${norm(p.rg)}|${p.full}|${norm(p.name)}`, id);
    put(last, `${norm(p.rg)}|${p.last}|${norm(p.name)}`, id);
  }
  return { full, last };
}

/** The tile a graph node is drawn as: itself, or its 1:1 owner */
function tileOf(model: ArchModel, id: string): { tile: string | null; via: string | null } {
  if (model.resources.has(id)) return { tile: id, via: null };
  const acc = model.accounting.get(id);
  const kind = model.nodes.get(id)?.kind ?? "";
  if (acc?.as === "absorbed" && acc.into && model.resources.has(acc.into) && ONE_TO_ONE.has(kind)) return { tile: acc.into, via: kind };
  return { tile: null, via: null };
}

function lookup(ix: Index, model: ArchModel, ref: { name: string; resourceGroup: string; type: string; armType?: string }): Lookup {
  if (!ref.resourceGroup || !ref.name) return { status: "unlinkable" };
  const rg = norm(ref.resourceGroup);
  const name = norm(ref.name);
  let cands: string[] | undefined;
  if (ref.armType && ref.armType.includes("/")) cands = ix.full.get(`${rg}|${lower(ref.armType)}|${name}`);
  else {
    const t = lower(ref.armType || ref.type);
    if (COLLIDING.has(t)) return { status: "ambiguous" };
    cands = ix.last.get(`${rg}|${t}|${name}`);
  }
  if (!cands?.length) return { status: "none" };
  if (cands.length > 1) return { status: "ambiguous" };
  const node = cands[0]!;
  return { status: "matched", node, ...tileOf(model, node) };
}

const INGRESS = new Set(["ingress", "exposure"]);
const ENTRY_KINDS = new Set(["lb", "appGateway"]);
const SEV_ORDER: Record<PostureSeverity, number> = { High: 0, Medium: 1, Low: 2 };

export function joinRisk(input: RiskJoinInput): IntegratedRisk {
  const { posture, graph, insights } = input;
  const gaps: RiskGap[] = [];
  if (posture.gaps.some((g) => g.section === "recommendations")) gaps.push("recommendations");
  if (posture.gaps.some((g) => g.section === "alerts")) gaps.push("alerts");
  const hubbleGap = !insights.network.available || insights.gaps.some((g) => /^hubble/i.test(g));
  const azureGap = !insights.network.azureMatched || insights.gaps.some((g) => /^azure/i.test(g));
  if (hubbleGap) gaps.push("hubble");
  if (azureGap) gaps.push("azureMatch");

  const empty: IntegratedRisk = {
    mode: "sample",
    rows: [],
    stats: { issues: 0, linkedAssets: 0, highRecs: 0, linkedAlerts: 0 },
    coverage: { truncatedRecs: 0, armSamples: 0, matchedSamples: 0, nonArmSamples: 0, ambiguous: 0 },
    unlinked: { highRecs: 0, issues: 0, alerts: 0, egressTargets: 0 },
    gaps: [],
  };
  // Sample data on either side would join invented names — show nothing rather than a fake link
  if (posture.source === "mock" || graph.source === "mock") return empty;

  const model = buildArchModel(graph);
  const ix = buildIndex(graph);
  const aksId = lower(input.clusterArmId);
  const aksTile = model.resources.has(aksId) && model.resources.get(aksId)!.node.kind === "aks" ? aksId : null;
  if (!aksTile) gaps.push("clusterNotInGraph");
  const otherGaps = insights.gaps.filter((g) => !/^(hubble|azure)/i.test(g));
  if (otherGaps.length) gaps.push("insightsPartial");

  type Builder = RiskRow & { recKeys: Set<string>; alertIds: Set<string>; issueIds: Set<string> };
  const rows = new Map<string, Builder>();
  const row = (tile: string): Builder => {
    let r = rows.get(tile);
    if (!r) {
      const n = model.resources.get(tile)!.node;
      const p = armParts(n.azureId ?? n.id);
      r = {
        key: `${norm(n.resourceGroup ?? p?.rg ?? "")}|${n.kind}|${norm(n.name)}`,
        name: maskGuids(n.name), kind: n.kind, resourceGroup: maskGuids(n.resourceGroup ?? p?.rg ?? ""),
        links: [], recs: [], alerts: [], issues: [], internet: null, uncertain: false,
        recKeys: new Set(), alertIds: new Set(), issueIds: new Set(),
      };
      rows.set(tile, r);
    }
    return r;
  };
  const link = (r: Builder, rel: RiskRelation, ev: EvidenceKind) => {
    const same = r.links.find((l) => l.rel === rel);
    if (!same) r.links.push({ rel, ev });
    else if (same.ev === "unk" && ev !== "unk") same.ev = ev; // stronger evidence wins
  };
  const addIssue = (r: Builder, i: { id: string; title: string; sev: "crit" | "warn" }) => {
    if (!r.issueIds.has(i.id)) { r.issueIds.add(i.id); r.issues.push({ id: i.id, title: i.title, sev: i.sev }); }
  };

  // R1 — the cluster itself (ID match) carries every cluster issue
  if (aksTile) {
    const r = row(aksTile);
    link(r, "cluster", "cfg");
    for (const i of insights.issues) addIssue(r, i);
  }

  // R2 — PaaS the pods were observed talking to (Hubble + public DNS IP match)
  let egressTargets = 0;
  const egressIssues = new Set<string>();
  const netById = new Map(insights.network.nodes.map((n) => [n.id, n]));
  for (const res of insights.containment.resources) {
    const m = lookup(ix, model, { name: res.name, resourceGroup: res.resourceGroup, type: res.armType.split("/").pop() ?? "", armType: res.armType });
    if (m.status !== "matched" || !m.tile) { egressTargets++; continue; }
    const r = row(m.tile);
    const shared = (netById.get(res.id)?.sharedIpWith?.length ?? 0) > 0;
    link(r, "egress", shared ? "unk" : "obs");
    for (const i of insights.issues) {
      if (i.nodes.some((n) => n.refs.includes(res.id))) { addIssue(r, i); if (!shared) egressIssues.add(i.id); }
    }
  }

  // R3 — load balancers / application gateways whose backend is the cluster's node pools
  if (aksTile) {
    for (const e of model.edges) {
      if (e.kind !== "routes" || e.target !== aksTile) continue;
      const src = model.resources.get(e.source);
      if (!src || !ENTRY_KINDS.has(src.node.kind)) continue;
      const inbound = src.node.metadata?.inboundRules;
      const r = row(e.source);
      // Rules known: >0 is an inbound path, 0 is pool membership only (e.g. the AKS outbound SNAT pool)
      if (typeof inbound === "number") link(r, inbound > 0 ? "entry" : "backend", "cfg");
      else link(r, "entry", "unk");
    }
  }

  // R4 — internet entry from configuration, as a property of rows only
  for (const [tile, r] of rows) {
    if (!model.edges.some((e) => INGRESS.has(e.kind) && e.target === tile)) continue;
    const n = model.resources.get(tile)!.node;
    if (!ENTRY_KINDS.has(n.kind)) { r.internet = "cfg"; continue; }
    const inbound = n.metadata?.inboundRules;
    r.internet = typeof inbound === "number" ? (inbound > 0 ? "cfg" : null) : "unk";
  }

  // Recommendations — a sample on a linked tile attaches the recommendation to that row
  const cov = { truncatedRecs: 0, armSamples: 0, matchedSamples: 0, nonArmSamples: 0, ambiguous: 0 };
  const attachedRecs = new Set<string>();
  for (const rec of posture.recommendations) {
    if (rec.unhealthy > rec.samples.length) cov.truncatedRecs++;
    for (const s of rec.samples) {
      const m = lookup(ix, model, s);
      if (m.status === "unlinkable") { cov.nonArmSamples++; continue; }
      cov.armSamples++;
      if (m.status === "ambiguous") { cov.ambiguous++; continue; }
      if (m.status !== "matched") continue;
      cov.matchedSamples++;
      const r = m.tile ? rows.get(m.tile) : undefined;
      if (!r) continue;
      if (m.tile === aksTile && m.via === "vmss") link(r, "nodepool", "cfg");
      if (!r.recKeys.has(rec.key)) {
        r.recKeys.add(rec.key);
        r.recs.push({ key: rec.key, title: rec.title, severity: rec.severity, domain: rec.domain });
      }
      attachedRecs.add(rec.key);
    }
  }

  // Alerts — same rule; VMSS instance targets (…/virtualMachineScaleSets/x/virtualMachines/0) have no graph node
  const attachedAlerts = new Set<string>();
  for (const a of posture.alerts) {
    for (const ref of a.resources) {
      const m = lookup(ix, model, ref);
      if (m.status !== "matched" || !m.tile) continue;
      const r = rows.get(m.tile);
      if (!r) continue;
      if (m.tile === aksTile && m.via === "vmss") link(r, "nodepool", "cfg");
      if (!r.alertIds.has(a.id)) { r.alertIds.add(a.id); r.alerts.push({ id: a.id, title: a.title, severity: a.severity, intent: a.intent }); }
      attachedAlerts.add(a.id);
    }
  }

  const out: RiskRow[] = [...rows.values()].map((b) => ({
    key: b.key, name: b.name, kind: b.kind, resourceGroup: b.resourceGroup, links: b.links, alerts: b.alerts, issues: b.issues, internet: b.internet,
    recs: [...b.recs].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.title.localeCompare(y.title)),
    uncertain: b.links.every((l) => l.ev === "unk"),
  }));
  const high = (r: RiskRow) => r.recs.filter((x) => x.severity === "High").length;
  const crit = (r: RiskRow) => r.issues.filter((x) => x.sev === "crit").length;
  out.sort((a, b) => Number(a.uncertain) - Number(b.uncertain) || high(b) - high(a) || crit(b) - crit(a) || a.name.localeCompare(b.name));

  const certain = out.filter((r) => !r.uncertain);
  const highRecs = new Set(certain.flatMap((r) => r.recs.filter((x) => x.severity === "High").map((x) => x.key)));
  // Alerts that reach the cluster: on the cluster / node pools, or on an LB / App Gateway with inbound rules to it
  const alertRows = certain.filter((r) => r.links.some((l) => (l.rel === "cluster" || l.rel === "nodepool" || l.rel === "entry") && l.ev !== "unk"));
  const linkedAlerts = new Set(alertRows.flatMap((r) => r.alerts.map((a) => a.id)));

  return {
    mode: "live",
    rows: out,
    stats: {
      issues: insights.issues.length,
      linkedAssets: certain.filter((r) => !r.links.some((l) => l.rel === "cluster")).length,
      highRecs: highRecs.size,
      linkedAlerts: linkedAlerts.size,
    },
    coverage: cov,
    unlinked: {
      highRecs: posture.recommendations.filter((r) => r.severity === "High" && !attachedRecs.has(r.key)).length,
      issues: insights.issues.filter((i) => !egressIssues.has(i.id)).length,
      alerts: posture.alerts.filter((a) => !attachedAlerts.has(a.id)).length,
      egressTargets,
    },
    gaps,
  };
}

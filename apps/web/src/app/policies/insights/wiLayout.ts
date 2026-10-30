// Workload identity map layout (pure): five columns — workloads · service accounts · token path (federated
// credentials, and node pools whose scale set carries the identity — IMDS) · managed identities · Azure roles — one
// horizontal band per identity (worst first), so the lines of a band never cross into another. The column width
// follows the container (no sideways scrolling).

import type { WiSeverity, WorkloadIdentityResponse, EvidenceKind } from "@aud/types";

export type Pt = { x: number; y: number };
export type WiCol = 0 | 1 | 2 | 3 | 4;
export type WiKind = "workload" | "sa" | "fic" | "pool" | "identity" | "role";
export type WiGraphNode = { id: string; col: WiCol; group: string; kind: WiKind; sev: WiSeverity | null; unk: boolean; h: number };
export type WiGraphEdge = { from: string; to: string; ev: EvidenceKind; kind: "uses" | "federated" | "annotatedOnly" | "parent" | "imds" | "assigned" };
export type WiGroup = { id: string; identityId: string | null; sev: WiSeverity | null; size: number; title: string };
export type WiGraph = { nodes: WiGraphNode[]; edges: WiGraphEdge[]; groups: WiGroup[]; hiddenGroups: number };
export type WiLayoutOpts = { width: number; colGap: number; vGap: number; groupGap: number; headH: number; minColW: number };
export type WiPlaced = { x: number; y: number; w: number; h: number };
export type WiLayout = {
  width: number; height: number; colW: number;
  cols: Array<{ x: number; w: number }>;
  groups: Array<{ id: string; y0: number; y1: number }>;
  nodes: Map<string, WiPlaced>;
  edges: Array<{ key: string; from: string; to: string; d: string; ev: EvidenceKind; kind: WiGraphEdge["kind"] }>;
};

/** Three text lines fit every card (title · sub · one extra line) */
export const NODE_H: Record<WiKind, number> = { workload: 58, sa: 60, fic: 58, pool: 58, identity: 78, role: 58 };
const SEV_RANK: Record<WiSeverity, number> = { crit: 0, warn: 1, low: 2, info: 3 };
const worse = (a: WiSeverity | null, b: WiSeverity | null) => (!a ? b : !b ? a : SEV_RANK[a] <= SEV_RANK[b] ? a : b);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const MAX_GROUPS = 30;

/** Worst finding severity per node id */
export function nodeSeverity(r: WorkloadIdentityResponse): Map<string, WiSeverity> {
  const m = new Map<string, WiSeverity>();
  for (const f of r.findings) for (const id of f.refs) m.set(id, worse(m.get(id) ?? null, f.sev)!);
  return m;
}

/** One card per (node pool, identity) — the same pool can carry several identities, each in its own band */
export const poolNodeId = (poolId: string, identityId: string) => `${poolId}@${identityId}`;
export const poolOfNodeId = (nodeId: string) => (nodeId.startsWith("pool:") ? nodeId.slice(0, nodeId.indexOf("@")) : null);

/** Per namespace: workloads using workload identity vs not (system objects only when shown), most "without" first */
export function namespaceCoverage(r: WorkloadIdentityResponse, opts: { showSystem: boolean }): Array<{ namespace: string; wi: number; other: number }> {
  const m = new Map<string, { namespace: string; wi: number; other: number }>();
  const bump = (ns: string, k: "wi" | "other") => {
    const e = m.get(ns) ?? { namespace: ns, wi: 0, other: 0 };
    e[k]++;
    m.set(ns, e);
  };
  for (const w of r.workloads) if (opts.showSystem || !w.managed) bump(w.namespace, "wi");
  for (const w of r.otherWorkloads) if (opts.showSystem || !w.managed) bump(w.namespace, "other");
  return [...m.values()].sort((a, b) => Number(b.wi > 0) - Number(a.wi > 0) || b.other - a.other || cmp(a.namespace, b.namespace));
}

export function wiGraph(r: WorkloadIdentityResponse, opts: { showSystem: boolean }): WiGraph {
  const sev = nodeSeverity(r);
  const sas = r.serviceAccounts.filter((s) => opts.showSystem || !s.managed);
  const saIds = new Set(sas.map((s) => s.id));
  const nodes: WiGraphNode[] = [];
  const edges: WiGraphEdge[] = [];
  const groupOf = (identityId: string | null) => identityId ?? "none";

  // Groups: one per identity that has a visible SA, a credential trusting this cluster or a node pool (IMDS) — a
  // node-pool-only identity without roles (AKS add-ons) only with system objects shown — then "no identity"
  const identities = r.identities.filter((i) => sas.some((s) => s.identityId === i.id) || i.fic.ids.length > 0
    || (!!i.pools?.length && (opts.showSystem || i.roles.length > 0 || i.rolesStatus !== "ok")));
  const groups: WiGroup[] = identities.map((i) => {
    const members = [i.id, ...sas.filter((s) => s.identityId === i.id).map((s) => s.id), ...i.fic.ids, ...(i.pools ?? []).map((p) => poolNodeId(p, i.id)), ...i.roles.map((x) => x.id)];
    return {
      id: i.id, identityId: i.id, sev: members.reduce<WiSeverity | null>((a, id) => worse(a, sev.get(id) ?? null), null),
      size: sas.filter((s) => s.identityId === i.id).length, title: i.name ?? i.clientIdTail,
    };
  });
  if (sas.some((s) => !s.identityId)) groups.push({ id: "none", identityId: null, sev: null, size: sas.filter((s) => !s.identityId).length, title: "" });
  const kindRank = (g: WiGroup) => (g.identityId === null ? 2 : r.identities.find((i) => i.id === g.identityId)?.kind === "unresolved" ? 1 : 0);
  groups.sort((a, b) => kindRank(a) - kindRank(b) || (a.sev ? SEV_RANK[a.sev] : 9) - (b.sev ? SEV_RANK[b.sev] : 9) || b.size - a.size || cmp(a.title, b.title));
  const shown = groups.slice(0, MAX_GROUPS);
  const shownIds = new Set(shown.map((g) => g.id));

  for (const s of sas) {
    const g = groupOf(s.identityId);
    if (!shownIds.has(g)) continue;
    nodes.push({ id: s.id, col: 1, group: g, kind: "sa", sev: sev.get(s.id) ?? null, unk: s.exists === null, h: NODE_H.sa });
    for (const w of r.workloads.filter((x) => x.saId === s.id && (opts.showSystem || !x.managed))) {
      nodes.push({ id: w.id, col: 0, group: g, kind: "workload", sev: sev.get(w.id) ?? null, unk: false, h: NODE_H.workload });
      edges.push({ from: w.id, to: s.id, ev: "cfg", kind: "uses" });
    }
    if (s.identityId && !s.ficIds.length) edges.push({ from: s.id, to: s.identityId, ev: "unk", kind: "annotatedOnly" });
  }
  for (const i of identities) {
    if (!shownIds.has(i.id)) continue;
    nodes.push({ id: i.id, col: 3, group: i.id, kind: "identity", sev: sev.get(i.id) ?? null, unk: i.kind === "unresolved", h: NODE_H.identity });
    for (const f of r.fics.filter((x) => x.identityId === i.id)) {
      nodes.push({ id: f.id, col: 2, group: i.id, kind: "fic", sev: sev.get(f.id) ?? null, unk: f.dangling === null, h: NODE_H.fic });
      if (f.saId && saIds.has(f.saId)) edges.push({ from: f.saId, to: f.id, ev: "cfg", kind: "federated" });
      edges.push({ from: f.id, to: i.id, ev: "cfg", kind: "parent" });
    }
    for (const p of i.pools ?? []) {
      const id = poolNodeId(p, i.id);
      nodes.push({ id, col: 2, group: i.id, kind: "pool", sev: sev.get(id) ?? null, unk: r.imds.podAccess === null, h: NODE_H.pool });
      edges.push({ from: id, to: i.id, ev: "cfg", kind: "imds" });
    }
    for (const ra of i.roles) {
      nodes.push({ id: ra.id, col: 4, group: i.id, kind: "role", sev: sev.get(ra.id) ?? null, unk: false, h: NODE_H.role });
      edges.push({ from: i.id, to: ra.id, ev: "perm", kind: "assigned" });
    }
  }
  return { nodes, edges, groups: shown, hiddenGroups: groups.length - shown.length };
}

const DEFAULTS: WiLayoutOpts = { width: 1100, colGap: 44, vGap: 8, groupGap: 22, headH: 30, minColW: 150 };

export function layoutWi(g: WiGraph, o: Partial<WiLayoutOpts> = {}): WiLayout {
  const opt = { ...DEFAULTS, ...o };
  const colW = Math.max(opt.minColW, Math.floor((opt.width - 4 * opt.colGap) / 5));
  const cols = [0, 1, 2, 3, 4].map((c) => ({ x: c * (colW + opt.colGap), w: colW }));
  const placed = new Map<string, WiPlaced>();
  const bands: WiLayout["groups"] = [];
  let y = opt.headH + 8;

  for (const grp of g.groups) {
    const members = g.nodes.filter((n) => n.group === grp.id);
    // Order: SAs by id; workloads and credentials follow their SA (barycenter), dangling credentials last; roles as given
    const sas = members.filter((n) => n.kind === "sa").sort((a, b) => cmp(a.id, b.id));
    const saIdx = new Map(sas.map((s, i) => [s.id, i]));
    const anchor = (id: string) => {
      const e = g.edges.find((x) => (x.kind === "uses" && x.from === id) || (x.kind === "federated" && x.to === id));
      const sa = e ? (e.kind === "uses" ? e.to : e.from) : null;
      return sa !== null && saIdx.has(sa) ? saIdx.get(sa)! : Number.MAX_SAFE_INTEGER;
    };
    const byCol: WiGraphNode[][] = [[], [], [], [], []];
    for (const n of members) byCol[n.col]!.push(n);
    byCol[0]!.sort((a, b) => anchor(a.id) - anchor(b.id) || cmp(a.id, b.id));
    byCol[1] = sas;
    byCol[2]!.sort((a, b) => anchor(a.id) - anchor(b.id) || cmp(a.id, b.id));
    const stackH = byCol.map((c) => c.reduce((s, n) => s + n.h, 0) + Math.max(0, c.length - 1) * opt.vGap);
    const gh = Math.max(...stackH, NODE_H.identity);
    byCol.forEach((col, ci) => {
      let cy = y + (gh - stackH[ci]!) / 2;
      for (const n of col) {
        placed.set(n.id, { x: cols[ci]!.x, y: cy, w: colW, h: n.h });
        cy += n.h + opt.vGap;
      }
    });
    bands.push({ id: grp.id, y0: y - 6, y1: y + gh + 6 });
    y += gh + opt.groupGap;
  }

  const edges = g.edges.flatMap((e) => {
    const a = placed.get(e.from), b = placed.get(e.to);
    if (!a || !b) return [];
    const x0 = a.x + a.w, y0 = a.y + a.h / 2, x1 = b.x, y1 = b.y + b.h / 2;
    const mx = (x0 + x1) / 2;
    return [{ key: `${e.from}>${e.to}`, from: e.from, to: e.to, ev: e.ev, kind: e.kind, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}` }];
  });
  return { width: cols[4]!.x + colW, height: Math.max(y, opt.headH + 60), colW, cols, groups: bands, nodes: placed, edges };
}

/** Everything upstream and downstream of a node — selecting it highlights its chain */
export function chainOf(g: Pick<WiGraph, "edges">, nodeId: string): Set<string> {
  const out = new Set([nodeId]);
  const walk = (dir: "up" | "down") => {
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of g.edges) {
        const next = dir === "down" ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null;
        if (next && !out.has(next)) { out.add(next); queue.push(next); }
      }
    }
  };
  walk("up");
  walk("down");
  return out;
}

/** Segment crossings between adjacent columns (straight-line approximation) — layout quality, for tests */
export function countCrossings(l: WiLayout, g: Pick<WiGraph, "edges">): number {
  const segs = g.edges.flatMap((e) => {
    const a = l.nodes.get(e.from), b = l.nodes.get(e.to);
    return a && b ? [{ x0: a.x, y0: a.y + a.h / 2, x1: b.x, y1: b.y + b.h / 2 }] : [];
  });
  let n = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i]!, q = segs[j]!;
    if (p.x0 !== q.x0 || p.x1 !== q.x1) continue;
    if ((p.y0 - q.y0) * (p.y1 - q.y1) < 0) n++;
  }
  return n;
}

/** n/20 federated credential gauge (the 16 threshold is the dashboard's, not Microsoft's) */
export function ficGauge(count: number | null, limit = 20): { ratio: number; tone: "ok" | "warn" | "crit" | "unk"; text: string } {
  if (count === null) return { ratio: 0, tone: "unk", text: `?/${limit}` };
  return { ratio: Math.min(1, count / limit), tone: count >= limit ? "crit" : count >= 16 ? "warn" : "ok", text: `${count}/${limit}` };
}

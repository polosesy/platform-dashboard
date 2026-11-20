// Azure 공격 경로 그림 (2026-11-20 — Wiz "Attack Path Visualization"): one path of /api/security/azure-risk `paths`
// laid out left to right — 인터넷 → 진입점(노출) → 관리 ID → 역할(권한 @ 범위) → 데이터 저장소. Pure: nodes, edges,
// the findings box and the size; the component draws them. Only what the path holds is drawn — no hop is inferred:
//   · a role is joined to the identities that hold it (`holders`); without names one "managed identity" node holds all
//   · a store reachable by two roles is one node with two incoming edges; a role reaching more stores than the API
//     names (≤ 5 per kind) ends in a "+n" node, never invented names
//   · where the chain stops (`ends: entry`) a stop node says why
//   · the entry's High findings fold into a badge; expanded, a box above the entry lists them (Wiz "Click to expand")
import type { AzureAttackPath, AzureJewelKind } from "@aud/types";

export type PathNodeKind = "internet" | "entry" | "identity" | "role" | "data" | "more" | "stop";
export type PathTone = "neutral" | "warn" | "danger" | "info";
export type PathNode = {
  id: string;
  kind: PathNodeKind;
  col: number;
  x: number;
  y: number;
  /** i18n-free: the component turns `labelKey` + `vars` into text where `label` is absent */
  label?: string;
  labelKey?: string;
  vars?: Record<string, string | number>;
  /** the second line (type, scope …) */
  sub?: string;
  subKey?: string;
  subVars?: Record<string, string | number>;
  tone: PathTone;
  /** data store kind / identity kind — the icon */
  icon: "globe" | "server" | "identity" | "userIdentity" | "role" | "keyVault" | "storage" | "database" | "more" | "stop";
  /** the entry: High findings count (badge) */
  badge?: number;
  /** a role that reaches the data through keys / access policies */
  viaKeys?: boolean;
};
export type PathEdge = { id: string; from: string; to: string; kind: "exposure" | "identity" | "role" | "reach" | "stop"; limited?: boolean; danger?: boolean };
export type PathGraph = {
  nodes: PathNode[];
  edges: PathEdge[];
  findings: { x: number; y: number; w: number; h: number; items: string[]; more: number } | null;
  width: number;
  height: number;
};

export const COL_W = 180;
export const ROW_H = 96;
export const R = 22;
const PAD_X = 70, PAD_TOP = 36, PAD_BOTTOM = 56;
const BOX_W = 200, BOX_ROW = 26, BOX_PAD = 12;
const KIND_ICON: Record<AzureJewelKind, PathNode["icon"]> = { keyVault: "keyVault", storage: "storage", database: "database" };

/** Lay one path out; `expandFindings` opens the findings box above the entry */
export function pathGraph(p: AzureAttackPath, opts: { expandFindings?: boolean; rolesAboveHidden?: boolean } = {}): PathGraph {
  const cols: PathNode[][] = [[], [], [], [], []];
  const edges: PathEdge[] = [];
  const add = (n: Omit<PathNode, "x" | "y">) => { cols[n.col]!.push({ ...n, x: 0, y: 0 }); return n.id; };

  add({ id: "internet", kind: "internet", col: 0, labelKey: "apg.internet", tone: "neutral", icon: "globe" });
  add({ id: "entry", kind: "entry", col: 1, label: p.entry.name, sub: shortType(p.entry.type), tone: p.vuln ? "danger" : "warn", icon: "server", ...(p.vuln ? { badge: p.vuln.count } : {}) });
  edges.push({ id: "e:internet", from: "internet", to: "entry", kind: "exposure", ...(p.entry.limited ? { limited: true } : {}) });

  // identities: named ones, else one node for all of them (counts only)
  const named = p.identity.list ?? [];
  const idIds: string[] = [];
  if (named.length) {
    named.forEach((i, k) => {
      const nid = `id:${k}`;
      idIds.push(add({ id: nid, kind: "identity", col: 2, label: i.name, subKey: i.kind === "system" ? "apg.idSystem" : "apg.idUser", tone: "info", icon: i.kind === "system" ? "identity" : "userIdentity" }));
      edges.push({ id: `e:${nid}`, from: "entry", to: nid, kind: "identity" });
    });
  } else if (p.identity.principals > 0) {
    idIds.push(add({ id: "id:all", kind: "identity", col: 2, labelKey: "apg.idCount", vars: { n: p.identity.principals }, tone: "info", icon: "identity" }));
    edges.push({ id: "e:id:all", from: "entry", to: "id:all", kind: "identity" });
  }

  // roles, ordered by their first holder so edges don't cross; joined to holders (or to every identity when unnamed)
  const holderIndex = (r: AzureAttackPath["roles"][number]) => Math.min(...(r.holders ?? []).map((h) => named.findIndex((n) => n.name === h)).filter((i) => i >= 0), 99);
  const roles = p.roles.map((r, k) => ({ r, k })).sort((a, b) => holderIndex(a.r) - holderIndex(b.r) || a.k - b.k);
  const dataSeen = new Map<string, string>();
  for (const { r, k } of roles) {
    const rid = `role:${k}`;
    const danger = r.kind === "privileged" || !!r.write;
    add({
      id: rid, kind: "role", col: 3, tone: danger ? "danger" : "warn", icon: "role",
      labelKey: r.kind === "privileged" ? `azr.role.${r.role}` : `azp.data.${r.role}`, vars: r.kind === "privileged" ? {} : { rw: r.write ? "write" : "read" },
      ...(r.viaKeys ? { viaKeys: true } : {}),
      subKey: r.scopeName ? "apg.scopeNamed" : "apg.scope", subVars: { scope: r.scope, name: r.scopeName ?? "" },
    });
    const from = r.holders?.length ? r.holders.map((h) => idIds[named.findIndex((n) => n.name === h)]).filter((x): x is string => !!x) : idIds;
    for (const f of from) edges.push({ id: `e:${f}:${rid}`, from: f, to: rid, kind: "role", danger });
    for (const reach of r.reaches) {
      for (const name of reach.names) {
        const key = `${reach.kind}:${name}`;
        let did = dataSeen.get(key);
        if (!did) { did = `data:${dataSeen.size}`; dataSeen.set(key, did); add({ id: did, kind: "data", col: 4, label: name, subKey: `azp.jewel.${reach.kind}`, tone: "danger", icon: KIND_ICON[reach.kind] }); }
        edges.push({ id: `e:${rid}:${did}`, from: rid, to: did, kind: "reach", danger: true });
      }
      if (reach.count > reach.names.length) {
        const mid = `more:${k}:${reach.kind}`;
        add({ id: mid, kind: "more", col: 4, labelKey: "apg.more", vars: { n: reach.count - reach.names.length }, subKey: `azp.jewel.${reach.kind}`, tone: "danger", icon: "more" });
        edges.push({ id: `e:${rid}:${mid}`, from: rid, to: mid, kind: "reach", danger: true });
      }
    }
  }

  // where it stops (a fact): after the identities, else after the entry
  if (p.ends === "entry") {
    const reason = p.identityUnknown ? (opts.rolesAboveHidden ? "apg.stopAboveHidden" : "apg.stopUnknown") : p.identity.principals ? "apg.stopRoles" : "apg.stopNoIdentity";
    const col = idIds.length ? 3 : 2;
    add({ id: "stop", kind: "stop", col, labelKey: "apg.stop", subKey: reason, subVars: { o: p.identity.otherRoles }, tone: "neutral", icon: "stop" });
    for (const f of idIds.length ? idIds : ["entry"]) edges.push({ id: `e:${f}:stop`, from: f, to: "stop", kind: "stop" });
  }

  // data stores ordered by their first incoming role (fewer crossings)
  const roleRow = new Map(cols[3]!.map((n, i) => [n.id, i]));
  cols[4]!.sort((a, b) => firstFrom(a.id, edges, roleRow) - firstFrom(b.id, edges, roleRow));

  // place: columns centred on the tallest; the findings box (open) sits above the entry, pushing everything down
  const tallest = Math.max(...cols.map((c) => c.length), 1);
  const items = p.vuln?.names ?? [];
  const boxH = opts.expandFindings && p.vuln ? BOX_PAD * 2 + 18 + Math.max(1, items.length + (p.vuln.count > items.length ? 1 : 0)) * BOX_ROW : 0;
  const top = PAD_TOP + (boxH ? boxH + 28 : 0);
  const used = cols.filter((c) => c.length).length;
  for (const [ci, c] of cols.entries()) {
    const off = ((tallest - c.length) * ROW_H) / 2;
    c.forEach((n, i) => { n.x = PAD_X + ci * COL_W; n.y = top + off + i * ROW_H + R; });
  }
  const nodes = cols.flat();
  const entry = nodes.find((n) => n.id === "entry")!;
  const lastCol = Math.max(...nodes.map((n) => n.col));
  return {
    nodes, edges,
    findings: boxH ? { x: entry.x - BOX_W / 2, y: PAD_TOP, w: BOX_W, h: boxH, items, more: Math.max(0, (p.vuln?.count ?? 0) - items.length) } : null,
    width: PAD_X * 2 + lastCol * COL_W,
    height: top + (tallest - 1) * ROW_H + 2 * R + PAD_BOTTOM + (used ? 0 : 0),
  };
}

function firstFrom(id: string, edges: PathEdge[], row: Map<string, number>): number {
  return Math.min(...edges.filter((e) => e.to === id).map((e) => row.get(e.from) ?? 99), 99);
}

/** "microsoft.compute/virtualmachines" → "virtualmachines" — the graph's second line (the full type is the tooltip) */
export function shortType(t: string): string {
  return t.split("/").pop() ?? t;
}

/** A gentle curve from the right edge of one circle to the left edge of the next (same column = a straight drop) */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  if (a.x === b.x) return `M${a.x},${a.y + R} L${b.x},${b.y - R}`;
  const x1 = a.x + R, x2 = b.x - R, mx = (x1 + x2) / 2;
  return `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
}

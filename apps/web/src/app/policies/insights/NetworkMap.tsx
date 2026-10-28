"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NetEdge, NetEdgeClass, NetNode, PolicyInsightsResponse } from "@aud/types";
import { layoutNest, parentsOf, visibleAncestor, type NestNode } from "@/lib/nestLayout";
import { useLocalPreference, useMediaQuery } from "@/lib/useBrowserState";
import { useI18n } from "@/lib/i18n";
import { issueNum, type InsightsNav } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import { Inspector, type InspectorModel, type InspectorRow } from "./Inspector";
import { ComboButton, FactorStrip } from "./RiskHeatmap";
import styles from "./insights.module.css";

// [label key, colour, dash]
const ECLS: Record<NetEdgeClass, [string, string, string | undefined]> = {
  eastwest: ["ins.net.cls.eastwest", "var(--muted)", undefined],
  cloud: ["ins.net.cls.cloud", "var(--accent)", undefined],
  private: ["ins.net.cls.private", "var(--n-node)", "4 2"],
  internet: ["ins.net.cls.internet", "var(--crit)", "6 3"],
  control: ["ins.net.cls.control", "var(--edge-cfg)", "2 3"],
  platform: ["ins.net.cls.platform", "var(--faint)", "1 3"],
};
const CLS_RANK: Record<NetEdgeClass, number> = { internet: 6, cloud: 5, private: 4, control: 3, eastwest: 2, platform: 1 };
const NS_ORDER = ["cloud-domain", "observability", "azure-alb-system", "kube-system"];
const nsRank = (ns: string) => { const i = NS_ORDER.indexOf(ns); return i < 0 ? 50 : i; };
const thick = (c: number, max: number) => 1.2 + (3.4 * Math.log1p(c)) / Math.log1p(Math.max(max, 1));
const VIEWS = ["nest", "flow"] as const;
type View = (typeof VIEWS)[number];
const LINE_MODES = ["bundle", "each"] as const;
type LineMode = (typeof LINE_MODES)[number];

type Props = {
  data: PolicyInsightsResponse;
  sel: string | null;
  onSelect: (id: string | null) => void;
  nav: InsightsNav;
};

function Markers({ prefix }: { prefix: string }) {
  return (
    <defs>
      {(Object.keys(ECLS) as NetEdgeClass[]).map((k) => (
        <marker key={k} id={`${prefix}-${k}`} viewBox="0 0 8 8" refX={7} refY={4} markerUnits="userSpaceOnUse" markerWidth={9} markerHeight={9} orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 Z" fill={ECLS[k][1]} />
        </marker>
      ))}
    </defs>
  );
}

function LeafIcon({ kind }: { kind: NetNode["kind"] }) {
  const p = { stroke: "#fff", strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "workload") return <><rect x={-7} y={-6} width={14} height={12} rx={2} {...p} /><path d="M-7 -1 H7 M-2 -6 V6" {...p} /></>;
  if (kind === "paas") return <><ellipse cx={0} cy={-5} rx={6} ry={2.5} {...p} /><path d="M-6 -5 V5 C-6 8 6 8 6 5 V-5" {...p} /></>;
  if (kind === "apiserver") return <path d="M0 -8 L7 -5 V1 C7 5 4 7 0 9 C-4 7 -7 5 -7 1 V-5 Z" {...p} />;
  if (kind === "node") return <><rect x={-7} y={-7} width={14} height={6} rx={1.5} {...p} /><rect x={-7} y={1} width={14} height={6} rx={1.5} {...p} /></>;
  return <><circle r={6} {...p} /><path d="M-6 0 H6 M0 -6 C3 -3 3 3 0 6 C-3 3 -3 -3 0 -6" {...p} /></>;
}

const leafColor = (n: NetNode) =>
  n.kind === "paas" || n.kind === "azureService" ? "var(--n-azure)" : n.kind === "private" ? "var(--n-node)" : n.kind === "internet" || n.kind === "unknown" ? "var(--crit)" : n.kind === "apiserver" ? "var(--n-permission)"
    : n.kind === "node" ? "var(--n-node)" : n.kind === "probe" || n.kind === "platform" ? "var(--faint)" : "var(--n-workload)";
const textW = (s: string, px: number) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? px : px * 0.58), 0);

export function NetworkMap({ data, sel, onSelect, nav }: Props) {
  const { t } = useI18n();
  const { COMBO_LABEL, flowNote, hubbleLabel } = useInsightLabels();
  const net = data.network;
  const [view, setView] = useLocalPreference<View>("aud-net-view", "nest", VIEWS);
  const [lineMode, setLineMode] = useLocalPreference<LineMode>("aud-net-lines", "bundle", LINE_MODES);
  const [on, setOn] = useState<Record<NetEdgeClass, boolean>>({ eastwest: true, cloud: true, private: true, internet: true, control: false, platform: false });
  const [showManaged, setShowManaged] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const narrow = useMediaQuery("(max-width: 640px)");
  const els = useRef(new Map<string, SVGGElement>());
  const register = (k: string) => (el: SVGGElement | null) => { if (el) els.current.set(k, el); else els.current.delete(k); };
  const focusLater = (k: string) => requestAnimationFrame(() => els.current.get(k)?.focus());

  if (!net.available) {
    return (
      <section className={styles.panel} aria-label={t("ins.net.title")}>
        <div className={styles.panelH}><h3>{t("ins.net.title")}</h3></div>
        <div className={styles.panelB}><div className={styles.notice}>{t("ins.net.noTraffic", { reason: net.reason ?? "" })}</div></div>
      </section>
    );
  }

  const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
  const rowById = new Map(data.rows.map((r) => [r.id, r]));
  const visibleNode = (n: NetNode | undefined) => !!n && (n.kind !== "workload" || showManaged || !n.managed);
  // DROPPED flows are a security signal: shown regardless of class filters
  const edges = net.edges.filter((e) => (on[e.cls] || e.dropped > 0) && visibleNode(nodeById.get(e.from)) && visibleNode(nodeById.get(e.to)));
  const ids = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = net.nodes.filter((n) => ids.has(n.id));
  const label = (id: string) => nodeById.get(id)?.label ?? id;
  const note = flowNote(net.coverage);
  const edgeTitle = (e: NetEdge) => `${label(e.from)} → ${label(e.to)} · ${e.ports.join(", ")} · ${e.count} flows (${note})${e.dropped ? ` · DROPPED ${e.dropped}` : ""}${e.note ? ` · ${e.note}` : ""}`;
  const pick = (id: string) => { onSelect(sel === id ? null : id); focusLater(`n:${id}`); };
  const leafKey = (id: string) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(id); }
    if (e.key === "Escape" && sel) { e.preventDefault(); onSelect(null); focusLater(`n:${id}`); }
  };

  // ── Flow view ──
  const renderFlow = (): ReactNode => {
    const W = 980, rowH = 46;
    const deg = (id: string) => edges.filter((e) => e.from === id || e.to === id).reduce((s, e) => s + e.count, 0);
    const left = nodes.filter((n) => n.kind === "probe" || n.kind === "node");
    const rightOrder = ["paas", "azureService", "private", "internet", "unknown", "apiserver", "platform"];
    const right = nodes.filter((n) => n.kind !== "workload" && n.kind !== "probe" && n.kind !== "node").sort((a, b) => rightOrder.indexOf(a.kind) - rightOrder.indexOf(b.kind) || deg(b.id) - deg(a.id));
    const mid = nodes.filter((n) => n.kind === "workload");
    const nss = [...new Set(mid.map((n) => n.namespace ?? ""))].sort((a, b) => nsRank(a) - nsRank(b) || a.localeCompare(b));
    const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
    const groups: Array<{ ns: string; y0: number; y1: number }> = [];
    let y = 56;
    for (const ns of nss) {
      const y0 = y;
      y += 18;
      for (const n of mid.filter((m) => m.namespace === ns).sort((a, b) => deg(b.id) - deg(a.id))) { pos.set(n.id, { x: 360, y, w: 210, h: 34 }); y += rowH; }
      groups.push({ ns, y0, y1: y - 8 });
      y += 10;
    }
    const midH = y;
    const place = (list: NetNode[], x: number, w: number) => {
      let yy = 74;
      const gap = Math.max(rowH, (midH - 74) / Math.max(list.length, 1));
      for (const n of list) { pos.set(n.id, { x, y: yy, w, h: 34 }); yy += Math.min(gap, 70); }
      return yy;
    };
    const H = Math.max(midH, place(left, 20, 190), place(right, 740, 220)) + 20;
    const maxC = Math.max(...edges.map((e) => e.count), 1);
    const isOn = (e: NetEdge) => !!sel && (e.from === sel || e.to === sel);
    let ew = 0;
    return (
      <svg className={styles.netsvg} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={t("ins.net.flowAria")} data-focus={!!sel || undefined}>
        <Markers prefix="nf" />
        <text className={styles.colh} x={115} y={24} textAnchor="middle">{t("ins.net.colIn")}</text>
        <text className={styles.colh} x={465} y={24} textAnchor="middle">{t("ins.net.colWorkloads")}</text>
        <text className={styles.colh} x={850} y={24} textAnchor="middle">{t("ins.net.colOut")}</text>
        {!left.length && <text className={styles.ns2} x={115} y={74} textAnchor="middle">{t("ins.net.leftHint")}</text>}
        {groups.map((g) => (
          <g key={g.ns}><rect x={348} y={g.y0} width={234} height={g.y1 - g.y0} rx={10} fill="var(--surface-2)" stroke="var(--line)" /><text className={styles.nsl} x={358} y={g.y0 + 13}>{g.ns}</text></g>
        ))}
        {edges.map((e) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const [, color, dash] = ECLS[e.cls];
          const loop = a.x === b.x;
          let d: string, lx: number, ly: number;
          if (loop) {
            const k = ++ew;
            const bx = a.x - 40 - (k % 6) * 12 - Math.min(60, Math.abs(b.y - a.y) / 6);
            d = `M${a.x},${a.y + a.h / 2 - 4} C${bx},${a.y + a.h / 2 - 4} ${bx},${b.y + b.h / 2 + 4} ${b.x - 6},${b.y + b.h / 2 + 4}`;
            lx = bx + (a.x - bx) * 0.25 - 4; ly = (a.y + b.y) / 2 + a.h / 2 + 3 + ((k % 3) - 1) * 12;
          } else {
            const fwd = a.x < b.x;
            const x0 = fwd ? a.x + a.w : a.x, x1 = fwd ? b.x - 6 : b.x + b.w + 6;
            const y0 = a.y + a.h / 2, y1 = b.y + b.h / 2, mx = (x0 + x1) / 2;
            d = `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
            lx = fwd ? x1 - 34 : x1 + 34; ly = y1 - 6;
          }
          const ports = e.ports.slice(0, 3).join(",") + (e.ports.length > 3 ? "…" : "");
          return (
            <g key={`${e.from}>${e.to}`} className={styles.edge} data-on={isOn(e) || undefined} data-ext={(!loop && e.cls !== "platform") || undefined}>
              <path className={styles.ehitNet} d={d}><title>{edgeTitle(e)}</title></path>
              <path d={d} fill="none" stroke={e.dropped ? "var(--crit)" : color} strokeWidth={thick(e.count, maxC).toFixed(1)} strokeDasharray={dash} opacity={0.85} markerEnd={`url(#nf-${e.cls})`} pointerEvents="none" />
              <text className={`${styles.pl} ${styles.halo}`} x={lx} y={ly} textAnchor={loop ? "end" : "middle"}>{ports}{e.dropped ? " ✕DROP" : ""}</text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const row = rowById.get(n.id);
          const accent = n.kind === "workload" ? "var(--ink)" : leafColor(n);
          const lit = !!sel && (sel === n.id || edges.some((e) => isOn(e) && (e.from === n.id || e.to === n.id)));
          return (
            <g key={n.id} ref={register(`n:${n.id}`)} className={styles.nleaf} data-on={lit || undefined} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button" aria-pressed={sel === n.id} aria-label={`${n.label} — ${n.sub}`} onClick={() => pick(n.id)} onKeyDown={leafKey(n.id)}>
              <rect className={styles.flowBox} width={p.w} height={p.h} rx={8} />
              <rect width={4} height={p.h} rx={2} fill={accent} />
              <text className={styles.nl} x={12} y={15}>{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
              <text className={styles.ns2} x={12} y={28}>{n.sub}</text>
              {overlay && row && data.factors.map((f, i) => (
                <rect key={f.key} x={p.w - 8 - (data.factors.length - i) * 7} y={p.h - 9} width={5} height={5} rx={1} fill={row.cells[f.key] ? (row.weights[f.key] === "crit" ? "var(--crit)" : row.weights[f.key] === "warn" ? "var(--warnc)" : "var(--faint)") : "var(--line)"}><title>{f.label}</title></rect>
              ))}
              {overlay && !!n.combos?.length && (
                <g transform={`translate(${p.w - 4},2)`}>
                  <rect x={-(n.combos.length * 15 + 4)} y={-1} width={n.combos.length * 15 + 6} height={15} rx={7} fill="var(--crit)" />
                  {n.combos.map((c, i) => <text key={c} x={-n.combos!.length * 15 + 4 + i * 15} y={10.5} style={{ fontSize: 9.5, fontWeight: 800, fill: "#fff" }}>{COMBO_LABEL[c].slice(0, 1)}</text>)}
                  <title>{t("ins.heat.combosCol")}: {n.combos.map((c) => COMBO_LABEL[c]).join(", ")}</title>
                </g>
              )}
              {n.exposure === "open" && <g transform={`translate(${p.w - 14},${p.h / 2})`}><circle r={6} fill="var(--warnc)" /><text y={3.5} textAnchor="middle" style={{ fontSize: 9, fontWeight: 800, fill: "#fff" }}>!</text><title>{t("ins.net.openToAll")}</title></g>}
            </g>
          );
        })}
      </svg>
    );
  };

  // ── Containment view (Azure ▸ 구독 ▸ RG ▸ {AKS ▸ NS ▸ workload, PaaS}) ──
  const renderNest = (): ReactNode => {
    const c = data.containment;
    const leaf = (id: string): NestNode | null => (nodeById.has(id) ? { id, kind: "leaf" } : null);
    const workloads = net.nodes.filter((n) => n.kind === "workload");
    const nsNames = [...new Set(workloads.map((n) => n.namespace ?? ""))].sort((a, b) => nsRank(a) - nsRank(b) || a.localeCompare(b));
    const hiddenIn: Record<string, number> = {};
    const nsBoxes: NestNode[] = nsNames.map((ns) => {
      const all = workloads.filter((n) => n.namespace === ns);
      const kids = all.filter(visibleNode).map((n) => ({ id: n.id, kind: "leaf" as const }));
      hiddenIn[`ns:${ns}`] = all.length - kids.length;
      return { id: `ns:${ns}`, kind: "box" as const, maxW: 450, labelW: textW(ns, 12.5), children: kids };
    }).filter((b) => (b as { children: NestNode[] }).children.length > 0 || hiddenIn[b.id]! > 0);
    const cp: NestNode = { id: "cp", kind: "box", maxW: 450, labelW: 120, children: ["ext:host", "ext:remote-node", "apiserver"].map(leaf).filter((x): x is NestNode => !!x) };
    const paas = net.nodes.filter((n) => n.kind === "paas");
    const paasGroups: NestNode[] = [...new Set(paas.map((n) => n.azureType ?? "Azure"))].map((t) => ({ id: `paas:${t}`, kind: "box" as const, maxW: 150, labelW: textW(t, 12.5), children: paas.filter((n) => (n.azureType ?? "Azure") === t).map((n) => ({ id: n.id, kind: "leaf" as const })) }));
    const clusterLabel = c.cluster.name;
    const cluster: NestNode = { id: "cluster", kind: "box", maxW: narrow ? 400 : 860, labelW: textW(clusterLabel, 12.5), children: [...nsBoxes, ...(cp.children.length ? [cp] : [])] };
    const rg: NestNode = narrow
      ? { id: "rg", kind: "box", dir: "col", labelW: textW(c.resourceGroup, 12.5), children: [cluster, { id: "paascol", kind: "group", maxW: 420, children: paasGroups }] }
      : { id: "rg", kind: "box", maxW: 1600, labelW: textW(c.resourceGroup, 12.5), children: [cluster, { id: "paascol", kind: "group", dir: "col", children: paasGroups }] };
    const platform: NestNode = { id: "platform", kind: "box", maxW: 300, labelW: 100, children: [...["probe:lb", "platform:wireserver", "platform:imds"].map(leaf).filter((x): x is NestNode => !!x), ...net.nodes.filter((n) => n.kind === "azureService").map((n) => ({ id: n.id, kind: "leaf" as const }))] };
    const privateBox: NestNode = { id: "privnet", kind: "box", maxW: 300, labelW: 140, children: ["ext:private"].map(leaf).filter((x): x is NestNode => !!x) };
    const azureLabel = `Azure ▸ ${t("ins.net.subscription")} ${c.subscription ?? t("ins.net.nameNotCollected")}`;
    const azure: NestNode = { id: "azure", kind: "box", dir: "col", labelW: textW(azureLabel, 12.5), children: [rg, ...((platform as { children: NestNode[] }).children.length ? [platform] : [])] };
    const unknown: NestNode = { id: "unknown", kind: "box", maxW: 300, labelW: 120, children: ["ext:world", "ext:unknown"].map(leaf).filter((x): x is NestNode => !!x) };
    const tree: NestNode = { id: "root", kind: "group", dir: "col", gap: 28, children: [...((unknown as { children: NestNode[] }).children.length ? [{ id: "internet", kind: "box" as const, maxW: 600, labelW: 120, children: [unknown] }] : []), ...((privateBox as { children: NestNode[] }).children.length ? [privateBox] : []), azure] };
    const meta: Record<string, { label: string; type: string; dashed?: boolean; chip?: string }> = {
      azure: { label: azureLabel, type: t("ins.net.box.azure") },
      rg: { label: c.resourceGroup || t("ins.net.rgNotCollected"), type: t("ins.net.box.rg") },
      cluster: { label: clusterLabel, type: t("ins.net.box.cluster", { loc: c.cluster.location, ver: c.cluster.k8sVersion, n: c.cluster.nodes }), chip: c.cluster.privateCluster === null ? undefined : c.cluster.privateCluster ? t("ins.net.privateApi") : t("ins.net.publicApi", { ranges: c.cluster.authorizedIpRanges ? c.cluster.authorizedIpRanges : t("ins.heat.noneShort") }) },
      cp: { label: t("ins.net.box.cp"), type: t("ins.managed") },
      platform: { label: t("ins.net.box.platform"), type: t("ins.net.box.msManaged") },
      internet: { label: t("ins.net.box.internet"), type: t("ins.net.box.internetType") },
      unknown: { label: t("ins.net.box.unknown"), type: t("ins.net.box.unknownType"), dashed: true },
      privnet: { label: t("ins.net.box.private"), type: t("ins.net.box.privateType"), dashed: true },
    };
    for (const ns of nsNames) meta[`ns:${ns}`] = { label: ns, type: t("ins.net.box.ns") };
    for (const g of paasGroups) meta[g.id] = { label: g.id.slice(5), type: "Azure PaaS" };

    const parents = parentsOf(tree);
    const defaults = new Set(["ns:kube-system", "cp", ...(narrow ? nsNames.map((n) => `ns:${n}`) : [])]);
    const collapsed = new Set([...defaults, ...Object.keys(toggled)].filter((id) => toggled[id] ?? defaults.has(id)));
    // A selected leaf is never hidden: open its ancestors
    if (sel) for (let p = parents.get(sel); p; p = parents.get(p)) collapsed.delete(p);
    const rects = layoutNest(tree, collapsed);
    const vis = (id: string) => (rects.has(id) || parents.has(id) ? visibleAncestor(id, parents, collapsed) : null);
    const nsOf = (id: string) => { for (let p = parents.get(id); p; p = parents.get(p)) if (p.startsWith("ns:")) return p; return null; };
    type Roll = { from: string; to: string; count: number; ports: string[]; cls: NetEdgeClass; dropped: number; raw: NetEdge[]; bundled: boolean };
    const lift = (id: string, at: string) => {
      if (lineMode !== "bundle" || nodeById.get(id)?.kind !== "workload") return at;
      const ns = nsOf(id);
      return ns && rects.has(ns) && !collapsed.has(ns) && at === id ? ns : at;
    };
    const roll = new Map<string, Roll>();
    const inner: Record<string, number> = {};
    for (const e of edges) {
      const a = vis(e.from), b = vis(e.to);
      if (!a || !b) continue;
      const touchesSel = !!sel && (e.from === sel || e.to === sel);
      if (a === b) { inner[a] = (inner[a] ?? 0) + 1; continue; }
      const nsA = nsOf(e.from);
      if (nsA && nsA === nsOf(e.to) && !collapsed.has(nsA) && !touchesSel && !e.dropped) { inner[nsA] = (inner[nsA] ?? 0) + 1; continue; }
      // The selected workload and DROPPED flows (a security signal) keep their own lines
      const keep = touchesSel || e.dropped > 0;
      const a2 = keep ? a : lift(e.from, a), b2 = keep ? b : lift(e.to, b);
      if (a2 === b2) { inner[a2] = (inner[a2] ?? 0) + 1; continue; }
      const k = `${a2}>${b2}`;
      const r = roll.get(k) ?? { from: a2, to: b2, count: 0, ports: [], cls: e.cls, dropped: 0, raw: [], bundled: a2 !== a || b2 !== b };
      r.count += e.count; r.dropped += e.dropped; r.raw.push(e);
      r.ports = [...new Set([...r.ports, ...e.ports])];
      if (CLS_RANK[e.cls] > CLS_RANK[r.cls]) r.cls = e.cls;
      roll.set(k, r);
    }
    const root = rects.get("root")!;
    const W = root.w + 32, H = root.h + 32;
    const center = (id: string) => {
      const r = rects.get(id)!;
      // Leaves are network nodes (circle at the top); everything else is a collapsed box
      return nodeById.has(id) ? { x: r.x + r.w / 2, y: r.y + 24, leaf: true, hw: 0, hh: 0 } : { x: r.x + r.w / 2, y: r.y + r.h / 2, leaf: false, hw: r.w / 2, hh: r.h / 2 };
    };
    const clip = (cc: ReturnType<typeof center>, tx: number, ty: number) => {
      const dx = tx - cc.x, dy = ty - cc.y, L = Math.hypot(dx, dy) || 1;
      if (cc.leaf) return { x: cc.x + (dx / L) * 24, y: cc.y + (dy / L) * 24 };
      const s = Math.min(cc.hw / Math.abs(dx || 1e-6), cc.hh / Math.abs(dy || 1e-6));
      return { x: cc.x + dx * s, y: cc.y + dy * s };
    };
    const maxC = Math.max(...[...roll.values()].map((e) => e.count), 1);
    const rollOn = (r: Roll) => !!sel && r.raw.some((e) => e.from === sel || e.to === sel);
    const boxes: ReactNode[] = [], fronts: ReactNode[] = [];
    const drawBoxes = (n: NestNode, depth: number) => {
      if (n.kind === "leaf") return;
      const r = rects.get(n.id)!;
      if (n.kind === "box") boxes.push(<rect key={`b-${n.id}`} className={styles.frame} data-dashed={meta[n.id]?.dashed || undefined} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.collapsed ? 28 : 12} fill={depth % 2 ? "var(--surface-2)" : "var(--surface)"} />);
      if (!r.collapsed) for (const c2 of n.children) drawBoxes(c2, depth + (n.kind === "box" ? 1 : 0));
    };
    drawBoxes(tree, 0);
    const leafLabel = (v: NetNode) => (v.id === "ext:private" ? net.privateExternal.map((u) => u.ip).join(", ") || v.label : v.id === "ext:world" ? (net.unmatchedExternal.filter((u) => u.from.some((f) => !rowById.get(f)?.managed && !f.startsWith("ext:"))).map((u) => u.ip).join(", ") || t("ins.net.unknownIps", { n: net.unmatchedExternal.length })) : v.label);
    const drawFront = (n: NestNode) => {
      const r = rects.get(n.id);
      if (!r) return;
      if (n.kind === "leaf") {
        const v = nodeById.get(n.id)!;
        const cx = r.x + r.w / 2, cy = r.y + 24;
        const isSel = sel === v.id;
        const lit = !!sel && (isSel || [...roll.values()].some((x) => rollOn(x) && (x.from === v.id || x.to === v.id)));
        const name = leafLabel(v);
        const short = name.length > 19 ? name.slice(0, 18) + "…" : name;
        const typ = v.kind === "paas" ? v.azureType ?? "" : v.kind === "azureService" ? v.serviceTag ?? "" : v.kind === "internet" ? t("ins.net.noAzureMatch") : v.kind === "private" ? t("ins.net.privateShort") : v.sub;
        const pillW = Math.min(r.w - 4, textW(short, 11.5) + 14);
        const dropped = net.edges.some((e) => e.from === v.id && e.dropped);
        fronts.push(
          <g key={`l-${v.id}`} ref={register(`n:${v.id}`)} className={styles.nleaf} data-on={lit || undefined} tabIndex={0} role="button" aria-pressed={isSel} aria-label={`${name} — ${v.sub}`} onClick={() => pick(v.id)} onKeyDown={leafKey(v.id)}>
            <circle className={styles.lring} cx={cx} cy={cy} r={24} />
            <circle cx={cx} cy={cy} r={19} fill={leafColor(v)} fillOpacity={v.kind === "internet" || v.kind === "unknown" ? 0.75 : 1} stroke={v.kind === "internet" || v.kind === "unknown" ? "var(--faint)" : undefined} strokeDasharray={v.kind === "internet" || v.kind === "unknown" ? "3 3" : undefined} />
            <g transform={`translate(${cx},${cy})`}><LeafIcon kind={v.kind} /></g>
            {overlay && !!v.combos?.length && <g transform={`translate(${cx + 15},${cy - 15})`}><circle r={8} fill="var(--crit)" /><text y={3.5} textAnchor="middle" style={{ fontSize: 9.5, fontWeight: 800, fill: "#fff" }}>{v.combos.length}</text><title>{t("ins.heat.combosCol")}: {v.combos.map((x) => COMBO_LABEL[x]).join(", ")}</title></g>}
            {v.exposure === "open" && <g transform={`translate(${cx - 15},${cy - 15})`}><circle r={7} fill="var(--warnc)" /><text y={3.5} textAnchor="middle" style={{ fontSize: 9, fontWeight: 800, fill: "#fff" }}>!</text><title>{t("ins.net.openToAll")}</title></g>}
            {v.sharedIpWith && <g transform={`translate(${cx + 15},${cy + 13})`}><circle r={7} fill="var(--surface)" stroke="var(--faint)" strokeDasharray="2 2" /><text y={3.5} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: "var(--muted)" }}>?</text><title>{t("ins.net.sharedIp")}</title></g>}
            {overlay && dropped && <circle cx={cx - 15} cy={cy + 14} r={4} fill="var(--crit)"><title>{t("ins.net.dropped")}</title></circle>}
            <rect className={styles.selpill} x={cx - pillW / 2} y={cy + 26} width={pillW} height={17} rx={8.5} fill="transparent" />
            <text className={`${styles.ln} ${styles.halo}`} x={cx} y={cy + 38} textAnchor="middle">{short}</text>
            <text className={`${styles.lt} ${styles.halo}`} x={cx} y={cy + 52} textAnchor="middle">{typ.length > 22 ? typ.slice(0, 21) + "…" : typ}</text>
          </g>,
        );
        return;
      }
      const m = meta[n.id];
      if (n.kind === "box" && m) {
        const lx = r.x + r.w / 2;
        if (r.collapsed) {
          const leaves: NetNode[] = [];
          const gather = (x: NestNode) => (x.kind === "leaf" ? leaves.push(nodeById.get(x.id)!) : x.children.forEach(gather));
          gather(n);
          const combos = leaves.reduce((s, v) => s + (v.combos?.length ?? 0), 0);
          const drop = leaves.some((v) => net.edges.some((e) => e.from === v.id && e.dropped));
          fronts.push(
            <g key={`p-${n.id}`}>
              <text className={`${styles.bl} ${styles.halo}`} x={lx - 8} y={r.y + 24} textAnchor="middle">{m.label}</text>
              <text className={`${styles.bt} ${styles.halo}`} x={lx - 8} y={r.y + 40} textAnchor="middle">{n.id === "cp" ? t("ins.net.cpHidden") : t("ins.net.workloadsN", { n: leaves.length + (hiddenIn[n.id] ?? 0) })} · {t("ins.heat.combosCol")} {combos}{inner[n.id] ? ` · ${t("ins.net.inner", { n: inner[n.id]! })}` : ""}</text>
              {drop && <circle cx={r.x + 16} cy={r.y + 16} r={4} fill="var(--crit)"><title>{t("ins.net.dropped")}</title></circle>}
            </g>,
          );
        } else {
          fronts.push(
            <g key={`t-${n.id}`}>
              <text className={`${styles.bl} ${styles.halo}`} x={lx} y={r.y + r.h - 20} textAnchor="middle">{m.label}</text>
              <text className={`${styles.bt} ${styles.halo}`} x={lx} y={r.y + r.h - 7} textAnchor="middle">{m.type}{hiddenIn[n.id] ? ` · ${t("ins.net.managedHidden", { n: hiddenIn[n.id]! })}` : ""}</text>
              {m.chip && <text className={`${styles.bchip} ${styles.halo}`} x={r.x + r.w - 12} y={r.y + 14} textAnchor="end">⚙ {m.chip}</text>}
              {!!inner[n.id] && <text className={`${styles.bchip} ${styles.halo}`} x={r.x + r.w - 12} y={r.y + 14} textAnchor="end">{t("ins.net.inner", { n: inner[n.id]! })}</text>}
            </g>,
          );
          n.children.forEach(drawFront);
        }
        if (n.id.startsWith("ns:") || n.id === "cp" || n.id.startsWith("paas:")) {
          const col = r.collapsed;
          const key = `c:${n.id}`;
          const toggle = () => { setToggled((t) => ({ ...t, [n.id]: !col })); focusLater(key); };
          fronts.push(
            <g key={key} ref={register(key)} className={styles.boxToggle} role="button" tabIndex={0} aria-expanded={!col} aria-label={`${m.label} ${col ? t("ins.net.expand") : t("ins.net.collapse")}`} transform={`translate(${r.x + r.w - 14},${r.y + r.h - 14})`}
              onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>
              <circle r={10} /><text y={5} textAnchor="middle">{col ? "+" : "−"}</text>
            </g>,
          );
        }
        return;
      }
      n.children.forEach(drawFront);
    };
    drawFront(tree);
    return (
      <svg className={styles.netsvg} viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.round(W * 0.85) }} role="group" aria-label={t("ins.net.nestAria")} data-focus={!!sel || undefined}>
        <Markers prefix="nn" />
        {boxes}
        {[...roll.values()].map((r) => {
          const A = center(r.from), B = center(r.to);
          const p0 = clip(A, B.x, B.y), p1 = clip(B, A.x, A.y);
          const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
          const nx = -(p1.y - p0.y), ny = p1.x - p0.x, L = Math.hypot(nx, ny) || 1;
          const d = `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${(mx + (nx / L) * 18).toFixed(1)},${(my + (ny / L) * 18).toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
          const [, color, dash] = ECLS[r.cls];
          const D = Math.hypot(p0.x - p1.x, p0.y - p1.y) || 1;
          const cx = p1.x + ((p0.x - p1.x) / D) * 30, cy = p1.y + ((p0.y - p1.y) / D) * 30;
          const wl = new Set(r.raw.flatMap((e) => [e.from, e.to]).filter((id) => nodeById.get(id)?.kind === "workload")).size;
          const txt = `${r.bundled ? `${t("ins.net.bundleN", { n: wl })} · ` : r.raw.length > 1 ? `×${r.raw.length} ${t("ins.net.links")} · ` : ""}${r.ports.slice(0, 3).join(",")}${r.ports.length > 3 ? "…" : ""} · ${r.count}`;
          const tw = txt.length * 5.6 + 12;
          const chip = rollOn(r) || (!sel && (r.dropped > 0 || r.cls === "internet"));
          return (
            <g key={`${r.from}>${r.to}`} className={styles.edge} data-on={rollOn(r) || undefined}>
              <path className={styles.ehitNet} d={d}><title>{r.raw.map(edgeTitle).join("\n")}</title></path>
              <path d={d} fill="none" stroke={r.dropped ? "var(--crit)" : color} strokeWidth={(thick(r.count, maxC) * (r.bundled ? 1.25 : 1)).toFixed(1)} strokeDasharray={dash} opacity={r.bundled ? 0.7 : 0.85} markerEnd={`url(#nn-${r.cls})`} pointerEvents="none" />
              {chip && <g className={styles.nchip} transform={`translate(${cx.toFixed(1)},${cy.toFixed(1)})`}><rect x={-tw / 2} y={-9} width={tw} height={17} rx={6} /><text textAnchor="middle" y={3.5}>{txt}</text></g>}
            </g>
          );
        })}
        {fronts}
      </svg>
    );
  };

  const paasRows = (n: NetNode): InspectorRow[] => {
    const nw = n.network;
    const rules = !nw ? t("ins.net.f.rulesUnread")
      : nw.noIpFirewall ? t("ins.net.f.noIpFirewall")
        : [nw.defaultAction === "Allow" ? t("ins.net.f.defaultAllow") : nw.defaultAction === "Deny" ? t("ins.net.f.defaultDeny") : "?", nw.ipRules !== null ? t("ins.net.f.ipRules", { n: nw.ipRules }) : null, nw.vnetRules?.length ? t("ins.net.f.vnetRules", { list: nw.vnetRules.join(", ") }) : null].filter(Boolean).join(" · ");
    const via = (n.matchedBy ?? []).map((v) => t(`ins.net.via.${v}`)).join(" · ");
    return [
      { k: t("ins.net.f.host"), v: n.host || "?", ev: n.host ? "cfg" as const : "unk" as const, mono: true, src: t("ins.net.f.armProp") },
      { k: t("ins.net.f.path"), v: n.path ? `${t(`ins.net.path.${n.path}`)} — ${(n.observedIps ?? []).join(", ")}` : t("ins.net.f.notObserved"), ev: n.path ? "obs" as const : "unk" as const, mono: true, src: t("ins.net.f.pathSrc") },
      { k: t("ins.net.f.match"), v: via || "?", ev: (n.matchedBy ?? []).includes("peIp") ? "cfg" as const : "obs" as const },
      { k: "Private Endpoint", v: n.peIps?.length ? n.peIps.join(", ") : t("ins.heat.noneShort"), ev: "cfg" as const, mono: true, src: t("ins.net.f.peSrc") },
      ...(n.sharedIpWith ? [{ k: t("ins.net.f.certainty"), v: t("ins.net.f.sharedV", { with: n.sharedIpWith.join(", ") }), ev: "unk" as const }] : []),
      { k: t("ins.net.f.publicAccess"), v: n.publicAccess ?? t("ins.unknown"), ev: n.publicAccess ? "cfg" as const : "unk" as const },
      { k: t("ins.net.f.rules"), v: rules, ev: nw ? "cfg" as const : "unk" as const, src: nw?.source },
      { k: t("ins.net.f.exposure"), v: t(`ins.net.exposure.${n.exposure ?? "unknown"}`), ev: n.exposure && n.exposure !== "unknown" ? "cfg" as const : "unk" as const },
      { k: t("ins.net.f.keyAuth"), v: t(`ins.net.keyAuth.${n.keyAuth ?? "unknown"}`), ev: n.keyAuth ? "cfg" as const : "unk" as const },
    ];
  };

  // ── Side panel: overview or the selected node ──
  const sideModel = (): InspectorModel => {
    if (!sel || !nodeById.has(sel)) {
      const left = (e: NetEdge) => e.count > e.dropped;
      const paasIds = new Set(net.edges.filter((e) => e.cls === "cloud" && left(e)).map((e) => e.to));
      const paas = net.nodes.filter((n) => n.kind === "paas" && paasIds.has(n.id));
      const byPath = (k: NonNullable<NetNode["path"]>) => paas.filter((n) => n.path === k);
      const exposed = (k: NonNullable<NetNode["exposure"]>) => paas.filter((n) => n.exposure === k);
      const svc = net.nodes.filter((n) => n.kind === "azureService" && net.edges.some((e) => e.to === n.id && left(e)));
      const probes = net.edges.filter((e) => e.from === "probe:lb").reduce((s, e) => s + e.count, 0);
      const remote = net.edges.filter((e) => e.from === "ext:remote-node" && rowById.get(e.to)?.cells.exposure);
      const isMgd = (id: string) => rowById.get(id)?.managed;
      const sent = net.unmatchedExternal.filter((u) => u.count > u.dropped);
      const usr = sent.filter((u) => u.from.some((f) => !isMgd(f) && !f.startsWith("ext:")));
      const mgd = sent.filter((u) => !usr.includes(u));
      const privSent = net.privateExternal.filter((u) => u.count > u.dropped);
      const drops = net.edges.filter((e) => e.dropped);
      const imds = net.edges.filter((e) => e.to === "platform:imds" && nodeById.get(e.from)?.kind === "workload");
      const names = (ns: NetNode[]) => <span className={styles.mono}>{ns.map((n) => n.label).join(", ")}</span>;
      const ipList = (us: typeof sent, own: (f: string) => boolean) => (
        <ul className={styles.ovList}>
          {us.slice(0, 8).map((u) => (
            <li key={u.ip}><span className={styles.mono}>{u.ip}:{u.ports.join(",")}</span>{u.names?.length ? <span className={styles.muted}> {u.names.join(", ")}</span> : null} ← {u.from.filter(own).map(label).join(", ")}</li>
          ))}
          {us.length > 8 && <li className={styles.muted}>{t("ins.net.ov.more", { n: us.length - 8 })}</li>}
        </ul>
      );
      return {
        id: "net-overview", kicker: t("ins.net.ov.kicker"), title: t("ins.net.ov.title"), sub: `${hubbleLabel(net.coverage)} · ${note}`,
        callouts: [
          { tone: byPath("public").length || byPath("mixed").length ? "warn" as const : undefined, content: <>{t("ins.net.ov.path", { n: paas.length, priv: byPath("private").length, pub: byPath("public").length, mixed: byPath("mixed").length })}{byPath("public").length + byPath("mixed").length ? <> — {t("ins.net.ov.pathPublic")}: {names([...byPath("public"), ...byPath("mixed")])}</> : null} <span className={styles.muted}>{t("ins.net.ov.pathBasis")}</span></> },
          { tone: exposed("open").length ? "warn" as const : undefined, content: <>{t("ins.net.ov.exposure", { open: exposed("open").length, restricted: exposed("restricted").length, closed: exposed("closed").length, unknown: exposed("unknown").length })}{exposed("open").length ? <> — <b>{t("ins.net.ov.exposureOpen")}</b>: {names(exposed("open"))}{exposed("open").some((n) => n.keyAuth === "on") ? <> · {t("ins.net.ov.keyOn")}</> : null}</> : null} <span className={styles.muted}>{t("ins.net.ov.exposureBasis")}</span></> },
          ...(svc.length ? [{ tone: "info" as const, content: <>{t("ins.net.ov.services")}: {svc.map((n) => `${n.label} ×${(n.observedIps ?? []).length}`).join(" · ")} <span className={styles.muted}>{t("ins.net.ov.servicesBasis")}</span></> }] : []),
          { content: <>{t("ins.net.ov.unmatched")}: {usr.length ? ipList(usr, (f) => !isMgd(f)) : t("ins.heat.noneShort")}{mgd.length ? <span className={styles.muted}> · {t("ins.net.ov.managedIps", { n: mgd.length })}: {mgd.map((u) => u.ip).join(", ")}</span> : null}{!net.azureMatched && <span className={styles.muted}> {t("ins.net.ov.matchSkipped")}</span>}{net.serviceTagsMatched === false && <span className={styles.muted}> {t("ins.net.ov.tagsSkipped")}</span>}</> },
          ...(privSent.length ? [{ tone: "info" as const, content: <>{t("ins.net.ov.private")}: {ipList(privSent, () => true)} <span className={styles.muted}>{t("ins.net.ov.privateBasis")}</span></> }] : []),
          ...(drops.length ? [{ content: <>{t("ins.net.ov.drops", { n: drops.length })} — {t("ins.net.ov.dropsNotEgress")}<ul className={styles.ovList}>{drops.slice(0, 8).map((e) => <li key={`${e.from}>${e.to}`}>{label(e.from)} → {label(e.to)} <span className={styles.mono}>{e.ports.join(",")}</span> ×{e.dropped}</li>)}{drops.length > 8 && <li className={styles.muted}>{t("ins.net.ov.more", { n: drops.length - 8 })}</li>}</ul></> }] : []),
          { tone: "info" as const, content: <>{t("ins.net.ov.probes", { n: probes })}{remote.length ? <>{t("ins.net.ov.remote1")}{remote.map((e) => `${label(e.to)} ×${e.count}`).join(", ")}{t("ins.net.ov.remote2")}<b>{t("ins.net.ov.remote3")}</b>{t("ins.net.ov.remote4")}</> : null}</> },
          { tone: imds.length ? "warn" as const : "ok" as const, content: imds.length ? <>{t("ins.net.ov.imds")}: {imds.map((e) => label(e.from)).join(", ")} — {t("ins.net.ov.imdsCheck")}</> : <>{t("ins.net.ov.imdsNone")}</> },
        ],
        sections: [],
      };
    }
    const n = nodeById.get(sel)!;
    const row = rowById.get(sel);
    const out = net.edges.filter((e) => e.from === sel), inn = net.edges.filter((e) => e.to === sel);
    const line = (e: NetEdge, other: string, dir: string): InspectorRow => ({
      k: `${dir} ${label(other)}`,
      node: <><span className={styles.ecls} style={{ borderTopColor: ECLS[e.cls][1] }} /><span className={styles.mono}>{e.ports.join(", ")}</span> · <b>{e.count}</b>{e.dropped ? <b style={{ color: "var(--crit)" }}> · DROPPED {e.dropped}</b> : null}{e.note ? ` · ${e.note}` : ""}</>,
      ev: "obs",
    });
    const issues = data.issues.filter((i) => i.nodes.some((x) => x.refs.includes(sel)));
    const kinds: Record<NetNode["kind"], string> = { workload: t("ins.type.workload"), paas: "Azure PaaS", azureService: t("ins.net.kind.azureService"), private: t("ins.net.kind.private"), internet: t("ins.net.kind.internet"), apiserver: t("ins.net.kind.apiserver"), node: t("ins.type.node"), probe: t("ins.net.box.platform"), platform: t("ins.net.box.platform"), unknown: t("ins.net.kind.unknown") };
    return {
      id: `nd-${sel}`, kicker: kinds[n.kind], title: n.id === "ext:world" ? t("ins.net.unknownIp") : n.label, sub: n.sub,
      chips: row?.combos.length ? <>{row.combos.map((c) => <ComboButton key={c.type} combo={c} data={data} nav={nav} />)}</> : undefined,
      sections: [
        { h: t("ins.combos.facts"), rows: [
          ...(row ? [
            { k: t("ins.net.f.location"), v: `${row.namespace} · ${row.kind} ×${row.pods} · ${row.owner}` },
            { k: t("ins.net.f.factors"), node: <><FactorStrip row={row} data={data} /><span className={styles.muted}>{data.factors.filter((f) => row.cells[f.key]).map((f) => f.label).join(" · ") || "-"}</span></>, ev: "cfg" as const },
          ] : []),
          ...(n.kind === "paas" ? paasRows(n) : []),
          ...(n.kind === "azureService" ? [
            { k: t("ins.net.f.tag"), v: n.serviceTag ?? "?", ev: "cfg" as const, src: t("ins.net.f.tagSrc"), mono: true },
            { k: t("ins.net.f.prefix"), v: n.prefix ?? "?", ev: "cfg" as const, mono: true },
            { k: t("ins.net.f.observedIps"), v: (n.observedIps ?? []).join(", "), ev: "obs" as const, mono: true },
          ] : []),
          ...(n.id === "ext:world" || n.id === "ext:private" ? (n.id === "ext:world" ? net.unmatchedExternal : net.privateExternal).map((u) => ({ k: u.ip, v: `:${u.ports.join(",")} ← ${u.from.map(label).join(", ")} · ${u.count}${u.dropped ? ` · DROPPED ${u.dropped}${u.dropped === u.count ? ` (${t("ins.net.f.notLeft")})` : ""}` : ""}${u.names?.length ? ` · ${u.names.join(", ")}` : ""}`, ev: "obs" as const, mono: true })) : []),
          ...(n.kind === "unknown" ? [{ k: t("ins.net.f.ident"), v: t("ins.net.f.identV"), ev: "unk" as const }] : []),
          { k: t("ins.net.f.flowBasis"), v: note },
        ] },
        { h: t("ins.net.inOut", { out: out.length, in: inn.length }), rows: [...out.map((e) => line(e, e.to, "→")), ...inn.map((e) => line(e, e.from, "←"))] },
      ],
      links: [
        ...(row ? [{ label: t("ins.combos.openHeat"), onClick: () => nav.openHeatRow(row.id) }] : []),
        ...issues.map((i) => ({ label: t("ins.heat.openPath", { n: issueNum(data.issues.indexOf(i)) }), onClick: () => nav.openIssue(i.id) })),
      ],
    };
  };

  return (
    <section className={styles.panel} aria-label={t("ins.net.title")}>
      <div className={styles.panelH}>
        <div>
          <h3>{t("ins.net.title")}</h3>
          <div className={styles.sub}><span className={styles.obsChip}>{t("ins.net.obsChip", { cov: hubbleLabel(net.coverage), note })}</span> {t("ins.net.noReplies")}</div>
        </div>
      </div>
      <div className={styles.panelB}>
        <div className={styles.ctrls} style={{ marginBottom: 10 }}>
          <div className={styles.toggle} role="group" aria-label={t("ins.net.viewAria")}>
            <button aria-pressed={view === "nest"} onClick={() => setView("nest")}>{t("ins.net.viewNest")}</button>
            <button aria-pressed={view === "flow"} onClick={() => setView("flow")}>{t("ins.net.viewFlow")}</button>
          </div>
          {view === "nest" && (
            <div className={styles.toggle} role="group" aria-label={t("ins.net.linesAria")} title={t("ins.net.linesHint")}>
              <button aria-pressed={lineMode === "bundle"} onClick={() => setLineMode("bundle")}>{t("ins.net.linesBundle")}</button>
              <button aria-pressed={lineMode === "each"} onClick={() => setLineMode("each")}>{t("ins.net.linesEach")}</button>
            </div>
          )}
          {(Object.keys(ECLS) as NetEdgeClass[]).map((k) => (
            <button key={k} className={styles.fchip} aria-pressed={on[k]} onClick={() => setOn((o) => ({ ...o, [k]: !o[k] }))}>
              <span className={styles.ecls} style={{ borderTopColor: ECLS[k][1], borderTopStyle: ECLS[k][2] ? "dashed" : "solid" }} />{t(ECLS[k][0])}
            </button>
          ))}
          <button className={styles.fchip} aria-pressed={showManaged} onClick={() => setShowManaged(!showManaged)}>{t("ins.net.includeManaged")}</button>
          <button className={styles.fchip} aria-pressed={overlay} onClick={() => setOverlay(!overlay)}>{t("ins.net.overlay")}</button>
        </div>
        <div className={styles.netLayout}>
          <div className={styles.graphWrap}>{view === "nest" ? renderNest() : renderFlow()}</div>
          <aside className={styles.netSide}>
            <Inspector model={sideModel()} onClose={sel ? () => { const prev = sel; onSelect(null); focusLater(`n:${prev}`); } : undefined} autoFocus={!!sel} />
          </aside>
        </div>
        <div className={styles.legend}>
          <span>{t("ins.net.legendStrip", { n: data.factors.length })}</span>
          <span>{t("ins.net.legendBadge")}</span>
          <span><svg width="12" height="12"><circle cx="6" cy="6" r="5.5" fill="var(--warnc)" /></svg> {t("ins.net.legendOpen")}</span>
          <span>{t("ins.net.legendClick")}</span>
        </div>
      </div>
    </section>
  );
}

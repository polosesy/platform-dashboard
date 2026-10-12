"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { AttackEdge, AttackNode, RiskIssue } from "@aud/types";
import { COLS, EVK, TYPE_LABEL, edgeKey } from "./model";
import { EvidenceChip } from "./Inspector";
import styles from "./insights.module.css";

export type GraphSel = { kind: "node" | "edge"; id: string };

const GW = 860;
const colX = (c: number) => 78 + c * 176;
const EDGE_COLOR: Record<AttackEdge["ev"], string> = { obs: "var(--edge-obs)", perm: "var(--edge-perm)", cfg: "var(--edge-cfg)", unk: "var(--unk)" };
const EDGE_DASH: Record<AttackEdge["ev"], string | undefined> = { obs: undefined, perm: "7 4", cfg: "2 3", unk: "2 3" };

/** Up to two lines of ~n characters; the full text is in the inspector. */
export function wrap2(s: string, n = 22): string[] {
  const lines = [""];
  for (const w of s.split(" ")) {
    const cur = lines[lines.length - 1]!;
    if (!cur) lines[lines.length - 1] = w;
    else if ((cur + " " + w).length <= n) lines[lines.length - 1] = cur + " " + w;
    else lines.push(w);
  }
  if (lines.length > 2) { lines.length = 2; lines[1] = lines[1]!.slice(0, n - 1) + "…"; }
  return lines.map((l) => (l.length > n + 4 ? l.slice(0, n + 3) + "…" : l));
}

function Icon({ type }: { type: AttackNode["type"] }) {
  const p = { stroke: "#fff", strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "workload": return <><rect x={-7} y={-6} width={14} height={12} rx={2} {...p} /><path d="M-7 -1 H7 M-2 -6 V6" {...p} /></>;
    case "secret": return <><circle cx={-3} cy={0} r={4} {...p} /><path d="M1 0 H8 M5 0 V3" {...p} /></>;
    case "identity": return <><circle cx={0} cy={-3} r={3.2} {...p} /><path d="M-6 7 C-6 2 6 2 6 7" {...p} /></>;
    case "permission": return <path d="M0 -8 L7 -5 V1 C7 5 4 7 0 9 C-4 7 -7 5 -7 1 V-5 Z" {...p} />;
    case "node": return <><rect x={-7} y={-7} width={14} height={6} rx={1.5} {...p} /><rect x={-7} y={1} width={14} height={6} rx={1.5} {...p} /></>;
    case "azure": return <path d="M-7 5 C-10 5 -10 -1 -6 -1 C-6 -6 2 -7 3 -2 C8 -3 9 5 5 5 Z" {...p} />;
    case "credential": return <><rect x={-7} y={-5} width={14} height={10} rx={2} {...p} /><path d="M-4 -1 H2 M-4 2 H0" {...p} /></>;
    case "impact": return <><path d="M0 -7 L7 6 H-7 Z" {...p} /><path d="M0 -2 V2 M0 4 V4.5" {...p} /></>;
    default: return <><circle r={6} {...p} /><path d="M-6 0 H6 M0 -6 C3 -3 3 3 0 6 C-3 3 -3 -3 0 -6" {...p} /></>;
  }
}

type Props = {
  issue: RiskIssue;
  sel: GraphSel | null;
  cutDone: Set<string>;
  onPick: (s: GraphSel) => void;
  onEscape: () => void;
  register: (key: string, el: SVGGElement | SVGPathElement | null) => void;
};

export function AttackGraph({ issue, sel, cutDone, onPick, onEscape, register }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const used = [...new Set(issue.nodes.map((n) => n.row))].sort((a, b) => a - b);
  const ry = (r: number) => 82 + used.indexOf(r) * 96;
  const pos = new Map(issue.nodes.map((n) => [n.id, { x: colX(n.col), y: ry(n.row), n }]));
  const GH = Math.max(230, ry(used[used.length - 1] ?? 0) + 80);
  const selNode = sel?.kind === "node" ? sel.id : null;
  const selEdge = sel?.kind === "edge" ? sel.id : null;
  const edgeOn = (e: AttackEdge) => (selNode ? e.from === selNode || e.to === selNode : selEdge ? edgeKey(e) === selEdge : true);
  const nodeOn = (id: string) => !sel || (selNode ? id === selNode || issue.edges.some((e) => edgeOn(e) && (e.from === id || e.to === id)) : selEdge!.split(">").includes(id));

  // Fit the viewBox to what was drawn so long labels at the edges are never clipped
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      const bb = svg.getBBox();
      const x0 = Math.min(0, bb.x - 8), y0 = Math.min(0, bb.y - 8);
      svg.setAttribute("viewBox", `${x0} ${y0} ${Math.max(GW, bb.x + bb.width + 8) - x0} ${Math.max(GH, bb.y + bb.height + 8) - y0}`);
    } catch {
      svg.setAttribute("viewBox", `0 0 ${GW} ${GH}`);
    }
  });

  const keyAct = (e: KeyboardEvent, s: GraphSel) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(s); }
    if (e.key === "Escape") { e.preventDefault(); onEscape(); }
  };

  return (
    <svg ref={svgRef} className={styles.graph} viewBox={`0 0 ${GW} ${GH}`} role="group" aria-label={`${issue.title} — 공격 경로. 노드와 간선을 선택하면 상세가 열립니다`}>
      <defs>
        {(["obs", "perm", "cfg", "unk"] as const).map((k) => (
          <marker key={k} id={`arr-${k}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 Z" fill={EDGE_COLOR[k]} />
          </marker>
        ))}
      </defs>
      {COLS.map((t, i) => <text key={t} className={styles.colh} x={colX(i)} y={18} textAnchor="middle">{t}</text>)}
      {COLS.slice(1).map((_, i) => <line key={i} x1={(colX(i) + colX(i + 1)) / 2} y1={28} x2={(colX(i) + colX(i + 1)) / 2} y2={GH - 8} stroke="var(--line)" strokeDasharray="2 4" />)}
      {issue.edges.map((e) => {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) return null;
        const x0 = a.x + 24, x1 = b.x - 24, mx = (x0 + x1) / 2;
        const d = `M${x0},${a.y} C${mx},${a.y} ${mx},${b.y} ${x1},${b.y}`;
        // Fan-out and column-skipping edges crowd the source label: anchor the label near the target
        const fan = issue.edges.filter((x) => x.from === e.from).length > 1;
        const skip = b.n.col - a.n.col > 1;
        const near = skip || fan;
        const lx = near ? x1 - (skip ? 64 : 46) : mx;
        const ly = near ? b.y - 12 : (a.y + b.y) / 2 - 7;
        const k = edgeKey(e);
        const cut = cutDone.has(k);
        const on = edgeOn(e);
        return (
          <g key={k} className={styles.eg} data-dim={!on || undefined} data-sel={selEdge === k || undefined}>
            <path
              ref={(el) => register(`edge:${k}`, el)}
              className={styles.ehit}
              d={d}
              tabIndex={0}
              role="button"
              aria-pressed={selEdge === k}
              aria-label={`${a.n.label} → ${b.n.label}: ${EVK[e.ev]}${e.label ? ` · ${e.label}` : ""}`}
              onClick={() => onPick({ kind: "edge", id: k })}
              onKeyDown={(ev) => keyAct(ev, { kind: "edge", id: k })}
            />
            <path className={styles.vis} d={d} fill="none" stroke={EDGE_COLOR[e.ev]} strokeWidth={e.ev === "obs" ? 2.6 : 2} strokeDasharray={EDGE_DASH[e.ev]} opacity={cut ? 0.25 : e.ev === "unk" ? 0.6 : 0.95} markerEnd={`url(#arr-${e.ev})`} pointerEvents="none" />
            {e.label && <text className={`${styles.elabel} ${styles.halo}`} x={lx} y={ly} textAnchor="middle" pointerEvents="none" textDecoration={cut ? "line-through" : undefined}>{e.label}</text>}
            {cut ? (
              <g transform={`translate(${lx},${ly + 13})`} pointerEvents="none"><circle r={9} fill="var(--surface)" stroke="var(--ok)" strokeWidth={2} /><path d="M-4 -4 L4 4 M4 -4 L-4 4" stroke="var(--ok)" strokeWidth={2} /></g>
            ) : e.cut ? (
              <g transform={`translate(${lx},${ly + 13})`} pointerEvents="none"><title>권장 차단 지점</title><circle r={8} fill="var(--surface)" stroke="var(--accent)" strokeWidth={2} /><path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" stroke="var(--accent)" strokeWidth={1.6} /></g>
            ) : null}
          </g>
        );
      })}
      {issue.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const isSel = selNode === n.id;
        const sub = wrap2(n.sub);
        return (
          <g
            key={n.id}
            ref={(el) => register(`node:${n.id}`, el)}
            className={styles.gnode}
            data-dim={!nodeOn(n.id) || undefined}
            transform={`translate(${p.x},${p.y})`}
            tabIndex={0}
            role="button"
            aria-pressed={isSel}
            aria-label={`${TYPE_LABEL[n.type] ?? n.type} ${n.label}, ${n.sub}${n.unk ? ", 미확인" : ""}`}
            onClick={() => onPick({ kind: "node", id: n.id })}
            onKeyDown={(ev) => keyAct(ev, { kind: "node", id: n.id })}
          >
            <circle r={30} fill="transparent" />
            <circle className={styles.ring} r={27} />
            <circle r={22} fill={n.unk ? "var(--unk)" : `var(--n-${n.type})`} fillOpacity={n.unk ? 0.55 : 1} stroke={n.unk ? "var(--unk)" : undefined} strokeDasharray={n.unk ? "3 3" : undefined} strokeWidth={n.unk ? 1.5 : undefined} />
            <Icon type={n.type} />
            {n.unk && <g transform="translate(16,-16)"><circle r={8} fill="var(--surface)" stroke="var(--unk)" /><text y={3.5} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: "var(--muted)" }}>?</text></g>}
            {(n.badges ?? []).slice(0, 1).map((b) => (
              <g key={b.what} className={styles.bdg} transform="translate(-17,-17)"><title>{`${b.n} ${b.what}`}</title><circle r={8} fill="var(--crit)" /><text y={3.5} textAnchor="middle">{b.n}</text></g>
            ))}
            <text className={`${styles.nlabel} ${styles.halo}`} y={38} textAnchor="middle">{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
            <text className={`${styles.nsub} ${styles.halo}`} y={52} textAnchor="middle">
              {sub.map((l, i) => <tspan key={i} x={0} dy={i ? 13 : 0}>{l}</tspan>)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function AttackTable({ issue, onPick }: { issue: RiskIssue; onPick: (s: GraphSel) => void }) {
  const byId = new Map(issue.nodes.map((n) => [n.id, n]));
  const nb = (n: AttackNode) => <button className={styles.linkish} onClick={() => onPick({ kind: "node", id: n.id })}>{n.label}</button>;
  return (
    <table className={styles.etable}>
      <thead><tr><th>단계</th><th>출발 → 도착</th><th>근거</th><th>내용</th></tr></thead>
      <tbody>
        {issue.edges.map((e) => {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) return null;
          return (
            <tr key={edgeKey(e)}>
              <td>{COLS[a.col]} → {COLS[b.col]}</td>
              <td>{nb(a)} → {nb(b)}</td>
              <td><EvidenceChip ev={e.ev} /></td>
              <td><button className={styles.linkish} onClick={() => onPick({ kind: "edge", id: edgeKey(e) })}>{e.label || "-"}</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

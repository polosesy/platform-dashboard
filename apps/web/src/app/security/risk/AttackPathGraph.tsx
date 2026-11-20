"use client";

// Azure 공격 경로 그림 (2026-11-20 — Wiz Attack Path Visualization): lib/attackPathGraph.ts lays the path out, this draws
// it — circles with an icon per kind, curved edges (dashed = exposure limited to listed sources, red = a role that
// controls or writes and what it reaches), the entry's High findings folded into a badge that opens a box above it,
// hover / focus a node = its chain to the Internet and on to the data is lit, the rest dimmed; zoom − / + / fit.

import { useMemo, useState } from "react";
import type { AzureAttackPath } from "@aud/types";
import { Button } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { edgePath, pathGraph, R, type PathGraph, type PathNode } from "@/lib/attackPathGraph";
import { useWidth } from "../../observability/components/UptimeBars";
import s from "./risk.module.css";

const ICON: Record<PathNode["icon"], string> = {
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.4 3.8 5.5 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.5-3.8-9S9.5 5.4 12 3z",
  server: "M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01",
  identity: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5",
  userIdentity: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5M16 8h5M18.5 5.5v5",
  role: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4",
  keyVault: "M6 10V8a6 6 0 0 1 12 0v2M5 10h14v10H5zM12 14v3",
  storage: "M4 7h16v13H4zM4 7l2-3h12l2 3M9 11h6",
  database: "M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  stop: "M7 7l10 10M17 7L7 17",
};

/** Every node on a chain through `id` — its ancestors back to the Internet and its descendants to the data */
function chainOf(g: PathGraph, id: string): Set<string> {
  const out = new Set([id]);
  const walk = (cur: string, dir: "up" | "down") => {
    for (const e of g.edges) {
      const next = dir === "up" ? (e.to === cur ? e.from : null) : (e.from === cur ? e.to : null);
      if (next && !out.has(next)) { out.add(next); walk(next, dir); }
    }
  };
  walk(id, "up"); walk(id, "down");
  return out;
}

export function AttackPathGraph({ path, rolesAboveHidden }: { path: AzureAttackPath; rolesAboveHidden?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit the width
  const [ref, w] = useWidth<HTMLDivElement>();
  const g = useMemo(() => pathGraph(path, { expandFindings: open, rolesAboveHidden }), [path, open, rolesAboveHidden]);
  const lit = focus ? chainOf(g, focus) : null;
  const fit = w > 0 ? Math.min(1.2, w / g.width) : 1;
  const scale = zoom ?? fit;
  const text = (key: string | undefined, vars: Record<string, string | number> | undefined, plain?: string) => {
    if (plain !== undefined) return plain;
    if (!key) return "";
    const v: Record<string, string | number> = { ...(vars ?? {}) };
    if (typeof v.rw === "string") v.rw = t(`azp.${v.rw}`);
    if (typeof v.scope === "string") v.scope = t(`azr.scope.${v.scope}`);
    return t(key, v);
  };
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));

  return (
    <div className={s.apg}>
      <div className={s.apgTools}>
        <span className={s.dim}>{t("apg.hint")}</span>
        <span className={s.apgZoom}>
          <Button size="sm" onClick={() => setZoom(Math.max(0.4, +(scale - 0.15).toFixed(2)))} ariaLabel={t("apg.zoomOut")}>−</Button>
          <span className={s.apgScale}>{Math.round(scale * 100)}%</span>
          <Button size="sm" onClick={() => setZoom(Math.min(2, +(scale + 0.15).toFixed(2)))} ariaLabel={t("apg.zoomIn")}>+</Button>
          <Button size="sm" onClick={() => setZoom(null)}>{t("apg.fit")}</Button>
        </span>
      </div>
      <div ref={ref} className={s.apgCanvas}>
        <svg width={g.width * scale} height={g.height * scale} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={t("apg.aria", { name: path.entry.name })}>
          {g.findings ? (
            <g className={s.apgBox}>
              <rect x={g.findings.x} y={g.findings.y} width={g.findings.w} height={g.findings.h} rx={6} />
              <text className={s.apgBoxHead} x={g.findings.x + 12} y={g.findings.y + 22}>{t("apg.findings", { n: path.vuln?.count ?? 0 })}</text>
              {g.findings.items.map((f, i) => <text key={f} className={s.apgBoxItem} x={g.findings!.x + 12} y={g.findings!.y + 48 + i * 26}>{clip(f, 30)}<title>{f}</title></text>)}
              {g.findings.more ? <text className={s.apgBoxItem} x={g.findings.x + 12} y={g.findings.y + 48 + g.findings.items.length * 26}>{t("apg.findingsMore", { n: g.findings.more })}</text> : null}
              <line className={s.apgBoxLink} x1={nodeById.get("entry")!.x} x2={nodeById.get("entry")!.x} y1={g.findings.y + g.findings.h} y2={nodeById.get("entry")!.y - R - 12} />
            </g>
          ) : null}
          {g.edges.map((e) => {
            const a = nodeById.get(e.from)!, b = nodeById.get(e.to)!;
            return <path key={e.id} className={s.apgEdge} data-kind={e.kind} data-danger={e.danger || undefined} data-limited={e.limited || undefined}
              data-dim={lit && !(lit.has(e.from) && lit.has(e.to)) ? "" : undefined} d={edgePath(a, b)} />;
          })}
          {g.nodes.map((n) => {
            const label = text(n.labelKey, n.vars, n.label);
            const sub = text(n.subKey, n.subVars, n.sub);
            const toggles = n.kind === "entry" && !!path.vuln;
            return (
              <g key={n.id} className={s.apgNode} data-tone={n.tone} data-kind={n.kind} data-dim={lit && !lit.has(n.id) ? "" : undefined}
                transform={`translate(${n.x},${n.y})`} tabIndex={0} role={toggles ? "button" : undefined} aria-expanded={toggles ? open : undefined}
                aria-label={`${label}${sub ? ` — ${sub}` : ""}${n.badge ? ` — ${t("apg.findings", { n: n.badge })}` : ""}`}
                onMouseEnter={() => setFocus(n.id)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(n.id)} onBlur={() => setFocus(null)}
                onClick={toggles ? () => setOpen((o) => !o) : undefined}
                onKeyDown={toggles ? (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen((o) => !o); } } : undefined}>
                <circle r={R} />
                <path className={s.apgIcon} d={ICON[n.icon]} transform="translate(-12,-12)" />
                {n.badge ? (
                  <g className={s.apgCount} transform={`translate(${R - 4},${-R + 4})`}>
                    <circle r={10} />
                    <text y={4}>{n.badge > 99 ? "99+" : n.badge}</text>
                  </g>
                ) : null}
                <text className={s.apgLabel} y={R + 16}>{clip(label + (n.viaKeys ? ` · ${t("azp.viaKeys")}` : ""), 24)}<title>{label}{n.kind === "entry" ? ` (${path.entry.type})` : ""}</title></text>
                {sub ? <text className={s.apgSub} y={R + 31}>{clip(sub, 28)}</text> : null}
                {toggles ? <text className={s.apgSub} y={R + 46}>{open ? t("apg.collapse") : t("apg.expand")}</text> : null}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={s.apgLegend}>
        <li data-k="exposure"><i aria-hidden="true" />{t("apg.lg.exposure")}</li>
        <li data-k="limited"><i aria-hidden="true" />{t("apg.lg.limited")}</li>
        <li data-k="identity"><i aria-hidden="true" />{t("apg.lg.identity")}</li>
        <li data-k="danger"><i aria-hidden="true" />{t("apg.lg.danger")}</li>
        <li data-k="read"><i aria-hidden="true" />{t("apg.lg.read")}</li>
      </ul>
    </div>
  );
}

const clip = (x: string, n: number) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

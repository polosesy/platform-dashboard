"use client";

import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import type { PolicyInsightsResponse, RiskFactorKey, WorkloadRiskRow } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { issueNum, type InsightLabels, type InsightsNav, type TFn } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import { EvidenceChip, Inspector, type InspectorModel, type InspectorRow } from "./Inspector";
import { WEIGHT_GLYPH, cellText, hitCount, showsCellText, sortRows, splitFactors, textColumns, visibleFactors, type HeatSort } from "./heatView";
import { Segmented } from "@/components/ui";
import styles from "./insights.module.css";

export type HeatSel = { row: string; key: RiskFactorKey | null };

type Props = {
  data: PolicyInsightsResponse;
  sel: HeatSel | null;
  onSelect: (sel: HeatSel | null) => void;
  showManaged: boolean;
  onShowManaged: (v: boolean) => void;
  nav: InsightsNav;
};

export function ComboButton({ combo, data, nav }: { combo: WorkloadRiskRow["combos"][number]; data: PolicyInsightsResponse; nav: InsightsNav }) {
  const { t } = useI18n();
  const { COMBO_LABEL, COMBO_FORMULA } = useInsightLabels();
  if (!combo.issueId) {
    return <span className={styles.cpill} data-na="true" title={t("ins.heat.managedHint")}>{COMBO_LABEL[combo.type]}</span>;
  }
  const idx = data.issues.findIndex((i) => i.id === combo.issueId);
  const issue = data.issues[idx];
  const label = combo.type === "takeover" && issue?.sev === "warn" ? t("ins.heat.takeoverWarn") : COMBO_LABEL[combo.type];
  return (
    <button className={styles.cpill} onClick={() => nav.openIssue(combo.issueId!)} title={`${COMBO_FORMULA[combo.type]} → ${t("ins.heat.comboN", { n: issueNum(idx) })}`}>
      {issueNum(idx)} {label}
    </button>
  );
}

export function FactorStrip({ row, data }: { row: WorkloadRiskRow; data: PolicyInsightsResponse }) {
  return (
    <span className={styles.strip} aria-hidden="true">
      {data.factors.map((f) => <i key={f.key} data-w={row.cells[f.key] ? row.weights[f.key] : undefined} title={f.label} />)}
    </span>
  );
}

function heatModel(data: PolicyInsightsResponse, r: WorkloadRiskRow, key: RiskFactorKey | null, nav: InsightsNav, t: TFn, lb: InsightLabels): InspectorModel {
  const { COMBO_FORMULA, EVK, WEIGHT_LABEL, flowNote, hubbleLabel } = lb;
  const none = t("ins.heat.none");
  const f = key ? data.factors.find((x) => x.key === key)! : null;
  const user = data.rows.filter((x) => !x.managed);
  const net = data.network;
  const nodeLabel = (id: string) => net.nodes.find((n) => n.id === id)?.label ?? id;
  const groups = [...new Set(data.factors.map((x) => x.group))];
  const cellSections: InspectorModel["sections"] = [];
  if (f && key) {
    const v = r.cells[key];
    const rows: InspectorRow[] = [
      { k: t("ins.heat.value"), v: v ?? none, ev: v ? f.ev : undefined, mono: true },
      { k: t("ins.heat.criteria"), v: f.desc },
      { k: t("ins.heat.weight"), v: v ? WEIGHT_LABEL[r.weights[key] ?? f.weight] : "-" },
    ];
    if (key === "extEgress") {
      const eg = net.edges.filter((e) => e.from === r.id && (e.cls === "cloud" || e.cls === "internet"));
      rows.push(eg.length
        ? { k: t("ins.heat.observedDest"), node: <>{eg.map((e) => <div key={e.to}>{nodeLabel(e.to)} <span className={`${styles.mono} ${styles.muted}`}>{e.ports.join(",")} · {e.count}</span></div>)}</>, ev: "obs", src: `${hubbleLabel(net.coverage)} · ${flowNote(net.coverage)}` }
        : { k: t("ins.heat.observedDest"), v: net.available ? t("ins.heat.noneObserved", { cov: hubbleLabel(net.coverage) }) : `${t("ins.heat.noHubble")} — ${net.reason ?? ""}`, ev: net.available ? "obs" : "unk" });
    }
    if (key === "highRbac") {
      for (const m of data.matrix.filter((x) => x.workloadId === r.id)) {
        rows.push(
          { k: t("ins.heat.binding"), v: `${m.kind} ${m.binding} → ${m.role}`, ev: "perm", mono: true, src: "RBAC API" },
          { k: t("ins.heat.rules"), v: m.rules.join(" | "), ev: "perm", mono: true, src: "resources:verbs" },
          ...(m.conditional.length ? [{ k: t("ins.perm.conditionalShort"), v: m.conditional.map((k) => data.riskDict.find((d) => d.key === k)?.label ?? k).join(", "), ev: "unk" as const, src: t("ins.perm.condWeak") }] : []),
        );
      }
    }
    const combos = r.combos.filter((c) => c.keys.includes(key));
    const same = user.filter((x) => x.cells[key]);
    cellSections.push(
      { h: t("ins.heat.cellDetail", { label: f.label }), rows },
      { h: t("ins.heat.cellCombos", { n: combos.length }), body: combos.length ? <>{combos.map((c) => <div key={c.type} style={{ marginBottom: 6 }}><ComboButton combo={c} data={data} nav={nav} /><div className={styles.muted} style={{ fontSize: 12, marginTop: 3 }}>{COMBO_FORMULA[c.type]}</div></div>)}</> : <div className={styles.muted}>{t("ins.heat.alone")}</div> },
      { h: t("ins.heat.same", { n: same.length, m: user.length }), body: <div className={styles.ctrls}>{same.map((x) => <button key={x.id} className={styles.fchip} aria-pressed={x.id === r.id} onClick={() => nav.openHeatRow(x.id)}>{x.name}</button>)}</div> },
    );
  }
  const comboKeys = new Set(r.combos.flatMap((c) => c.keys));
  const { hits, nonHits } = splitFactors(r, data.factors);
  const factorRows: InspectorRow[] = groups.flatMap((g) => hits.filter((x) => x.group === g).map((x) => ({
    k: `${comboKeys.has(x.key) ? "◆ " : ""}${g} · ${x.label}`, v: r.cells[x.key] ?? none, ev: x.ev, key: comboKeys.has(x.key),
  })));
  const out = net.edges.filter((e) => e.from === r.id), inn = net.edges.filter((e) => e.to === r.id);
  const ext = out.filter((e) => e.cls === "cloud" || e.cls === "internet").slice(0, 3);
  const imgs = data.kbom.items.filter((x) => x.workloads.includes(r.id));
  return {
    id: `hx-${r.id}-${key ?? "row"}`,
    kicker: f ? `${f.group} · ${t("ins.heat.evidence")} ${EVK[f.ev]} · ${r.cells[key!] ? WEIGHT_LABEL[r.weights[key!] ?? f.weight] : none}` : `${t("ins.col.1")} · ${r.namespace} · ${r.kind} ×${r.pods} · ${r.owner}`,
    title: f ? `${r.name} — ${f.label}` : r.name,
    sub: f ? `${r.namespace} · ${r.kind} ×${r.pods}` : r.managed ? t("ins.heat.managedHint") : `${t("ins.heat.sa")} ${r.namespace}/${r.serviceAccount}`,
    chips: r.combos.length ? <>{r.combos.map((c) => <ComboButton key={c.type} combo={c} data={data} nav={nav} />)}</> : undefined,
    sections: [
      ...cellSections,
      { h: t("ins.heat.factors", { n: hits.length, m: data.factors.length }), rows: factorRows },
      ...(nonHits.length ? [{ h: t("ins.heat.nonHits", { n: nonHits.length }), body: (
        <details className={styles.nonHits}><summary>{t("ins.heat.nonHitsShow")}</summary>{nonHits.map((x) => `${x.group} · ${x.label}`).join(" · ")}</details>
      ) }] : []),
      { h: t("ins.heat.netImages"), rows: [
        { k: t("ins.heat.conn"), v: net.available ? t("ins.heat.inOut", { out: out.length, in: inn.length }) : t("ins.heat.noHubble"), ev: net.available ? "obs" : "unk", src: hubbleLabel(net.coverage) },
        { k: t("ins.heat.topExternal"), v: ext.map((e) => `${nodeLabel(e.to)} ${e.ports.join(",")}`).join(" · ") || t("ins.heat.notObserved") },
        ...imgs.map((x) => ({ k: `${t("ins.heat.image")} · ${x.tech}`, v: `${x.versions.join(", ")} · ${x.registry}${x.flags.length ? ` · ${x.flags.map((fl) => fl.label).join(", ")}` : ""}`, mono: true })),
      ] },
    ],
    links: [
      ...(net.nodes.some((n) => n.id === r.id) ? [{ label: t("ins.heat.openNet"), onClick: () => nav.openNet(r.id) }] : []),
      ...r.combos.filter((c) => c.issueId).map((c) => ({ label: t("ins.heat.openPath", { n: issueNum(data.issues.findIndex((i) => i.id === c.issueId)) }), onClick: () => nav.openIssue(c.issueId!) })),
    ],
  };
}

export function RiskHeatmap({ data, sel, onSelect, showManaged, onShowManaged, nav }: Props) {
  const { t } = useI18n();
  const lb = useInsightLabels();
  const { EVK, hubbleLabel } = lb;
  const none = t("ins.heat.none");
  const [sortBy, setSortBy] = useState<HeatSort>("risk");
  const [showEmpty, setShowEmpty] = useState(false);
  const rows = sortRows(data.rows.filter((r) => showManaged || !r.managed), data.factors, sortBy);
  const user = data.rows.filter((r) => !r.managed);
  const managedCount = data.rows.length - user.length;
  // Columns nobody hits are folded (toggle) — the matrix shows what matters at a glance
  const F = visibleFactors(rows, data.factors, showEmpty);
  const emptyCols = data.factors.length - visibleFactors(rows, data.factors, false).length;
  const txtCols = textColumns(rows, data.factors);
  const groups = [...new Set(F.map((f) => f.group))];
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const [tip, setTip] = useState("");
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const fr = Math.min(focus.r, Math.max(0, rows.length - 1));
  const openRow = sel ? rows.find((r) => r.id === sel.row) : undefined;

  const focusCell = (r: number, c: number) => {
    setFocus({ r, c });
    cells.current.get(`${r}:${c}`)?.focus();
  };
  const toggle = (r: number, key: RiskFactorKey | null) => {
    const row = rows[r]!;
    const same = sel?.row === row.id && sel.key === key;
    onSelect(same ? null : { row: row.id, key });
  };
  const onKey = (e: KeyboardEvent<HTMLTableCellElement>, r: number, c: number) => {
    const maxR = rows.length - 1, maxC = F.length - 1;
    let nr = r, nc = c;
    switch (e.key) {
      case "ArrowRight": nc = Math.min(maxC, c + 1); break;
      case "ArrowLeft": nc = Math.max(0, c - 1); break;
      case "ArrowDown": nr = Math.min(maxR, r + 1); break;
      case "ArrowUp": nr = Math.max(0, r - 1); break;
      case "Home": nc = 0; if (e.ctrlKey) nr = 0; break;
      case "End": nc = maxC; if (e.ctrlKey) nr = maxR; break;
      case "Enter":
      case " ":
        e.preventDefault();
        setFocus({ r, c });
        toggle(r, F[c]!.key);
        return;
      case "Escape":
        if (sel) { e.preventDefault(); onSelect(null); }
        return;
      default:
        return;
    }
    e.preventDefault();
    focusCell(nr, nc);
  };
  const closeDetail = () => {
    onSelect(null);
    cells.current.get(`${fr}:${focus.c}`)?.focus();
  };

  return (
    <section className={styles.panel} aria-label={t("ins.heat.title")}>
      <div className={styles.panelH}>
        <div>
          <h3>{t("ins.heat.titleFull")}</h3>
          <div className={styles.sub}>{t("ins.heat.sub")}</div>
        </div>
        <div className={styles.ctrls}>
          <Segmented label={t("ins.heat.sort")} value={sortBy} onChange={setSortBy}
            items={[{ id: "risk" as HeatSort, label: t("ins.heat.sortRisk") }, { id: "name" as HeatSort, label: t("ins.heat.sortName") }]} />
          {emptyCols > 0 && (
            <button className={styles.fchip} aria-pressed={showEmpty} onClick={() => setShowEmpty(!showEmpty)}>
              {showEmpty ? t("ins.heat.hideEmptyCols", { n: emptyCols }) : t("ins.heat.showEmptyCols", { n: emptyCols })}
            </button>
          )}
          <button className={styles.fchip} aria-pressed={showManaged} onClick={() => onShowManaged(!showManaged)}>
            {showManaged ? t("ins.heat.hideManaged", { n: managedCount }) : t("ins.heat.showManaged", { n: managedCount })}
          </button>
        </div>
      </div>
      <div className={styles.panelB}>
        {rows.length === 0 ? (
          <div className={styles.notice}>{t("ins.heat.noWorkloads")}</div>
        ) : (
          <div className={styles.heatLayout} data-open={!!openRow || undefined}>
          <div className={styles.heatWrap}>
            <table className={styles.heat} role="grid" aria-label={t("ins.heat.title")} onFocus={(e) => { const t = (e.target as HTMLElement).dataset.tip; if (t) setTip(t); }}>
              <thead>
                <tr>
                  <th />
                  {groups.map((g) => <th key={g} data-grp="true" colSpan={F.filter((f) => f.group === g).length}>{g}</th>)}
                  <th />
                </tr>
                <tr>
                  <th className={styles.wl} scope="col">{t("ins.col.1")} <span className={styles.muted}>({rows.length})</span></th>
                  {F.map((f) => (
                    <th key={f.key} scope="col" title={`${f.desc} · ${t("ins.heat.evidence")}: ${EVK[f.ev]}`} data-obs={f.ev === "obs" || undefined} data-hl={sel?.key === f.key || undefined}>
                      {f.label}
                      {f.ev === "obs" && <span className={styles.sr}> ({t("ins.ev.obs")} · {hubbleLabel(data.network.coverage)})</span>}
                      <span className={styles.tot}>{user.filter((r) => r.cells[f.key]).length}/{user.length}</span>
                    </th>
                  ))}
                  <th scope="col" style={{ textAlign: "left" }}>{t("ins.heat.summaryCol")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => {
                  const comboKeys = new Set(r.combos.flatMap((c) => c.keys));
                  const open = sel?.row === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr data-row={r.id}>
                        <th scope="row" className={styles.wl}>
                          <button className={styles.rowbtn} aria-expanded={open && !sel?.key} onClick={() => { setFocus({ r: ri, c: focus.c }); toggle(ri, null); }}>{r.name}</button>
                          <div className={styles.rowOwner}>{r.namespace} · {r.kind} ×{r.pods} · {r.owner}</div>
                        </th>
                        {F.map((f, ci) => {
                          const v = r.cells[f.key];
                          const isSel = open && sel?.key === f.key;
                          return (
                            <td
                              key={f.key}
                              ref={(el) => { if (el) cells.current.set(`${ri}:${ci}`, el); else cells.current.delete(`${ri}:${ci}`); }}
                              role="gridcell"
                              className={styles.cell}
                              tabIndex={fr === ri && focus.c === ci ? 0 : -1}
                              data-w={v ? r.weights[f.key] ?? f.weight : undefined}
                              data-combo={(v && comboKeys.has(f.key)) || undefined}
                              data-tip={`${r.name} · ${f.label}: ${v ?? none}`}
                              aria-selected={isSel}
                              aria-label={`${r.name} · ${f.label}: ${v ? v.slice(0, 60) : t("ins.heat.noneShort")} · ${EVK[f.ev]}`}
                              onClick={() => { setFocus({ r: ri, c: ci }); toggle(ri, f.key); }}
                              onKeyDown={(e) => onKey(e, ri, ci)}
                              onMouseEnter={() => setTip(`${r.name} · ${f.label}: ${v ?? none}`)}
                            >
                              {v ? (
                                <span className={styles.cellTxt}><b aria-hidden="true">{WEIGHT_GLYPH[r.weights[f.key] ?? f.weight] ?? "●"}</b>{showsCellText(r, f, txtCols) ? cellText(v) : null}</span>
                              ) : <span className={styles.cellNone} aria-hidden="true">·</span>}
                              {v && f.ev === "obs" && <span className={styles.obsDot} />}
                            </td>
                          );
                        })}
                        <td className={styles.combosCell}>
                          <span className={styles.muted}>{t("ins.heat.summary", { n: hitCount(r, data.factors) })}</span>
                          {r.combos.map((c) => <ComboButton key={c.type} combo={c} data={data} nav={nav} />)}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Detail drawer: beside the matrix on wide screens, below it on narrow ones — the matrix stays readable */}
          {openRow && (
            <aside className={styles.heatDrawer} aria-label={openRow.name}>
              <Inspector model={heatModel(data, openRow, sel!.key, nav, t, lb)} onClose={closeDetail} />
            </aside>
          )}
          </div>
        )}
        <div className={styles.heatTip} aria-live="polite">{tip}</div>
        <div className={styles.legend}>
          <span><i className={styles.lgCrit}>{WEIGHT_GLYPH.crit}</i>{t("ins.heat.legendCrit")}</span>
          <span><i className={styles.lgWarn}>{WEIGHT_GLYPH.warn}</i>{t("ins.heat.legendWarn")}</span>
          <span><i className={styles.lgLow}>{WEIGHT_GLYPH.low}</i>{t("ins.weight.low")}</span>
          <span><i className={styles.lgCombo} />{t("ins.heat.legendCombo")}</span>
          <span><EvidenceChip ev="obs" text="●" /> {t("ins.heat.legendObs")}</span>
          <span>{t("ins.heat.legendCount", { n: user.length })}</span>
        </div>
      </div>
    </section>
  );
}

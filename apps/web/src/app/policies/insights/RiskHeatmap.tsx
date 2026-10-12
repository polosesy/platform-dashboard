"use client";

import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import type { PolicyInsightsResponse, RiskFactorKey, WorkloadRiskRow } from "@aud/types";
import { COMBO_FORMULA, COMBO_LABEL, EVK, WEIGHT_LABEL, flowNote, hubbleLabel, issueNum, type InsightsNav } from "./model";
import { EvidenceChip, Inspector, type InspectorModel, type InspectorRow } from "./Inspector";
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
  if (!combo.issueId) {
    return <span className={styles.cpill} data-na="true" title="AKS 관리 — 직접 수정 불가, 보완 통제 대상">{COMBO_LABEL[combo.type]}</span>;
  }
  const idx = data.issues.findIndex((i) => i.id === combo.issueId);
  const issue = data.issues[idx];
  const label = combo.type === "takeover" && issue?.sev === "warn" ? "클러스터 장악 경로 · 판정 주의" : COMBO_LABEL[combo.type];
  return (
    <button className={styles.cpill} onClick={() => nav.openIssue(combo.issueId!)} title={`${COMBO_FORMULA[combo.type]} → 위험 조합 ${issueNum(idx)}`}>
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

function heatModel(data: PolicyInsightsResponse, r: WorkloadRiskRow, key: RiskFactorKey | null, nav: InsightsNav): InspectorModel {
  const f = key ? data.factors.find((x) => x.key === key)! : null;
  const user = data.rows.filter((x) => !x.managed);
  const net = data.network;
  const nodeLabel = (id: string) => net.nodes.find((n) => n.id === id)?.label ?? id;
  const groups = [...new Set(data.factors.map((x) => x.group))];
  const cellSections: InspectorModel["sections"] = [];
  if (f && key) {
    const v = r.cells[key];
    const rows: InspectorRow[] = [
      { k: "이 워크로드의 값", v: v ?? "해당 없음", ev: v ? f.ev : undefined, mono: true },
      { k: "판정 기준", v: f.desc },
      { k: "가중치", v: v ? WEIGHT_LABEL[r.weights[key] ?? f.weight] : "-" },
    ];
    if (key === "extEgress") {
      const eg = net.edges.filter((e) => e.from === r.id && (e.cls === "cloud" || e.cls === "internet"));
      rows.push(eg.length
        ? { k: "관측 목적지", node: <>{eg.map((e) => <div key={e.to}>{nodeLabel(e.to)} <span className={`${styles.mono} ${styles.muted}`}>{e.ports.join(",")} · {e.count}</span></div>)}</>, ev: "obs", src: `${hubbleLabel(net.coverage)} · ${flowNote(net.coverage)}` }
        : { k: "관측 목적지", v: net.available ? `관측 구간(${hubbleLabel(net.coverage)}) 동안 없음 — 부재의 증거 아님` : `Hubble 데이터 없음 — ${net.reason ?? ""}`, ev: net.available ? "obs" : "unk" });
    }
    if (key === "highRbac") {
      for (const m of data.matrix.filter((x) => x.workloadId === r.id)) {
        rows.push(
          { k: "바인딩", v: `${m.kind} ${m.binding} → ${m.role}`, ev: "perm", mono: true, src: "RBAC API" },
          { k: "규칙 원문", v: m.rules.join(" | "), ev: "perm", mono: true, src: "resources:verbs" },
          ...(m.conditional.length ? [{ k: "조건부", v: m.conditional.map((k) => data.riskDict.find((d) => d.key === k)?.label ?? k).join(", "), ev: "unk" as const, src: "약한 동사로만 성립 — 미검증" }] : []),
        );
      }
    }
    const combos = r.combos.filter((c) => c.keys.includes(key));
    const same = user.filter((x) => x.cells[key]);
    cellSections.push(
      { h: `${f.label} — 칸 상세`, rows },
      { h: `이 칸이 만드는 위험 조합 ${combos.length}`, body: combos.length ? <>{combos.map((c) => <div key={c.type} style={{ marginBottom: 6 }}><ComboButton combo={c} data={data} nav={nav} /><div className={styles.muted} style={{ fontSize: 12, marginTop: 3 }}>{COMBO_FORMULA[c.type]}</div></div>)}</> : <div className={styles.muted}>이 칸은 단독 요인입니다.</div> },
      { h: `같은 요인을 가진 워크로드 ${same.length}/${user.length}`, body: <div className={styles.ctrls}>{same.map((x) => <button key={x.id} className={styles.fchip} aria-pressed={x.id === r.id} onClick={() => nav.openHeatRow(x.id)}>{x.name}</button>)}</div> },
    );
  }
  const comboKeys = new Set(r.combos.flatMap((c) => c.keys));
  const factorRows: InspectorRow[] = groups.flatMap((g) => data.factors.filter((x) => x.group === g).map((x) => ({
    k: `${comboKeys.has(x.key) ? "◆ " : ""}${g} · ${x.label}`, v: r.cells[x.key] ?? "해당 없음", ev: r.cells[x.key] ? x.ev : undefined, off: !r.cells[x.key], key: comboKeys.has(x.key),
  })));
  const out = net.edges.filter((e) => e.from === r.id), inn = net.edges.filter((e) => e.to === r.id);
  const ext = out.filter((e) => e.cls === "cloud" || e.cls === "internet").slice(0, 3);
  const imgs = data.kbom.items.filter((x) => x.workloads.includes(r.id));
  return {
    id: `hx-${r.id}-${key ?? "row"}`,
    kicker: f ? `${f.group} · 근거 ${EVK[f.ev]} · ${r.cells[key!] ? WEIGHT_LABEL[r.weights[key!] ?? f.weight] : "해당 없음"}` : `워크로드 · ${r.namespace} · ${r.kind} ×${r.pods} · ${r.owner}`,
    title: f ? `${r.name} — ${f.label}` : r.name,
    sub: f ? `${r.namespace} · ${r.kind} ×${r.pods}` : r.managed ? "AKS 관리 — 직접 수정 불가, 보완 통제 대상" : `서비스 계정 ${r.namespace}/${r.serviceAccount}`,
    chips: r.combos.length ? <>{r.combos.map((c) => <ComboButton key={c.type} combo={c} data={data} nav={nav} />)}</> : undefined,
    sections: [
      ...cellSections,
      { h: `요인 ${data.factors.filter((x) => r.cells[x.key]).length}/${data.factors.length} (◆ = 위험 조합을 이루는 요인)`, rows: factorRows, grid: true },
      { h: "네트워크 · 이미지", rows: [
        { k: "연결", v: net.available ? `나가는 ${out.length} · 들어오는 ${inn.length}` : "Hubble 데이터 없음", ev: net.available ? "obs" : "unk", src: hubbleLabel(net.coverage) },
        { k: "클러스터 밖 상위", v: ext.map((e) => `${nodeLabel(e.to)} ${e.ports.join(",")}`).join(" · ") || "관측 없음" },
        ...imgs.map((x) => ({ k: `이미지 · ${x.tech}`, v: `${x.versions.join(", ")} · ${x.registry}${x.flags.length ? ` · ${x.flags.map((fl) => fl.label).join(", ")}` : ""}`, mono: true })),
      ] },
    ],
    links: [
      ...(net.nodes.some((n) => n.id === r.id) ? [{ label: "네트워크 맵에서 보기", onClick: () => nav.openNet(r.id) }] : []),
      ...r.combos.filter((c) => c.issueId).map((c) => ({ label: `공격 경로 ${issueNum(data.issues.findIndex((i) => i.id === c.issueId))} 열기`, onClick: () => nav.openIssue(c.issueId!) })),
    ],
  };
}

export function RiskHeatmap({ data, sel, onSelect, showManaged, onShowManaged, nav }: Props) {
  const rows = data.rows.filter((r) => showManaged || !r.managed);
  const user = data.rows.filter((r) => !r.managed);
  const managedCount = data.rows.length - user.length;
  const F = data.factors;
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
    <section className={styles.panel} aria-label="위험 요인 히트맵">
      <div className={styles.panelH}>
        <div>
          <h3>위험 요인 히트맵 · 워크로드 × 요인</h3>
          <div className={styles.sub}>굵은 테두리 = 위험 조합을 이루는 칸. 칸을 누르거나 방향키 + Enter로 상세, Esc로 닫기.</div>
        </div>
        <div className={styles.ctrls}>
          <button className={styles.fchip} aria-pressed={showManaged} onClick={() => onShowManaged(!showManaged)}>
            {showManaged ? `AKS 관리 구성요소 ${managedCount}개 숨기기` : `AKS 관리 구성요소 ${managedCount}개 포함`}
          </button>
        </div>
      </div>
      <div className={styles.panelB}>
        {rows.length === 0 ? (
          <div className={styles.notice}>파드를 실행 중인 워크로드가 없습니다.</div>
        ) : (
          <div className={styles.heatWrap}>
            <table className={styles.heat} role="grid" aria-label="위험 요인 히트맵" onFocus={(e) => { const t = (e.target as HTMLElement).dataset.tip; if (t) setTip(t); }}>
              <thead>
                <tr>
                  <th />
                  {groups.map((g) => <th key={g} data-grp="true" colSpan={F.filter((f) => f.group === g).length}>{g}</th>)}
                  <th />
                </tr>
                <tr>
                  <th className={styles.wl} scope="col">워크로드 <span className={styles.muted}>({rows.length})</span></th>
                  {F.map((f) => (
                    <th key={f.key} scope="col" title={`${f.desc} · 근거: ${EVK[f.ev]}`} data-obs={f.ev === "obs" || undefined} data-hl={sel?.key === f.key || undefined}>
                      {f.label}
                      {f.ev === "obs" && <span className={styles.sr}> (Hubble 관측 · {hubbleLabel(data.network.coverage)})</span>}
                      <span className={styles.tot}>{user.filter((r) => r.cells[f.key]).length}/{user.length}</span>
                    </th>
                  ))}
                  <th scope="col" style={{ textAlign: "left" }}>위험 조합</th>
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
                              data-tip={`${r.name} · ${f.label}: ${v ?? "해당 없음"}`}
                              aria-selected={isSel}
                              aria-label={`${r.name} · ${f.label}: ${v ? v.slice(0, 60) : "없음"} · ${EVK[f.ev]}`}
                              onClick={() => { setFocus({ r: ri, c: ci }); toggle(ri, f.key); }}
                              onKeyDown={(e) => onKey(e, ri, ci)}
                              onMouseEnter={() => setTip(`${r.name} · ${f.label}: ${v ?? "해당 없음"}`)}
                            >
                              {v && f.ev === "obs" && <span className={styles.obsDot} />}
                            </td>
                          );
                        })}
                        <td className={styles.combosCell}>
                          {r.combos.length ? r.combos.map((c) => <ComboButton key={c.type} combo={c} data={data} nav={nav} />) : <span className={styles.muted}>-</span>}
                        </td>
                      </tr>
                      {open && openRow && (
                        <tr className={styles.heatX}>
                          <td colSpan={F.length + 2}>
                            <div className={styles.hxInner}>
                              <Inspector model={heatModel(data, openRow, sel!.key, nav)} onClose={closeDetail} cols />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.heatTip} aria-live="polite">{tip}</div>
        <div className={styles.legend}>
          <span><i style={{ background: "#e9a48c" }} />장악·탈출에 직결</span>
          <span><i style={{ background: "#f0d7a9" }} />경로를 넓힘</span>
          <span><i style={{ background: "#e4e3e0" }} />위생</span>
          <span><i style={{ boxShadow: "inset 0 0 0 2px var(--ink)", background: "#fff" }} />위험 조합을 이루는 칸</span>
          <span><EvidenceChip ev="obs" text="●" /> Hubble 관측 근거 (그 외는 구성·권한)</span>
          <span>열 머리 숫자 = 사용자·애드온 워크로드 {user.length}개 중 해당 수</span>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useRef, useState } from "react";
import type { AttackEdge, AttackNode, PolicyFinding, PolicyInsightsResponse, RemediationAction, RiskIssue } from "@aud/types";
import { useMediaQuery } from "@/lib/useBrowserState";
import { useI18n } from "@/lib/i18n";
import { edgeKey, issueGlance, issueNum, type InsightLabels, type InsightsNav, type TFn } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import { EvidenceChip, Inspector, Pill, type InspectorModel, type InspectorRow } from "./Inspector";
import { AttackGraph, AttackTable, type GraphSel } from "./AttackGraph";
import styles from "./insights.module.css";

type Props = {
  data: PolicyInsightsResponse;
  findings: PolicyFinding[];
  selectedId: string;
  onSelect: (id: string) => void;
  checked: ReadonlySet<string>;
  onToggleAction: (id: string, on: boolean) => void;
  nav: InsightsNav;
};

type Owner = "all" | RiskIssue["ownerGroup"];
const OWNERS: Owner[] = ["all", "mine", "addon", "azure"];

export function issueState(issue: RiskIssue, checked: ReadonlySet<string>): "open" | "reduced" | "closed" {
  const resolved = new Set(issue.actions.filter((a) => checked.has(a.id)).flatMap((a) => a.closes));
  if (issue.findingIds.length && issue.findingIds.every((f) => resolved.has(f))) return "closed";
  if (issue.actions.some((a) => checked.has(a.id))) return "reduced";
  return "open";
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre className={styles.code}>
      {code.split("\n").map((l, i) => {
        const cls = /^\+ /.test(l) ? styles.codeAdd : /^- /.test(l) ? styles.codeDel : /^\s*#/.test(l) ? styles.codeCm : undefined;
        return <span key={i} className={cls}>{l}{"\n"}</span>;
      })}
    </pre>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
  }
}

function ActionRow({ a, checked, onToggle }: { a: RemediationAction; checked: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useI18n();
  return (
    <label className={styles.action}>
      <input type="checkbox" data-act={a.id} checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <div>
        <div className={styles.actionT}>{a.title}</div>
        <div className={styles.actionD}>{a.desc}</div>
        {a.fixAt ? <div className={styles.fixAt} title={a.fixAt}>{t("ins.combos.fixAt")}: <span className={styles.mono}>{a.fixAt}</span></div> : null}
      </div>
      <div className={styles.effect}>
        <Pill tone={a.risk}>{t("ins.combos.fixRisk")}: {a.riskLabel}</Pill>
        <span className={styles.muted}>{a.effect === "closed" ? `${t("ins.combos.resolves", { n: a.closes.length })}${a.cuts.length ? ` · ${t("ins.combos.cutsPath")}` : ""}` : a.effect === "exception" ? t("ins.combos.exception") : t("ins.combos.reduces")}</span>
      </div>
    </label>
  );
}

/**
 * Under the path's title: four facts readable in a glance (who · reaches · cuts · evidence), then — for grouped
 * issues — every member in a folded table (name · grade · permissions · bindings · owner).
 */
function IssueGlanceRow({ issue, conf, onOpenRow }: { issue: RiskIssue; conf: string; onOpenRow: (rowId: string) => void }) {
  const { t } = useI18n();
  const g = issueGlance(issue);
  const crit = issue.members?.filter((m) => m.grade === "crit").length ?? 0;
  return (
    <>
      <dl className={styles.glance}>
        <div><dt>{t("ins.glance.who")}</dt><dd>{t(`ins.glance.${g.whoKind}`, { n: g.who })}{crit && crit < g.who ? <span className={styles.muted}> · {t("ins.glance.critN", { n: crit })}</span> : null}</dd></div>
        <div><dt>{t("ins.glance.reach")}</dt><dd title={g.reach.join(" · ")}>{g.reach.join(" · ") || "—"}</dd></div>
        <div><dt>{t("ins.glance.cuts")}</dt><dd>{t("ins.glance.cutsV", { n: g.cuts, safe: g.safe })}</dd></div>
        <div><dt>{t("ins.glance.evidence")}</dt><dd title={conf}>{conf}{g.unverified ? <span className={styles.glanceUnk}> · {t("ins.glance.unverified", { n: g.unverified })}</span> : null}</dd></div>
      </dl>
      {issue.members?.length ? (
        <details className={styles.members}>
          <summary>{t("ins.glance.members", { n: issue.members.length })}</summary>
          <div className={styles.tableWrap}>
            <table className={styles.tbl} style={{ minWidth: 0 }}>
              <thead><tr><th>{t("ins.glance.col.name")}</th><th>{t("ins.glance.col.grade")}</th><th>{t("ins.glance.col.perms")}</th><th>{t("ins.glance.col.bindings")}</th><th>{t("ins.glance.col.owner")}</th></tr></thead>
              <tbody>
                {issue.members.map((m) => (
                  <tr key={m.rowId}>
                    <td><button type="button" className={styles.linkish} onClick={() => onOpenRow(m.rowId)} title={t("ins.combos.openHeat")}>{m.name}</button><div className={styles.muted} style={{ fontSize: 11 }}>{m.namespace}</div></td>
                    <td><Pill tone={m.grade}>{t(`ins.sev.${m.grade}`)}</Pill></td>
                    <td>{m.permissions.join(" · ")}</td>
                    <td className={styles.mono} style={{ fontSize: 11 }}>{m.bindings.join(", ")}</td>
                    <td className={styles.muted} style={{ fontSize: 12 }}>{m.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </>
  );
}

function ticketText(issue: RiskIssue, data: PolicyInsightsResponse, checked: ReadonlySet<string>, t: TFn, lb: InsightLabels): string {
  const acts = issue.actions.filter((a) => checked.has(a.id));
  return [
    `## [${t(`ins.sev.${issue.sev}`)}] ${issue.title}`, "",
    `- ${t("ins.ticket.cluster")}: ${data.containment.cluster.name} (${data.containment.cluster.location})`,
    `- ${t("ins.ticket.evidence")}: ${lb.confOf(issue, data.network.coverage)}`,
    `- ${t("ins.ticket.findings")}: ${issue.findingIds.map((f) => f.split(":")[0]).join(", ") || "-"}`,
    `- ${t("ins.ticket.owner")}: ${issue.owner}`, "", `### ${t("ins.ticket.actions")}`,
    ...(acts.length ? acts : issue.actions).map((a) => `- [ ] ${a.title} — ${t("ins.combos.fixRisk")}: ${a.riskLabel}`), "",
    `### ${t("ins.ticket.rollback")}`, `- ${t("ins.ticket.rollbackStep")}`,
  ].join("\n");
}

export function RiskCombos({ data, findings, selectedId, onSelect, checked, onToggleAction, nav }: Props) {
  const { t } = useI18n();
  const lb = useInsightLabels();
  const { COLS, EVK, KIND_LABEL, TYPE_LABEL, confOf, evidenceOf, flowNote, hubbleLabel } = lb;
  const [owner, setOwner] = useState<Owner>("all");
  const [quickOnly, setQuickOnly] = useState(false);
  const [graphSel, setGraphSel] = useState<(GraphSel & { issue: string }) | null>(null);
  const [viewChoice, setViewChoice] = useState<"graph" | "table" | null>(null);
  const [fixTab, setFixTab] = useState<"code" | "ticket">("code");
  const [toast, setToast] = useState("");
  const narrow = useMediaQuery("(max-width: 640px)");
  const view = viewChoice ?? (narrow ? "table" : "graph");
  const els = useRef(new Map<string, Element>());
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const register = (key: string, el: Element | null) => { if (el) els.current.set(key, el); else els.current.delete(key); };

  const issue = data.issues.find((i) => i.id === selectedId) ?? data.issues[0];
  const sel = graphSel && graphSel.issue === issue?.id ? graphSel : null;
  const matches = (i: RiskIssue) => (owner === "all" || i.ownerGroup === owner) && (!quickOnly || i.actions.some((a) => a.risk === "ok"));
  const shown = data.issues.filter(matches);
  const hidden = data.issues.filter((i) => !matches(i));
  const security = findings.filter((f) => !f.system && f.severity !== "info" && ["psa", "networkPolicy", "rbac"].includes(f.category));
  const resolvedAll = new Set(data.issues.flatMap((i) => i.actions).filter((a) => checked.has(a.id)).flatMap((a) => a.closes));
  const cutDone = new Set(data.issues.flatMap((i) => i.actions).filter((a) => checked.has(a.id)).flatMap((a) => a.cuts));
  const findingById = new Map(findings.map((f) => [f.id, f]));

  if (!issue) {
    return <div className={styles.notice}>{t("ins.combos.none")}</div>;
  }
  const num = (id: string) => issueNum(data.issues.findIndex((i) => i.id === id));

  const select = (id: string, focusCard = false) => {
    onSelect(id);
    if (focusCard) requestAnimationFrame(() => cardRefs.current.get(id)?.focus());
  };
  const pick = (s: GraphSel) => {
    const same = sel && sel.kind === s.kind && sel.id === s.id;
    setGraphSel(same ? null : { ...s, issue: issue.id });
  };
  const closeDetail = () => {
    const prev = sel;
    setGraphSel(null);
    if (prev) (els.current.get(`${prev.kind}:${prev.id}`) as HTMLElement | SVGElement | undefined)?.focus();
  };
  const toggleAct = (id: string, on: boolean) => onToggleAction(id, on);
  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  const refLinks = (refs: string[]) => refs.flatMap((id) => [
    ...(data.rows.some((r) => r.id === id) ? [{ label: `${t("ins.combos.openHeat")} · ${data.rows.find((r) => r.id === id)!.name}`, onClick: () => nav.openHeatRow(id) }] : []),
    ...(data.network.nodes.some((n) => n.id === id) ? [{ label: `${t("ins.heat.openNet")} · ${data.network.nodes.find((n) => n.id === id)!.label}`, onClick: () => nav.openNet(id) }] : []),
  ]).filter((l, i, a) => a.findIndex((x) => x.label === l.label) === i);

  const nodeModel = (n: AttackNode): InspectorModel => {
    const conn = issue.edges.filter((e) => e.from === n.id || e.to === n.id);
    const byId = new Map(issue.nodes.map((x) => [x.id, x]));
    const acts = issue.actions.filter((a) => a.cuts.some((c) => c.split(">").includes(n.id)) || conn.some((e) => e.cut === a.id));
    return {
      id: `gd-${issue.id}-${n.id}`,
      kicker: `${COLS[n.col]} · ${TYPE_LABEL[n.type] ?? n.type}`,
      title: n.label,
      sub: n.sub,
      chips: <>{n.unk && <EvidenceChip ev="unk" text={t("ins.unknown")} />}{(n.badges ?? []).map((b) => <Pill key={b.what} tone="ev">{b.n} {b.what}</Pill>)}</>,
      callouts: (n.notes ?? []).map((note) => ({ tone: "warn" as const, content: `${t("ins.combos.check")} — ${note}` })),
      sections: [
        n.facts.length ? { h: t("ins.combos.factsHead"), rows: n.facts as InspectorRow[] } : { h: t("ins.combos.facts"), body: <div className={styles.muted}>{t("ins.combos.noFacts")}</div> },
        { h: t("ins.combos.links", { n: conn.length }), body: (
          <ul className={styles.list}>
            {conn.map((e) => (
              <li key={edgeKey(e)}>
                <span>{e.from === n.id ? `→ ${byId.get(e.to)?.label}` : `← ${byId.get(e.from)?.label}`}</span>
                <span className={styles.muted}>{e.label}</span>
                <EvidenceChip ev={e.ev} />
                {e.cut && <span className={styles.cut} data-done={cutDone.has(edgeKey(e)) || undefined}>{cutDone.has(edgeKey(e)) ? `✓ ${t("ins.combos.cutDone")}` : `⊗ ${t("ins.combos.cut")}`}</span>}
              </li>
            ))}
          </ul>
        ) },
        acts.length > 0 && { h: t("ins.combos.cutsHere"), body: <>{acts.map((a) => <ActionRow key={a.id} a={a} checked={checked.has(a.id)} onToggle={(on) => toggleAct(a.id, on)} />)}</> },
        { h: t("ins.combos.findings", { n: issue.findingIds.length }), body: (
          <ul className={styles.list}>
            {issue.findingIds.map((id) => { const f = findingById.get(id); return <li key={id}><span className={styles.mono}>{f?.ruleId ?? id}</span><span>{f?.title}</span><span className={styles.muted}>{f?.namespace ?? f?.resource?.name ?? ""}</span></li>; })}
            {!issue.findingIds.length && <li className={styles.muted}>{t("ins.combos.noFindings")}</li>}
          </ul>
        ) },
        n.cmd ? { h: t("ins.combos.cmd"), body: (
          <details>
            <summary className={styles.muted}>{t("ins.combos.cmdSummary")} — kubectl auth can-i</summary>
            <CodeBlock code={n.cmd} />
            <div className={styles.copyRow}><button className={styles.btnGhost} onClick={() => copyText(n.cmd!).then((ok) => flash(ok ? t("ins.combos.copiedCmd") : t("ins.combos.copyFailed")))}>{t("ins.combos.copyCmd")}</button></div>
          </details>
        ) } : null,
      ],
      links: refLinks(n.refs),
    };
  };

  const edgeModel = (e: AttackEdge): InspectorModel => {
    const byId = new Map(issue.nodes.map((x) => [x.id, x]));
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    const act = e.cut ? issue.actions.find((x) => x.id === e.cut) : undefined;
    const src = { obs: `Hubble · ${hubbleLabel(data.network.coverage)} · ${flowNote(data.network.coverage)} · ${t("ins.combos.srcObs")}`, perm: `${t("ins.combos.srcPerm")} — ${e.label || "-"}`, cfg: `${t("ins.combos.srcCfg")} — ${e.label || "-"}`, unk: e.why ?? t("ins.combos.srcUnk") }[e.ev];
    return {
      id: `ge-${issue.id}-${edgeKey(e)}`,
      kicker: `${t("ins.combos.edge")} · ${EVK[e.ev]}`,
      title: `${a.label} → ${b.label}`,
      sub: e.label,
      chips: <EvidenceChip ev={e.ev} />,
      sections: [
        { h: t("ins.heat.evidence"), rows: [
          { k: t("ins.combos.grade"), v: t(`ins.combos.grade.${e.ev}`), ev: e.ev },
          { k: t("ins.combos.raw"), v: e.label || "-", mono: true },
          { k: t("ins.combos.source"), v: src },
        ] },
        act ? { h: `${t("ins.combos.cut")}${checked.has(act.id) ? ` · ${t("ins.combos.applied")}` : ""}`, body: <ActionRow a={act} checked={checked.has(act.id)} onToggle={(on) => toggleAct(act.id, on)} /> }
          : { h: t("ins.combos.cut"), body: <div className={styles.muted}>{t("ins.combos.noCut")}</div> },
      ],
      links: refLinks([...a.refs, ...b.refs]),
    };
  };

  const detail = sel
    ? sel.kind === "node"
      ? (() => { const n = issue.nodes.find((x) => x.id === sel.id); return n ? nodeModel(n) : null; })()
      : (() => { const e = issue.edges.find((x) => edgeKey(x) === sel.id); return e ? edgeModel(e) : null; })()
    : null;

  const st = issueState(issue, checked);
  const openCount = data.issues.filter((i) => issueState(i, checked) !== "closed").length;
  const reduced = data.issues.filter((i) => issueState(i, checked) === "reduced").length;
  const cuts = issue.edges.filter((e) => e.cut);
  const sim = (
    <div className={styles.sim}>
      <span>{t("ins.combos.thisCombo")}: <b>{t(`ins.combos.state.${st}`)}</b> · {t("ins.combos.cutProgress", { n: cuts.length, done: cuts.filter((e) => cutDone.has(edgeKey(e))).length })}</span>
      <span>{t("ins.combos.total")}: <b>{data.issues.length} → {openCount}</b>{reduced ? ` · ${t("ins.combos.state.reducedShort")} ${reduced}` : ""} · {t("ins.combos.resolved", { n: [...resolvedAll].filter((f) => security.some((s) => s.id === f)).length, m: security.length })}</span>
    </div>
  );

  return (
    <div className={styles.md}>
      <div className={styles.queue}>
        <div className={styles.queueIn}>
          <div className={styles.queueH}>
            <h3>{t("ins.heat.combosCol")} <span className={styles.muted}>{openCount}</span></h3>
            <div className={styles.ctrls}>
              <button className={styles.fchip} aria-pressed={quickOnly} onClick={() => setQuickOnly(!quickOnly)}>{t("ins.combos.quickOnly")}</button>
              {OWNERS.map((k) => <button key={k} className={styles.fchip} aria-pressed={owner === k} onClick={() => setOwner(k)}>{t(`ins.owner.${k}`)}</button>)}
            </div>
          </div>
          {shown.map((i) => {
            const s = issueState(i, checked);
            return (
              <button
                key={i.id}
                ref={(el) => { if (el) cardRefs.current.set(i.id, el); else cardRefs.current.delete(i.id); }}
                className={styles.card}
                data-sev={i.sev}
                data-closed={s === "closed" || undefined}
                aria-pressed={issue.id === i.id}
                onClick={() => select(i.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const k = shown.findIndex((x) => x.id === i.id) + (e.key === "ArrowDown" ? 1 : -1);
                  const next = shown[Math.max(0, Math.min(shown.length - 1, k))];
                  if (next) select(next.id, true);
                }}
              >
                <div className={styles.cardTop}>
                  <Pill tone={i.sev}>{num(i.id)} {t(`ins.sev.${i.sev}`)}</Pill>
                  <span className={styles.cardNum}>{KIND_LABEL[i.kind]} · {t("ins.combos.checksN", { n: i.findingIds.length })}{s === "closed" ? ` · ${t("ins.combos.state.closed")}` : s === "reduced" ? ` · ${t("ins.combos.state.reducedShort")}` : ""}</span>
                </div>
                <div className={styles.cardTitle} title={i.title}>{i.title}</div>
                <div className={styles.cardMeta}>
                  {evidenceOf(i).map(([k, txt]) => <Pill key={txt} tone={k === "unk" ? "unk" : "ev"}>{k === "unk" ? "? " : ""}{txt}</Pill>)}
                  {i.actions[0] && <Pill tone={i.actions[0].risk} title={t("ins.combos.fixRiskHint")}>{t("ins.combos.fixRisk")}: {i.actions[0].riskLabel}</Pill>}
                </div>
                <div className={styles.owner}>{t("ins.ticket.owner")}: {i.owner}</div>
              </button>
            );
          })}
          {shown.length === 0 && <div className={styles.muted}>{t("ins.combos.noneMatch")}</div>}
          {hidden.length > 0 && (
            <>
              <div className={styles.dimH}>
                <span>{t("ins.combos.hidden", { n: hidden.length })}</span>
                <button className={styles.linkish} onClick={() => { setOwner("all"); setQuickOnly(false); }}>{t("ins.combos.clearFilter")}</button>
              </div>
              {hidden.map((i) => (
                <button key={i.id} className={`${styles.card} ${styles.dim}`} data-sev={i.sev} aria-label={`${num(i.id)} ${KIND_LABEL[i.kind]}: ${i.title} — ${t("ins.combos.showUnfiltered")}`}
                  onClick={() => { setOwner("all"); setQuickOnly(false); select(i.id, true); }}>
                  <span className={styles.cardNum}>{num(i.id)}</span>
                  <span className={styles.dimT} title={i.title}>{KIND_LABEL[i.kind]} · {i.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <section className={`${styles.panel} ${styles.gPanel}`} aria-label={t("ins.combos.pathAria")}>
        <div className={styles.panelH}>
          <h3>{t("ins.combos.pathTitle")}</h3>
          <div className={styles.ctrls}>
            <div className={styles.toggle}>
              <button aria-pressed={view === "graph"} onClick={() => setViewChoice("graph")}>{t("ins.combos.graph")}</button>
              <button aria-pressed={view === "table"} onClick={() => setViewChoice("table")}>{t("ins.combos.table")}</button>
            </div>
          </div>
        </div>
        <div className={styles.panelB}>
          <div className={styles.issueTitle}>{num(issue.id)} {issue.title}</div>
          <IssueGlanceRow issue={issue} conf={confOf(issue, data.network.coverage)} onOpenRow={nav.openHeatRow} />
          {view === "graph" ? (
            <div className={styles.graphWrap}>
              <AttackGraph issue={issue} sel={sel} cutDone={cutDone} onPick={pick} onEscape={closeDetail} register={register} />
            </div>
          ) : (
            <AttackTable issue={issue} onPick={pick} />
          )}
          {detail && (
            <div className={styles.detailHost} aria-live="polite">
              <Inspector model={detail} onClose={closeDetail} cols />
            </div>
          )}
          <div className={styles.gLegend}>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-obs)" strokeWidth="2.5" /></svg>{t("ins.combos.legendObs")}</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-perm)" strokeWidth="2" strokeDasharray="7 4" /></svg>{t("ins.ev.perm")}</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-cfg)" strokeWidth="2" strokeDasharray="2 3" /></svg>{t("ins.combos.legendCfg")}</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--unk)" strokeWidth="2" strokeDasharray="2 3" opacity="0.6" /></svg>{t("ins.ev.unk")} (?)</span>
            <span>{t("ins.combos.legendKeys")}</span>
          </div>
          {sim}
        </div>
      </section>

      <section className={`${styles.panel} ${styles.fPanel}`} aria-label={t("ins.combos.fixTitle")}>
        <div className={styles.panelH}><h3>{t("ins.combos.fixTitle")}</h3><span className={styles.sub}>{t("ins.combos.fixSub")}</span></div>
        <div className={styles.panelB}>
          <div className={styles.fixGrid}>
            <div>
              <h4>{t("ins.ticket.actions")}</h4>
              {issue.actions.map((a) => <ActionRow key={a.id} a={a} checked={checked.has(a.id)} onToggle={(on) => toggleAct(a.id, on)} />)}
            </div>
            <div>
              <div className={styles.tabs} role="tablist">
                <button role="tab" aria-selected={fixTab === "code"} onClick={() => setFixTab("code")}>{t("ins.combos.tabCode")}</button>
                <button role="tab" aria-selected={fixTab === "ticket"} onClick={() => setFixTab("ticket")}>{t("ins.combos.tabTicket")}</button>
              </div>
              {fixTab === "code" ? (
                issue.actions.map((a, n) => (
                  <details key={a.id} className={styles.codeBlk} open={n === 0 || checked.has(a.id) || undefined}>
                    <summary>{a.title}</summary>
                    <CodeBlock code={a.code} />
                  </details>
                ))
              ) : (
                <>
                  <CodeBlock code={ticketText(issue, data, checked, t, lb)} />
                  <div className={styles.copyRow}>
                    <span className={styles.muted} aria-live="polite">{toast}</span>
                    <button className={styles.btnGhost} onClick={() => copyText(ticketText(issue, data, checked, t, lb)).then((ok) => flash(ok ? t("ins.combos.copiedTicket") : t("ins.combos.copyFailed")))}>{t("ins.combos.copyTicket")}</button>
                  </div>
                </>
              )}
            </div>
          </div>
          {sim}
          {toast && fixTab === "code" && <div className={styles.note} aria-live="polite">{toast}</div>}
        </div>
      </section>
    </div>
  );
}

"use client";

// AKS 보안 점검 › 네트워크 노출 › 정책 시뮬레이션: the deployed network policies as a namespace matrix of the connections
// Hubble observed (allowed · blocked · can't tell), and a what-if — turn a policy off, enforce an audit policy, add a
// virtual default-deny / DNS allow / "allow what was observed" — showing which observed connections would break or
// open, and which workloads gain or lose isolation. The engine is the pure lib/netpolSim.ts.

import { useMemo, useState } from "react";
import type { NetpolModel, NetworkInsight } from "@aud/types";
import { Button, Select, Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { changeKey, endpointsOf, groupOf, matrixOf, simulate, type DirVerdict, type EdgeState, type FlowVerdict, type MatrixCell, type SimChange, type SimEdge } from "@/lib/netpolSim";
import { Badge } from "./shared";
import styles from "../styles.module.css";

const STATE_CLASS: Record<EdgeState, string> = { allow: "npAllow", deny: "npDeny", partial: "npPartial", unknown: "npUnknown" };

export function NetpolSimPanel({ model, network, includeSystem }: { model: NetpolModel; network: NetworkInsight; includeSystem: boolean }) {
  const { t } = useI18n();
  const [changes, setChanges] = useState<SimChange[]>([]);
  const nsList = useMemo(() => model.namespaces.filter((n) => includeSystem || !n.system).map((n) => n.name).sort(), [model, includeSystem]);
  const [ns, setNs] = useState<string>("");
  const curNs = ns || nsList[0] || "";
  const [cellKey, setCellKey] = useState<string | null>(null);

  const sim = useMemo(() => simulate(model, network, changes, { includeSystem }), [model, network, changes, includeSystem]);
  const matrix = useMemo(() => matrixOf(model, network, sim), [model, network, sim]);
  const eps = useMemo(() => endpointsOf(model, network), [model, network]);
  const policyName = useMemo(() => new Map(model.policies.map((p) => [p.id, `${p.namespace ? `${p.namespace}/` : ""}${p.name}`])), [model]);
  const nameOf = (id: string) => policyName.get(id) ?? id.replace(/^virtual:/, `${t("nps.virtual")} `);

  const has = (c: SimChange) => changes.some((x) => changeKey(x) === changeKey(c));
  const toggle = (c: SimChange) => { setChanges(has(c) ? changes.filter((x) => changeKey(x) !== changeKey(c)) : [...changes, c]); setCellKey(null); };
  const auditPolicies = model.policies.filter((p) => (p.ingress && !p.ingress.isolates) || (p.egress && !p.egress.isolates));
  const enforceAll = () => setChanges([...changes.filter((c) => c.op !== "enforce"), ...auditPolicies.map((p) => ({ op: "enforce" as const, policyId: p.id }))]);

  const groupLabel = (g: string) => (g.startsWith("ns:") ? g.slice(3) : t(`nps.group.${g}`));
  const nodeLabel = (id: string) => eps.nodes.get(id)?.label ?? id;
  const dirText = (d: DirVerdict | undefined, dir: "egress" | "ingress") => {
    if (!d) return null;
    const who = d.by.map(nameOf).join(", ");
    return `${t(`nps.dir.${dir}`)}: ${t(`nps.reason.${d.reason}`, { by: who || "—" })}`;
  };
  const verdictText = (v: FlowVerdict) => [dirText(v.egress, "egress"), dirText(v.ingress, "ingress")].filter(Boolean).join(" · ");

  const changed = changes.length > 0;
  const cell = cellKey ? matrix.cells.get(cellKey) : undefined;
  // Without a picked cell: the connections that change (or, with no change, those the policies don't decide clearly)
  const listed: SimEdge[] = cell ? cell.edges
    : changed ? sim.edges.filter((x) => x.broken.length || x.opened.length || x.before !== x.after)
      : sim.edges.filter((x) => x.mismatch || x.after === "deny" || x.after === "partial");

  const nsPolicies = model.policies.filter((p) => p.namespace === curNs || p.source === "cilium-clusterwide");

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelTitle}>{t("nps.title")}</div>
            <div className={styles.muted}>{t("nps.sub")}</div>
          </div>
        </div>
        <div className={styles.npStats}>
          <Stat label={t("nps.stat.edges")} value={sim.counts.edges} hint={t("nps.stat.edgesHint")} />
          <Stat label={t(changed ? "nps.stat.after" : "nps.stat.now")} value={`${sim.counts.allow} · ${sim.counts.deny + sim.counts.partial} · ${sim.counts.unknown}`} hint={t("nps.stat.nowHint")} />
          <Stat label={t("nps.stat.broken")} value={changed ? sim.counts.broken : "—"} hint={changed ? t("nps.stat.brokenHint") : t("nps.stat.noChange")} tone={sim.counts.broken ? "high" : undefined} />
          <Stat label={t("nps.stat.opened")} value={changed ? sim.counts.opened : "—"} hint={changed ? t("nps.stat.openedHint") : t("nps.stat.noChange")} tone={sim.counts.opened ? "medium" : undefined} />
          <Stat label={t("nps.stat.mismatch")} value={sim.counts.mismatch} hint={t("nps.stat.mismatchHint")} tone={sim.counts.mismatch ? "medium" : undefined} />
        </div>
      </div>

      <div className={styles.npGrid}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}><div className={styles.panelTitle}>{t("nps.changes")}</div></div>
          <div className={styles.npSide}>
            {changed ? (
              <div className={styles.chips}>
                {changes.map((c) => (
                  <button key={changeKey(c)} type="button" className={styles.npChip} onClick={() => toggle(c)} title={t("nps.remove")}>
                    {c.op === "off" || c.op === "enforce" ? t(`nps.op.${c.op}`, { name: nameOf(c.policyId) }) : c.op === "allowDns" ? t("nps.op.allowDns", { ns: c.namespace }) : t(`nps.op.${c.op}.${c.dir}`, { ns: c.namespace })} ×
                  </button>
                ))}
                <button type="button" className={styles.linkBtn} onClick={() => { setChanges([]); setCellKey(null); }}>{t("nps.reset")}</button>
              </div>
            ) : <div className={styles.muted}>{t("nps.noChanges")}</div>}
            {auditPolicies.length ? (
              <div className={styles.npHint}>
                {t("nps.auditHint", { n: auditPolicies.length })}{" "}
                <button type="button" className={styles.linkBtn} onClick={enforceAll}>{t("nps.enforceAll")}</button>
              </div>
            ) : null}

            <Select label={t("nps.namespace")} value={curNs} onChange={(v) => setNs(v)} options={nsList.map((n) => ({ value: n, label: n }))} />
            <div className={styles.npActions}>
              {(["ingress", "egress"] as const).map((d) => (
                <Button size="sm" key={`deny-${d}`} onClick={() => toggle({ op: "denyAll", namespace: curNs, dir: d })} disabled={!curNs}>
                  {has({ op: "denyAll", namespace: curNs, dir: d }) ? "✓ " : "+ "}{t(`nps.op.denyAll.${d}`, { ns: "" }).trim()}
                </Button>
              ))}
              <Button size="sm" onClick={() => toggle({ op: "allowDns", namespace: curNs })} disabled={!curNs}>
                {has({ op: "allowDns", namespace: curNs }) ? "✓ " : "+ "}{t("nps.op.allowDns", { ns: "" }).trim()}
              </Button>
              {(["ingress", "egress"] as const).map((d) => (
                <Button size="sm" key={`obs-${d}`} onClick={() => toggle({ op: "allowObserved", namespace: curNs, dir: d })} disabled={!curNs}>
                  {has({ op: "allowObserved", namespace: curNs, dir: d }) ? "✓ " : "+ "}{t(`nps.op.allowObserved.${d}`, { ns: "" }).trim()}
                </Button>
              ))}
            </div>

            <div className={styles.npPolicies}>
              <div className={styles.npSubH}>{t("nps.policies", { n: nsPolicies.length })}</div>
              {nsPolicies.length ? nsPolicies.map((p) => {
                const on = !has({ op: "off", policyId: p.id });
                const audit = (p.ingress && !p.ingress.isolates) || (p.egress && !p.egress.isolates);
                return (
                  <div key={p.id} className={styles.npPolicy} data-off={!on || undefined}>
                    <label className={styles.npPolicyName}>
                      <input type="checkbox" checked={on} onChange={() => toggle({ op: "off", policyId: p.id })} />
                      <span className={styles.mono} title={p.id}>{p.name}</span>
                    </label>
                    <div className={styles.chips}>
                      <Badge tone="neutral">{p.source === "kubernetes" ? "NP" : p.source === "cilium" ? "CNP" : "CCNP"}</Badge>
                      {p.ingress ? <Badge tone={p.ingress.isolates ? "ok" : "medium"}>{t(p.ingress.isolates ? "nps.dirOn" : "nps.dirAudit", { dir: t("nps.dir.ingress") })}</Badge> : null}
                      {p.egress ? <Badge tone={p.egress.isolates ? "ok" : "medium"}>{t(p.egress.isolates ? "nps.dirOn" : "nps.dirAudit", { dir: t("nps.dir.egress") })}</Badge> : null}
                      {audit ? (
                        <button type="button" className={styles.linkBtn} onClick={() => toggle({ op: "enforce", policyId: p.id })}>
                          {has({ op: "enforce", policyId: p.id }) ? t("nps.enforced") : t("nps.enforce")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              }) : <div className={styles.muted}>{t("nps.noPolicies")}</div>}
            </div>
          </div>
        </div>

        <div className={styles.npMain}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>{t("nps.matrix")}</div>
              <div className={styles.npLegend}>
                {(["allow", "partial", "deny", "unknown"] as const).map((s) => <span key={s}><i className={styles[STATE_CLASS[s]]} />{t(`nps.state.${s}`)}</span>)}
                <span>▼ {t("nps.legend.broken")}</span><span>▲ {t("nps.legend.opened")}</span><span>! {t("nps.legend.mismatch")}</span>
              </div>
            </div>
            {!network.available ? <div className={styles.empty}>{t("nps.noFlows", { reason: network.reason ?? "" })}</div> : (
              <div className={styles.npMatrixWrap}>
                <table className={styles.npMatrix}>
                  <thead>
                    <tr>
                      <th className={styles.npCorner}>{t("nps.fromTo")}</th>
                      {matrix.cols.map((c) => <th key={c} title={groupLabel(c)}><span>{groupLabel(c)}</span></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((r) => (
                      <tr key={r}>
                        <th className={styles.mono}>{groupLabel(r)}</th>
                        {matrix.cols.map((c) => {
                          const k = `${r}|${c}`;
                          const x: MatrixCell | undefined = matrix.cells.get(k);
                          if (!x) return <td key={c} />;
                          return (
                            <td key={c}>
                              <button type="button" className={`${styles.npCell} ${styles[STATE_CLASS[x.state]]}`} aria-pressed={cellKey === k}
                                title={t("nps.cellTitle", { from: groupLabel(r), to: groupLabel(c), n: x.edges.length, state: t(`nps.state.${x.state}`) })}
                                onClick={() => setCellKey(cellKey === k ? null : k)}>
                                {x.edges.length}
                                {x.broken ? <b className={styles.npBroken}>▼{x.broken}</b> : null}
                                {x.opened ? <b className={styles.npOpened}>▲{x.opened}</b> : null}
                                {x.mismatch ? <b className={styles.npMismatch}>!</b> : null}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}>
                {cell ? t("nps.list.cell", { from: groupLabel(cell.row), to: groupLabel(cell.col) }) : t(changed ? "nps.list.changed" : "nps.list.blocked")} ({listed.length})
              </div>
              {cell ? <button type="button" className={styles.linkBtn} onClick={() => setCellKey(null)}>{t("nps.list.clear")}</button> : null}
            </div>
            {listed.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>{t("nps.col.flow")}</th><th>{t("nps.col.port")}</th><th>{t("nps.col.verdict")}</th><th>{t("nps.col.why")}</th><th>{t("nps.col.observed")}</th></tr></thead>
                  <tbody>
                    {listed.slice(0, 200).flatMap((x) => x.ports.map((p, i) => (
                      <tr key={`${x.edge.from}>${x.edge.to}:${p.port}`}>
                        {i === 0 ? <td rowSpan={x.ports.length} className={styles.mono}>{nodeLabel(x.edge.from)} → {nodeLabel(x.edge.to)}<div className={styles.muted}>{groupLabel(groupOf(x.edge.from, eps))} → {groupLabel(groupOf(x.edge.to, eps))}</div></td> : null}
                        <td className={styles.mono}>{p.port}</td>
                        <td>
                          <span className={`${styles.npPill} ${styles[STATE_CLASS[p.before.v]]}`}>{t(`nps.state.${p.before.v}`)}</span>
                          {changed && p.after.v !== p.before.v ? <> → <span className={`${styles.npPill} ${styles[STATE_CLASS[p.after.v]]}`}>{t(`nps.state.${p.after.v}`)}</span></> : null}
                        </td>
                        <td className={styles.npWhy}>{verdictText(changed ? p.after : p.before)}</td>
                        {i === 0 ? <td rowSpan={x.ports.length}>{t(`nps.observed.${x.observed}`, { n: x.edge.count, d: x.edge.dropped })}{x.mismatch ? <div className={styles.npMismatchText}>{t("nps.mismatch")}</div> : null}</td> : null}
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            ) : <div className={styles.empty}>{t(changed ? "nps.list.noneChanged" : "nps.list.noneBlocked")}</div>}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}><div className={styles.panelTitle}>{t("nps.isolation")}</div></div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>{t("nps.namespace")}</th><th>{t("nps.col.workloads")}</th><th>{t("nps.col.inIso")}</th><th>{t("nps.col.outIso")}</th></tr></thead>
                <tbody>
                  {sim.isolation.map((r) => {
                    const cellOf = (d: "ingress" | "egress") => {
                      const [b, a] = r[d];
                      const u = r[d === "ingress" ? "ingressUnknown" : "egressUnknown"];
                      const delta = a - b;
                      return (
                        <span>
                          {b}/{r.workloads}{changed && delta ? <b className={delta > 0 ? styles.npOpenedIso : styles.npBroken}> → {a}/{r.workloads}</b> : null}
                          {u[changed ? 1 : 0] ? <span className={styles.muted}> · {t("nps.isoUnknown", { n: u[changed ? 1 : 0] })}</span> : null}
                        </span>
                      );
                    };
                    return (
                      <tr key={r.namespace}>
                        <td className={styles.mono}>{r.namespace}</td>
                        <td>{r.workloads}</td>
                        <td>{cellOf("ingress")}</td>
                        <td>{cellOf("egress")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className={styles.muted}>{t("nps.note")}</p>
        </div>
      </div>
    </div>
  );
}

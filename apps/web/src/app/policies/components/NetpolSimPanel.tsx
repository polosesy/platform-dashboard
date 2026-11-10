"use client";

// AKS 보안 점검 › 네트워크 노출 › 정책 시뮬레이션: the deployed network policies as a namespace matrix of the connections
// Hubble observed (allowed · blocked · can't tell), and a what-if — turn a policy off, enforce an audit policy, add a
// virtual default-deny / DNS allow / "allow what was observed" — showing which observed connections would break or
// open, and which workloads gain or lose isolation. The engine is the pure lib/netpolSim.ts. Colours and glyphs follow the
// platform status grammar (● rule-allowed · ▲ open · ■ blocked · ◧ partly · ? can't tell — STATE_LEVEL / STATE_GLYPH).

import { useMemo, useRef, useState } from "react";
import type { NetpolModel, NetworkInsight } from "@aud/types";
import { Button, Select, Stat, LinkButton, FilterChip } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import {
  STATE_GLYPH, STATE_LEVEL, changeEffects, changeKey, endpointsOf, groupOf, matrixOf, simulate, virtualChange, withoutAllows,
  type MatrixCell, type SimChange, type SimEdge,
} from "@/lib/netpolSim";
import { NetpolFlowDetail } from "./NetpolFlowDetail";
import { Badge } from "./shared";
import styles from "../styles.module.css";

export function NetpolSimPanel({ model, network, includeSystem }: { model: NetpolModel; network: NetworkInsight; includeSystem: boolean }) {
  const { t } = useI18n();
  const [changes, setChanges] = useState<SimChange[]>([]);
  const nsList = useMemo(() => model.namespaces.filter((n) => includeSystem || !n.system).map((n) => n.name).sort(), [model, includeSystem]);
  const [ns, setNs] = useState<string>("");
  const curNs = ns || nsList[0] || "";
  const [cellKey, setCellKey] = useState<string | null>(null);

  const sim = useMemo(() => simulate(model, network, changes, { includeSystem }), [model, network, changes, includeSystem]);
  // Each change on its own: a change that does nothing says why (allow rules are a union — see changeEffects)
  const effects = useMemo(() => changeEffects(model, network, changes, { includeSystem }), [model, network, changes, includeSystem]);
  const matrix = useMemo(() => matrixOf(model, network, sim), [model, network, sim]);
  const eps = useMemo(() => endpointsOf(model, network), [model, network]);
  const policyName = useMemo(() => new Map(model.policies.map((p) => [p.id, `${p.namespace ? `${p.namespace}/` : ""}${p.name}`])), [model]);
  const changeLabel = (c: SimChange): string => (c.op === "off" || c.op === "enforce" ? t(`nps.op.${c.op}`, { name: nameOf(c.policyId) })
    : c.op === "allowDns" ? t("nps.op.allowDns", { ns: c.namespace }) : t(`nps.op.${c.op}.${c.dir}`, { ns: c.namespace }));
  const nameOf = (id: string): string => {
    const v = virtualChange(id);
    return v ? `${t("nps.virtual")} · ${changeLabel(v)}` : policyName.get(id) ?? id;
  };
  const detailRef = useRef<HTMLDivElement>(null);
  const pick = (k: string | null) => {
    setCellKey(k);
    // The detail sits under the wide matrix — bring it into view so the click visibly does something
    if (k) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const has = (c: SimChange) => changes.some((x) => changeKey(x) === changeKey(c));
  const toggle = (c: SimChange) => { setChanges(has(c) ? changes.filter((x) => changeKey(x) !== changeKey(c)) : [...changes, c]); setCellKey(null); };
  const auditPolicies = model.policies.filter((p) => (p.ingress && !p.ingress.isolates) || (p.egress && !p.egress.isolates));
  const enforceAll = () => setChanges([...changes.filter((c) => c.op !== "enforce"), ...auditPolicies.map((p) => ({ op: "enforce" as const, policyId: p.id }))]);
  // "What do this namespace's allow rules do?" — its policies off + default-deny both ways (adds what is missing)
  const stripAllows = () => { const add = withoutAllows(model, curNs).filter((c) => !has(c)); setChanges([...changes, ...add]); setCellKey(null); };
  const effectText = (c: SimChange) => {
    const e = effects.get(changeKey(c));
    if (!e) return "";
    if (e.why) return t(`nps.effect.none.${e.why}`);
    return [e.broken ? t("nps.effect.broken", { n: e.broken }) : null, e.opened ? t("nps.effect.opened", { n: e.opened }) : null,
      !e.broken && !e.opened && e.changed ? t("nps.effect.changed", { n: e.changed }) : null,
      e.isolation ? t("nps.effect.isolation", { n: e.isolation > 0 ? `+${e.isolation}` : e.isolation }) : null].filter(Boolean).join(" · ");
  };
  const noEffect = changes.length > 0 && !sim.counts.broken && !sim.counts.opened && !sim.counts.changed && sim.isolation.every((r) => r.ingress[0] === r.ingress[1] && r.egress[0] === r.egress[1]);

  const groupLabel = (g: string) => (g.startsWith("ns:") ? g.slice(3) : t(`nps.group.${g}`));
  const nodeLabel = (id: string) => eps.nodes.get(id)?.label ?? id;

  const changed = changes.length > 0;
  const cell = cellKey ? matrix.cells.get(cellKey) : undefined;
  // Without a picked cell: the connections that change (or, with no change, those the policies don't decide clearly)
  const listed: SimEdge[] = cell ? cell.edges
    : changed ? sim.edges.filter((x) => x.broken.length || x.opened.length || x.changed)
      : sim.edges.filter((x) => x.mismatch || x.after === "deny" || x.after === "partial");

  const nsPolicies = model.policies.filter((p) => p.namespace === curNs || p.source === "cilium-clusterwide");

  return (
    <div className={`${styles.page} ${styles.npRoot}`}>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <div className={styles.panelTitle}>{t("nps.title")}</div>
            <div className={styles.muted}>{t("nps.sub")}</div>
          </div>
        </div>
        <div className={styles.npStats}>
          <Stat label={t("nps.stat.edges")} value={sim.counts.edges} hint={t("nps.stat.edgesHint")} />
          <Stat label={t(changed ? "nps.stat.after" : "nps.stat.now")} hint={t("nps.stat.nowHint")} value={
            <span className={styles.npStatSplit}>
              {([["allow", sim.counts.allow], ["open", sim.counts.open], ["deny", sim.counts.deny + sim.counts.partial], ["unknown", sim.counts.unknown]] as const).map(([s, n]) => (
                <span key={s} data-level={STATE_LEVEL[s]} title={t(`nps.state.${s}`)}><span className={styles.npGlyph} aria-hidden="true">{STATE_GLYPH[s]}</span>{n}</span>
              ))}
            </span>
          } />
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
                  <span key={changeKey(c)} className={styles.npChange}>
                    <FilterChip onClick={() => toggle(c)} title={t("nps.remove")}>
                      {changeLabel(c)} ×
                    </FilterChip>
                    <span className={styles.npEffect} data-none={effects.get(changeKey(c))?.why ? true : undefined}>{effectText(c)}</span>
                  </span>
                ))}
                <LinkButton onClick={() => { setChanges([]); pick(null); }}>{t("nps.reset")}</LinkButton>
              </div>
            ) : <div className={styles.muted}>{t("nps.noChanges")}</div>}
            {noEffect ? <div className={styles.npHint}>{t("nps.noEffect")}</div> : null}
            {auditPolicies.length ? (
              <div className={styles.npHint}>
                {t("nps.auditHint", { n: auditPolicies.length })}{" "}
                <LinkButton onClick={enforceAll}>{t("nps.enforceAll")}</LinkButton>
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
              <Button size="sm" variant="primary" onClick={stripAllows} disabled={!curNs} title={t("nps.stripAllowsHint")}>
                {t("nps.stripAllows")}
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
                        <LinkButton onClick={() => toggle({ op: "enforce", policyId: p.id })}>
                          {has({ op: "enforce", policyId: p.id }) ? t("nps.enforced") : t("nps.enforce")}
                        </LinkButton>
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
                {(["allow", "open", "partial", "deny", "unknown"] as const).map((s) => (
                  <span key={s} data-level={STATE_LEVEL[s]}><i className={styles.npSwatch}><span className={styles.npGlyph}>{STATE_GLYPH[s]}</span></i>{t(`nps.state.${s}`)}</span>
                ))}
                <span><i className={styles.npSwatch} data-changed /> {t("nps.legend.changed")}</span>
                <span><b className={styles.npBroken}>↓</b> {t("nps.legend.broken")}</span>
                <span><b className={styles.npOpened}>↑</b> {t("nps.legend.opened")}</span>
                <span><b className={styles.npMismatch}>!</b> {t("nps.legend.mismatch")}</span>
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
                              <button type="button" className={styles.npCell} data-level={STATE_LEVEL[x.state]} aria-pressed={cellKey === k} data-changed={changed && x.changed ? true : undefined}
                                title={t("nps.cellTitle", { from: groupLabel(r), to: groupLabel(c), n: x.edges.length, state: t(`nps.state.${x.state}`) })}
                                onClick={() => pick(cellKey === k ? null : k)}>
                                <span className={styles.npGlyph} aria-hidden="true">{STATE_GLYPH[x.state]}</span>
                                <span className={styles.npCellN}>{x.edges.length}</span>
                                {x.broken ? <b className={styles.npBroken}>↓{x.broken}</b> : null}
                                {x.opened ? <b className={styles.npOpened}>↑{x.opened}</b> : null}
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

          <div className={styles.panel} ref={detailRef}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>
                  {cell ? t("nps.list.cell", { from: groupLabel(cell.row), to: groupLabel(cell.col) }) : t(changed ? "nps.list.changed" : "nps.list.blocked")} ({listed.length})
                </div>
                <div className={styles.muted}>{t(cell ? "nps.d.sub" : "nps.d.subPick")}</div>
              </div>
              {cell ? <LinkButton onClick={() => pick(null)}>{t("nps.list.clear")}</LinkButton> : null}
            </div>
            {listed.length ? (
              <NetpolFlowDetail edges={listed} changed={changed} nameOf={nameOf} nodeLabel={nodeLabel} groupOf={(id) => groupLabel(groupOf(id, eps))} />
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

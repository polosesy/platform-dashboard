"use client";

// 정책 시뮬레이션 › the connections of a matrix cell (or the changed / blocked list), read as a path through two
// checkpoints — the sender's egress, then the receiver's ingress — each saying pass / blocked / not checked, the policy
// and the exact rule that decided. Above it, the cell's reasons in three columns: what blocked, which allow rules let
// traffic through (the exceptions to a default-deny), and which sides nothing checks. Engine: lib/netpolSim.ts.

import { useState } from "react";
import { Segmented } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import {
  GATE_GLYPH, GATE_LEVEL, STATE_GLYPH, STATE_LEVEL, cellReasons, gateOf, peerText, portGroups, portsText,
  type Dir, type DirVerdict, type EdgeState, type FlowVerdict, type ReasonItem, type RuleHit, type SimEdge,
} from "@/lib/netpolSim";
import styles from "../styles.module.css";

const WORST: Record<EdgeState, number> = { deny: 0, partial: 1, unknown: 2, open: 3, allow: 4 };

export function NetpolFlowDetail({ edges, changed, nameOf, groupOf, nodeLabel }: {
  edges: SimEdge[];
  changed: boolean;
  nameOf: (policyId: string) => string;
  /** The matrix group label of a node ("argocd", "인터넷") */
  groupOf: (nodeId: string) => string;
  nodeLabel: (nodeId: string) => string;
}) {
  const { t } = useI18n();
  const [when, setWhen] = useState<"after" | "before">("after");
  const at = changed ? when : "before";
  const stateOf = (x: SimEdge) => (at === "after" ? x.after : x.before);

  const ruleText = (h: RuleHit, dir: Dir) => {
    const peers = h.rule.peers.map((p) => {
      const x = peerText(p);
      const every = t("nps.peer.every");
      return t(`nps.peer.${x.kind}`, { x: x.text || every, ns: x.ns || every });
    }).join(" | ") || t("nps.peer.nobody");
    const ports = portsText(h.rule.ports) || t("nps.ports.all");
    return `${t(h.rule.deny ? "nps.rule.denyN" : "nps.rule.n", { n: h.index + 1 })}: ${dir === "egress" ? "→" : "←"} ${peers} · ${ports}${h.rule.l7 ? " · L7" : ""}`;
  };

  // ── 1. Counts and the reasons (who blocked · which rule let through · who doesn't check) ──
  const counts = { allow: 0, open: 0, partial: 0, deny: 0, unknown: 0 } as Record<EdgeState, number>;
  for (const x of edges) counts[stateOf(x)]++;
  const reasons = cellReasons(edges, at);
  const col = (kind: "block" | "allow" | "unchecked" | "unknown") => reasons.filter((r) => r.kind === kind || (kind === "unchecked" && r.kind === "host"));
  const dirWord = (d: Dir) => t(`nps.dir.${d}`);
  const reasonRow = (r: ReasonItem, i: number) => {
    const n = <span className={styles.npWhyN}>{t("nps.d.edges", { n: r.edges })}</span>;
    if (r.kind === "block" && r.how === "noRule") return (
      <li key={i}><b className={styles.mono}>{r.policies.map(nameOf).join(", ")}</b> · {dirWord(r.dir)}<div className={styles.npWhyRule}>{t("nps.d.noRule")}</div>{n}</li>
    );
    if (r.kind === "block" || r.kind === "allow") return (
      <li key={i}><b className={styles.mono}>{nameOf(r.hit.policy)}</b> · {dirWord(r.dir)}<div className={styles.npWhyRule}>{ruleText(r.hit, r.dir)}</div>{n}</li>
    );
    if (r.kind === "unchecked") return <li key={i}><b className={styles.mono}>{r.namespace}</b> · {dirWord(r.dir)}<div className={styles.npWhyRule}>{t("nps.d.noIsolation")}</div>{n}</li>;
    if (r.kind === "host") return <li key={i}>{t("nps.reason.hostAlways")}{n}</li>;
    return <li key={i}>{dirWord(r.dir)} · {t(`nps.reason.${r.reason}`, { by: r.policies.map(nameOf).join(", ") || "—" })}{n}</li>;
  };
  const COLS = [
    { kind: "block" as const, level: "danger", glyph: "■" },
    { kind: "allow" as const, level: "ok", glyph: "●" },
    { kind: "unchecked" as const, level: "warn", glyph: "▲" },
    { kind: "unknown" as const, level: "unknown", glyph: "?" },
  ].filter((c) => c.kind !== "unknown" || col("unknown").length);

  // ── 2. One checkpoint ──
  const gateDetail = (d: DirVerdict | undefined, dir: Dir, ns: string) => {
    const g = gateOf(d);
    if (!d || g === "outside") return t("nps.gate.outsideWhy");
    if (g === "host") return t("nps.reason.hostAlways");
    if (g === "unchecked") return t("nps.gate.uncheckedWhy", { ns, dir: dirWord(dir) });
    if (d.reason === "noRule") return t("nps.gate.noRuleWhy", { by: d.by.map(nameOf).join(", ") });
    if (d.hits?.length) return d.hits.map((h) => `${nameOf(h.policy)} — ${ruleText(h, dir)}`).join("\n");
    return t(`nps.reason.${d.reason}`, { by: d.by.map(nameOf).join(", ") || "—" });
  };
  const gate = (f: FlowVerdict, was: FlowVerdict | null, dir: Dir, ns: string) => {
    const d = f[dir];
    const g = gateOf(d);
    const before = was ? gateOf(was[dir]) : null;
    return (
      <div className={styles.npGate} data-level={GATE_LEVEL[g]} data-outside={g === "outside" || undefined}>
        <div className={styles.npGateHead}>
          <span className={styles.npGlyph} aria-hidden="true">{GATE_GLYPH[g]}</span>
          <span className={styles.npGateDir}>{t(`nps.gate.${dir}`)}</span>
          <b className={styles.npGateWord}>{t(`nps.gate.${g}`)}</b>
        </div>
        <div className={styles.npGateWhy}>{gateDetail(d, dir, ns)}</div>
        {was && before !== g ? <div className={styles.npGateWas}>{t("nps.gate.was", { g: `${GATE_GLYPH[before!]} ${t(`nps.gate.${before}`)}` })}</div> : null}
      </div>
    );
  };

  const sorted = [...edges].sort((a, b) => (changed ? Number(b.changed) - Number(a.changed) : 0) || WORST[stateOf(a)] - WORST[stateOf(b)] || b.edge.count - a.edge.count);

  return (
    <div className={styles.npDetail}>
      <div className={styles.npDetailBar}>
        <div className={styles.npCounts}>
          {(["deny", "partial", "unknown", "open", "allow"] as const).filter((s) => counts[s]).map((s) => (
            <span key={s} className={styles.npPill} data-level={STATE_LEVEL[s]}><span className={styles.npGlyph} aria-hidden="true">{STATE_GLYPH[s]}</span>{t(`nps.state.${s}`)} {counts[s]}</span>
          ))}
        </div>
        {changed ? (
          <Segmented label={t("nps.d.when")} value={when} onChange={setWhen}
            items={[{ id: "after", label: t("nps.d.after") }, { id: "before", label: t("nps.d.before") }]} />
        ) : null}
      </div>

      <div className={styles.npWhyGrid}>
        {COLS.map((c) => {
          const items = col(c.kind);
          return (
            <section key={c.kind} className={styles.npWhyCol} data-level={c.level}>
              <h4><span className={styles.npGlyph} aria-hidden="true">{c.glyph}</span>{t(`nps.d.col.${c.kind}`)}</h4>
              <p className={styles.npWhyHint}>{t(`nps.d.colHint.${c.kind}`)}</p>
              {items.length ? <ul>{items.map(reasonRow)}</ul> : <p className={styles.muted}>{t("nps.d.none")}</p>}
            </section>
          );
        })}
      </div>

      <div className={styles.npFlows}>
        {sorted.slice(0, 120).map((x) => {
          const groups = portGroups(x);
          const st = stateOf(x);
          const srcNs = x.edge.from.split("/")[0] ?? "", dstNs = x.edge.to.split("/")[0] ?? "";
          return (
            <article key={`${x.edge.from}>${x.edge.to}`} className={styles.npFlow} data-level={STATE_LEVEL[st]}>
              <header className={styles.npFlowHead}>
                <span className={styles.npPill} data-level={STATE_LEVEL[st]}><span className={styles.npGlyph} aria-hidden="true">{STATE_GLYPH[st]}</span>{t(`nps.state.${st}`)}</span>
                {changed && x.before !== x.after ? <span className={styles.muted}>{t("nps.d.wasState", { s: `${STATE_GLYPH[at === "after" ? x.before : x.after]} ${t(`nps.state.${at === "after" ? x.before : x.after}`)}`, w: t(at === "after" ? "nps.d.before" : "nps.d.after") })}</span> : null}
                <span className={styles.npFlowObs}>
                  {t("nps.col.observed")}: {t(`nps.observed.${x.observed}`, { n: x.edge.count, d: x.edge.dropped })}
                  {x.mismatch ? <b className={styles.npMismatchText}> · ! {t("nps.mismatch")}</b> : null}
                </span>
              </header>
              {groups.map((g) => {
                const f = at === "after" ? g.after : g.before;
                const was = changed ? (at === "after" ? g.before : g.after) : null;
                return (
                  <div key={g.ports.join(",")} className={styles.npPath}>
                    <div className={styles.npEnd}>
                      <span className={styles.mono}>{nodeLabel(x.edge.from)}</span>
                      <small>{groupOf(x.edge.from)}</small>
                    </div>
                    <span className={styles.npArrow} aria-hidden="true">→</span>
                    {gate(f, was, "egress", srcNs)}
                    <span className={styles.npArrow} aria-hidden="true">→</span>
                    {gate(f, was, "ingress", dstNs)}
                    <span className={styles.npArrow} aria-hidden="true">→</span>
                    <div className={styles.npEnd}>
                      <span className={styles.mono}>{nodeLabel(x.edge.to)}</span>
                      <small>{groupOf(x.edge.to)} · {t("nps.d.ports", { p: g.ports.join(", ") })}</small>
                    </div>
                  </div>
                );
              })}
            </article>
          );
        })}
        {sorted.length > 120 ? <p className={styles.muted}>{t("nps.d.more", { n: sorted.length - 120 })}</p> : null}
      </div>
    </div>
  );
}

"use client";

// AKS 보안 점검 › 그래프 탐색 (보안 고도화 P5): pick conditions (an AND), see the workloads that hold all of them — and,
// apart, those that might (no condition false, some unknown). The question lives in the URL (?q=a.b) so a link shares
// it; named questions are kept in this browser, or for the team (operators — the subscription's saved questions). A
// watched team question raises an issue per match in 통합 위험 › 이슈 목록. Every matched fact carries its evidence grade.

import { useEffect, useMemo, useState } from "react";
import type { PolicyInsightsResponse, SavedQueriesResponse, SavedQuery, WorkloadIdentityResponse } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { EvidenceChip, Inspector, Pill, type InspectorModel, type InspectorRow } from "./Inspector";
import type { InsightsNav } from "./model";
import { COND_GROUPS, CONDITIONS, PRESETS, buildGraph, decodeQuery, encodeQuery, runQuery, type CondKey, type GraphPaas, type GraphWorkload } from "@/lib/securityGraph";
import styles from "./insights.module.css";

const SAVED_KEY = "aud.explore.saved";
type Saved = { name: string; q: string };

function readSaved(): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === "string" && typeof x.q === "string").slice(0, 30) : [];
  } catch { return []; }
}
function writeSaved(list: Saved[]) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* storage blocked */ }
}

export function ExplorePanel({ clusterId, insights, wi, wiState, nav }: {
  /** The cluster's ARM id — its subscription keeps the team's questions */
  clusterId: string;
  insights: PolicyInsightsResponse;
  /** null = not read yet / failed — the Azure identity conditions answer "unknown" */
  wi: WorkloadIdentityResponse | null;
  wiState: "ok" | "loading" | "failed";
  nav: InsightsNav;
}) {
  const { t } = useI18n();
  const [keys, setKeys] = useState<CondKey[]>([]);
  const [includeManaged, setIncludeManaged] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const [watch, setWatch] = useState(false);
  const [sev, setSev] = useState<SavedQuery["sev"]>("high");
  const [teamMsg, setTeamMsg] = useState<string | null>(null);

  // Team questions (per subscription). Read = signed in, write = operator; a stale write gets 409 → reload, decide again
  const sub = /\/subscriptions\/([^/]+)\//i.exec(clusterId)?.[1] ?? "";
  const teamQ = useApiQuery(sub ? `saved-queries:${sub.toLowerCase()}` : null, (token) =>
    fetchJsonWithBearer<SavedQueriesResponse>(apiUrl("/api/security/saved-queries", { subscriptionId: sub }), token));
  const team = teamQ.data?.queries ?? [];
  const canWrite = !!teamQ.data?.canWrite;
  const getToken = useApiToken();
  const writeTeam = async (method: "PUT" | "DELETE", params: Record<string, string>, body?: unknown) => {
    try {
      const token = await getToken().catch(() => null);
      await fetchJsonWithBearer(apiUrl("/api/security/saved-queries", { subscriptionId: sub, ...params }), token,
        { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setTeamMsg(null);
    } catch (e) {
      setTeamMsg(e instanceof ApiError && e.status === 409 ? t("ex.team.conflict") : t("ex.team.failed", { code: e instanceof ApiError && e.code ? e.code : "saved_query_write_failed" }));
    }
    teamQ.reload();
  };

  // The question in the URL (?q=…): read once, then written back on every change (history.replaceState — no navigation)
  useEffect(() => {
    setKeys(decodeQuery(new URLSearchParams(window.location.search).get("q")));
    setSaved(readSaved());
  }, []);
  const apply = (next: CondKey[]) => {
    setKeys(next);
    setSel(null);
    const p = new URLSearchParams(window.location.search);
    if (next.length) p.set("q", encodeQuery(next)); else p.delete("q");
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}${window.location.hash}`);
  };
  const toggle = (k: CondKey) => apply(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k]);

  const graph = useMemo(() => buildGraph(insights, wi), [insights, wi]);
  const res = useMemo(() => runQuery(graph, keys, { includeManaged }), [graph, keys, includeManaged]);
  const label = (k: CondKey) => t(`ex.cond.${k}`);
  const needsWi = keys.some((k) => CONDITIONS.find((c) => c.key === k)?.group === "azure");
  const picked = sel ? graph.find((w) => w.id === sel) : undefined;

  const save = () => {
    const n = name.trim();
    if (!n || !keys.length) return;
    const next = [{ name: n, q: encodeQuery(keys) }, ...saved.filter((s) => s.name !== n)];
    setSaved(next);
    writeSaved(next);
    setName("");
  };
  const remove = (n: string) => { const next = saved.filter((s) => s.name !== n); setSaved(next); writeSaved(next); };
  const saveTeam = () => {
    const n = name.trim();
    if (!n || !keys.length) return;
    void writeTeam("PUT", {}, { name: n, q: encodeQuery(keys), includeManaged, watch, sev, baseRev: null });
    setName("");
  };
  const setTeamWatch = (q: SavedQuery) =>
    writeTeam("PUT", { id: q.id }, { name: q.name, q: q.q, includeManaged: q.includeManaged, watch: !q.watch, sev: q.sev, baseRev: q.rev });
  const removeTeam = (q: SavedQuery) => writeTeam("DELETE", { id: q.id, baseRev: String(q.rev) });
  const paasText = (p: GraphPaas) => [
    p.label,
    p.exposure ? t(`ex.paas.exposure.${p.exposure}`) : null,
    p.keyAuth === "on" ? t("ex.paas.keyAuth") : null,
    p.defender === undefined ? null : p.defender === null ? t("ex.paas.defUnread") : p.defender.state === "notAssessed" ? t("ex.paas.defNone")
      : t("ex.paas.def", { h: p.defender.high, m: p.defender.medium, l: p.defender.low }) + (p.defender.top.length ? ` (${p.defender.top.map((x) => x.title).join(" · ")})` : ""),
  ].filter(Boolean).join(" · ");

  const reasonText = (w: GraphWorkload) => keys.filter((k) => w.facts[k].state === "unknown")
    .map((k) => `${label(k)}: ${t(`ex.unknown.${w.facts[k].reason ?? "wiNotLoaded"}`)}`).join(" · ");

  const model = (w: GraphWorkload): InspectorModel => {
    const row = (k: CondKey): InspectorRow => {
      const f = w.facts[k];
      return { k: label(k), v: f.state === "yes" ? (f.detail || t("ex.state.yes")) : f.state === "no" ? t("ex.state.no") : t(`ex.unknown.${f.reason ?? "wiNotLoaded"}`), ev: f.state === "yes" ? f.ev : f.state === "unknown" ? "unk" : undefined, off: f.state === "no" };
    };
    return {
      id: `ex-${w.id}`,
      kicker: `${t("ex.kicker")} · ${w.kind}`,
      title: w.name,
      sub: w.namespace,
      chips: <>{keys.map((k) => w.facts[k].state === "yes" ? <Pill key={k} tone="warn">{label(k)}</Pill> : null)}</>,
      sections: [
        { h: t("ex.sec.query"), rows: keys.map(row) },
        { h: t("ex.sec.all"), rows: CONDITIONS.filter((c) => !keys.includes(c.key) && w.facts[c.key].state !== "no").map((c) => row(c.key)) },
        w.identities.length > 0 && { h: t("ex.sec.identities"), rows: w.identities.map((i) => ({ k: `${i.name} (${i.via === "wi" ? t("ex.via.wi") : t("ex.via.imds")})`, v: i.roles.map((r) => `${r.roleName} @ ${r.scope.label}${r.usage?.state === "unused" ? ` · ${t("ex.unused")}` : ""}`).join(" · ") || t("ex.noRoles"), ev: "cfg" as const })) },
        w.paas.length > 0 && { h: t("ex.sec.paas"), rows: w.paas.map((p) => ({ k: p.type, v: paasText(p), ev: "obs" as const })) },
      ],
      links: [
        { label: t("ex.openHeat"), onClick: () => nav.openHeatRow(w.id) },
        ...w.issueIds.map((id) => ({ label: `${t("ex.openIssue")} · ${insights.issues.find((i) => i.id === id)?.title.slice(0, 40) ?? id}`, onClick: () => nav.openIssue(id) })),
      ],
    };
  };

  const rowsOf = (list: GraphWorkload[], maybe: boolean) => (
    <ul className={styles.exRows}>
      {list.map((w) => (
        <li key={w.id}>
          <button type="button" className={styles.exRow} aria-pressed={sel === w.id} data-maybe={maybe || undefined} onClick={() => setSel(sel === w.id ? null : w.id)}>
            <span className={styles.exName}><b>{w.name}</b> <span className={styles.muted}>{w.namespace} · {w.kind}{w.issueIds.length ? ` · ${t("ex.inIssues", { n: w.issueIds.length })}` : ""}</span></span>
            <span className={styles.exFacts}>
              {maybe ? <span className={styles.muted} title={reasonText(w)}>{reasonText(w)}</span>
                : keys.map((k) => <span key={k} className={styles.exFact} title={w.facts[k].detail ?? ""}>{label(k)} <EvidenceChip ev={w.facts[k].ev} /></span>)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={styles.panel} aria-label={t("ex.title")}>
      <div className={styles.panelH}>
        <div>
          <h3>{t("ex.title")}</h3>
          <div className={styles.sub}>{t("ex.sub")}</div>
        </div>
        <div className={styles.ctrls}>
          <button className={styles.fchip} aria-pressed={includeManaged} onClick={() => setIncludeManaged(!includeManaged)}>{t("ex.includeManaged")}</button>
          {keys.length ? <button className={styles.fchip} onClick={() => apply([])}>{t("ex.clear")}</button> : null}
        </div>
      </div>
      <div className={styles.panelB}>
        <div className={styles.exPresets}>
          <span className={styles.muted}>{t("ex.presets")}</span>
          {PRESETS.map((p) => <button key={p.id} className={styles.fchip} aria-pressed={encodeQuery(p.keys) === encodeQuery(keys)} title={p.keys.map(label).join(" ∧ ")} onClick={() => apply(p.keys)}>{t(`ex.preset.${p.id}`)}</button>)}
          {saved.map((s) => (
            <span key={s.name} className={styles.exSaved}>
              <button className={styles.fchip} aria-pressed={s.q === encodeQuery(keys)} onClick={() => apply(decodeQuery(s.q))} title={decodeQuery(s.q).map(label).join(" ∧ ")}>★ {s.name}</button>
              <button className={styles.linkish} aria-label={t("ex.deleteSaved", { name: s.name })} onClick={() => remove(s.name)}>×</button>
            </span>
          ))}
          {team.map((q) => (
            <span key={q.id} className={styles.exSaved}>
              <button className={styles.fchip} aria-pressed={q.q === encodeQuery(keys) && q.includeManaged === includeManaged}
                onClick={() => { apply(decodeQuery(q.q)); setIncludeManaged(q.includeManaged); }}
                title={`${decodeQuery(q.q).map(label).join(" ∧ ")}${q.updatedBy ? ` — ${q.updatedBy}` : ""}`}>
                {t("ex.team.chip")} {q.name}{q.watch ? ` · ${t("ex.team.watching", { sev: t(`ex.sev.${q.sev}`) })}` : ""}
              </button>
              {canWrite ? (
                <>
                  <button className={styles.linkish} onClick={() => void setTeamWatch(q)}>{q.watch ? t("ex.team.unwatch") : t("ex.team.watch")}</button>
                  <button className={styles.linkish} aria-label={t("ex.deleteSaved", { name: q.name })} onClick={() => void removeTeam(q)}>×</button>
                </>
              ) : null}
            </span>
          ))}
        </div>
        <div className={styles.exGroups}>
          {COND_GROUPS.map((g) => (
            <div key={g} className={styles.exGroup}>
              <div className={styles.exGroupH}>{t(`ex.group.${g}`)}</div>
              <div className={styles.ctrls}>
                {CONDITIONS.filter((c) => c.group === g).map((c) => (
                  <button key={c.key} className={styles.fchip} aria-pressed={keys.includes(c.key)} title={t(`ex.hint.${c.key}`)} onClick={() => toggle(c.key)}>{label(c.key)}</button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className={styles.exQuery} aria-live="polite">
          {keys.length ? <><b>{t("ex.question")}</b> {keys.map(label).join(" ∧ ")}</> : <span className={styles.muted}>{t("ex.pickHint")}</span>}
          {keys.length ? (
            <span className={styles.exSave}>
              <input value={name} maxLength={40} placeholder={t("ex.saveName")} onChange={(e) => setName(e.target.value)} aria-label={t("ex.saveName")} />
              <button className={styles.fchip} disabled={!name.trim()} onClick={save}>{t("ex.save")}</button>
              {canWrite ? (
                <>
                  <label className={styles.exWatch}><input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} /> {t("ex.team.watchLabel")}</label>
                  {watch ? (
                    <select value={sev} onChange={(e) => setSev(e.target.value as SavedQuery["sev"])} aria-label={t("ex.team.sev")}>
                      {(["critical", "high", "medium"] as const).map((v) => <option key={v} value={v}>{t(`ex.sev.${v}`)}</option>)}
                    </select>
                  ) : null}
                  <button className={styles.fchip} disabled={!name.trim()} onClick={saveTeam}>{t("ex.team.save")}</button>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {teamMsg ? <div className={styles.notice}>{teamMsg}</div> : null}
        {canWrite && teamQ.data && !teamQ.data.durable ? <div className={styles.note}>{t("ex.team.memory")}</div> : null}
        {needsWi && wiState !== "ok" ? <div className={styles.notice}>{t(`ex.wi.${wiState}`)}</div> : null}

        {keys.length ? (
          <div className={styles.exResult}>
            <div className={styles.exCounts}>{t("ex.counts", { n: res.matches.length, m: res.maybe.length, total: res.total })}</div>
            {res.matches.length ? rowsOf(res.matches, false) : <div className={styles.muted}>{t("ex.noMatch")}</div>}
            {res.maybe.length ? (
              <details className={styles.members}>
                <summary>{t("ex.maybe", { n: res.maybe.length })}</summary>
                {rowsOf(res.maybe, true)}
              </details>
            ) : null}
            {picked ? <div className={styles.detailHost}><Inspector model={model(picked)} onClose={() => setSel(null)} cols /></div> : null}
          </div>
        ) : null}
        <p className={styles.note}>{t("ex.note")}</p>
      </div>
    </section>
  );
}

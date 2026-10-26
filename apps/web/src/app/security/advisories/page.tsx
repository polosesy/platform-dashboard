"use client";

// 보안 › 긴급 취약점 — urgent vulnerability news from official sources (CISA KEV, NVD, nodejs.org, php.net) checked
// against what this platform runs: the dashboard's own runtime, the selected cluster's images (by tag) and the
// images Defender scanned. Each card says who is affected, current → fixed version, and what to do. A source that
// couldn't be read is shown as such — the verdict is then "확인 불가", never "영향 없음".

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AdvisoriesResponse, AdvisoryItem, AdvisorySource, DependencyFinding, ExposureTarget } from "@aud/types";
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, Panel, Segmented, Select, Stat, Tabs } from "@/components/ui";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useAksClusters } from "@/lib/useAksClusters";
import { useApiQuery } from "@/lib/useApiQuery";
import { cveOrgUrl, cvssTone, filterFindings, findingCounts, kevHitsUs, maxCvss, mergeWatch, parseWatch, splitItems, targetCounts, type FindingFilter } from "@/lib/advisoryView";
import s from "./advisories.module.css";

const MOCK_SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/";
const WATCH_KEY = "aud.advisories.watch";
const STATE_GLYPH: Record<AdvisorySource["state"], string> = { ok: "✓", failed: "✕", disabled: "–", signin: "🔒", noData: "·" };
const STATUS_TONE = { affected: "high", unknown: "medium", notDetected: "neutral", clear: "success" } as const;
const TARGET_TONE = { affected: "high", eol: "high", unknown: "medium", fixed: "success" } as const;

function loadWatch(): string[] {
  try { return parseWatch(localStorage.getItem(WATCH_KEY) ?? ""); } catch { return []; }
}
function saveWatch(list: string[]) {
  try { localStorage.setItem(WATCH_KEY, list.join(",")); } catch { /* private window — the list just isn't remembered */ }
}

function TargetsTable({ targets }: { targets: ExposureTarget[] }) {
  const { t } = useI18n();
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">{t("adv.col.target")}</th>
            <th scope="col">{t("adv.col.evidence")}</th>
            <th scope="col">{t("adv.col.version")}</th>
            <th scope="col">{t("adv.col.status")}</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((x) => (
            <tr key={x.id} data-status={x.status}>
              <td>
                <div className={s.targetMain}>{x.image ?? x.where}</div>
                {x.workloads.length > 0 && <div className={s.dim} title={x.workloads.join("\n")}>{x.workloads.slice(0, 3).join(" · ")}{x.workloads.length > 3 ? ` +${x.workloads.length - 3}` : ""}</div>}
                {x.pkg && <div className={s.dim}>{t("adv.pkg")}: {x.pkg}</div>}
              </td>
              <td title={t(`adv.evHint.${x.evidence}`)}>{t(`adv.ev.${x.evidence}`)}</td>
              <td className={s.mono}>{x.current ?? "?"} → {x.fixed ?? "—"}</td>
              <td>
                <Badge tone={TARGET_TONE[x.status]}>{t(`adv.target.${x.status}`)}</Badge>
                {x.note && <div className={s.dim}>{t(`adv.note.${x.note}`)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdvisoryCard({ item, open, onToggle }: { item: AdvisoryItem; open: boolean; onToggle: () => void }) {
  const { t, locale } = useI18n();
  const score = maxCvss(item);
  const counts = targetCounts(item);
  const kev = item.cves.some((c) => c.kev);
  return (
    <li className={s.card} data-status={item.status}>
      <button type="button" className={s.cardHead} aria-expanded={open} onClick={onToggle}>
        <Badge tone={STATUS_TONE[item.status]}>{t(`adv.status.${item.status}`)}</Badge>
        <span className={s.cardMain}>
          <span className={s.cardTitle}>
            {item.product ? <span className={s.product}>{t(`adv.product.${item.product}`)}</span> : <span className={s.product}>{t("adv.product.watch")}</span>}
            {item.title}
          </span>
          <span className={s.cardMeta}>
            {score !== null && <Badge tone={cvssTone(score)}>CVSS {score.toFixed(1)}</Badge>}
            {kev && <Badge tone="high">{t("adv.kev")}</Badge>}
            <span>{t("adv.cveCount", { n: item.cves.length })}</span>
            {item.targets.length > 0 && (
              <span>
                {counts.affected + counts.eol > 0 && <strong className={s.bad}>{t("adv.count.affected", { n: counts.affected + counts.eol })} </strong>}
                {counts.unknown > 0 && <span className={s.warn}>{t("adv.count.unknown", { n: counts.unknown })} </span>}
                {counts.fixed > 0 && <span className={s.dim}>{t("adv.count.fixed", { n: counts.fixed })}</span>}
              </span>
            )}
          </span>
        </span>
        <span className={s.cardDate}>{item.date ? new Date(item.date).toLocaleDateString(dateLocale(locale)) : ""}</span>
      </button>
      {open && (
        <div className={s.cardBody}>
          <ul className={s.cves}>
            {item.cves.map((c) => (
              <li key={c.id} className={s.cve} data-sev={c.cvss ? cvssTone(c.cvss.score) : "neutral"}
                title={[c.title, c.cna ? `CNA: ${c.cna}` : "", c.scoreSource ? t(`adv.scoreFrom.${c.scoreSource}`) : "", c.description].filter(Boolean).join("\n")}>
                <a href={cveOrgUrl(c.id)} target="_blank" rel="noreferrer" className={s.cveId}>{c.id}</a>
                <span className={s.cveScore}>{c.cvss ? `${c.cvss.score.toFixed(1)} · v${c.cvss.version}` : t("adv.cvssPending")}</span>
                {c.exploitation === "active" && !c.kev && <Badge tone="high">{t("adv.ssvc.active")}</Badge>}
                {c.exploitation === "poc" && <Badge tone="medium">{t("adv.ssvc.poc")}</Badge>}
                {c.kev && <Badge tone="high" title={`${c.kev.requiredAction}`}>{t("adv.kevDue", { due: c.kev.dueDate })}{c.kev.ransomware ? ` · ${t("adv.ransomware")}` : ""}</Badge>}
              </li>
            ))}
          </ul>
          {item.fixes.length > 0 && (
            <p className={s.fixes}>
              <strong>{t("adv.fixes")}</strong>{" "}
              {item.fixes.map((f) => `${f.line}${item.product === "nodejs" ? ".x" : ""} → ${f.version}`).join(" · ")}
            </p>
          )}
          {item.targets.length > 0 ? <TargetsTable targets={item.targets} /> : <p className={s.dim}>{t(`adv.noTargets.${item.status}`)}</p>}
          {item.actions.length > 0 && (
            <>
              <h4 className={s.h}>{t("adv.actions")}</h4>
              <ol className={s.actions}>{item.actions.map((a) => <li key={a}>{a}</li>)}</ol>
            </>
          )}
          {item.url && <a className={s.link} href={item.url} target="_blank" rel="noreferrer">{t("adv.official")} ↗</a>}
        </div>
      )}
    </li>
  );
}

const SEV_TONE = { critical: "high", high: "high", medium: "medium", low: "low", unknown: "neutral" } as const;

function ComponentsPanel({ d }: { d: AdvisoriesResponse }) {
  const { t } = useI18n();
  const [f, setF] = useState<FindingFilter>({ severe: true, where: "all" });
  const counts = findingCounts(d.findings);
  const rows = filterFindings(d.findings, f);
  const c = d.components;
  return (
    <div className={s.tabBody}>
      <p className={s.dim}>
        {t("adv.sbom.checked", { npm: c.byKind.npm, os: c.byKind.os, k8s: c.byKind.k8s, image: c.byKind.image })}
        {c.unmappedImages > 0 ? ` · ${t("adv.sbom.unmapped", { n: c.unmappedImages })}` : ""}
      </p>
      <div className={s.filters}>
        <Segmented label={t("adv.sbom.filter")} value={f.severe ? "severe" : "all"} onChange={(v) => setF({ ...f, severe: v === "severe" })}
          items={[{ id: "severe", label: `${t("adv.sbom.severe")} ${counts.severe}` }, { id: "all", label: `${t("adv.sbom.all")} ${counts.all}` }]} />
        <Segmented label={t("adv.sbom.where")} value={f.where} onChange={(v) => setF({ ...f, where: v })}
          items={[{ id: "all" as const, label: t("adv.sbom.whereAll") }, { id: "platform" as const, label: `${t("adv.sbom.platform")} ${counts.platform}` }, { id: "cluster" as const, label: `${t("adv.sbom.cluster")} ${counts.cluster}` }]} />
      </div>
      {rows.length === 0 ? <EmptyState title={d.components.platform + d.components.cluster === 0 ? t("adv.sbom.none") : t("adv.sbom.clean")} /> : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">{t("adv.sbom.col.sev")}</th>
                <th scope="col">{t("adv.sbom.col.pkg")}</th>
                <th scope="col">{t("adv.sbom.col.vuln")}</th>
                <th scope="col">{t("adv.sbom.col.fix")}</th>
                <th scope="col">{t("adv.sbom.col.where")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x: DependencyFinding) => (
                <tr key={`${x.id}|${x.pkg}|${x.version}`} data-status={x.exploited || x.severity === "critical" ? "affected" : undefined}>
                  <td>
                    <Badge tone={SEV_TONE[x.severity]}>{t(`adv.sev.${x.severity}`)}{x.cvss ? ` ${x.cvss.score.toFixed(1)}` : ""}</Badge>
                    {x.exploited && <div><Badge tone={x.exploited === "poc" ? "medium" : "high"}>{t(`adv.exploited.${x.exploited}`)}</Badge></div>}
                  </td>
                  <td>
                    <div className={s.targetMain}>{x.pkg}</div>
                    <div className={s.mono}>{x.version}</div>
                    <div className={s.dim}>{t(`adv.kind.${x.kind}`)} · {x.ecosystem}</div>
                  </td>
                  <td>
                    <a className={s.cveId} href={x.url} target="_blank" rel="noreferrer">{x.id}</a>
                    {x.cves.map((id) => <span key={id}> · <a className={s.cveId} href={cveOrgUrl(id)} target="_blank" rel="noreferrer">{id}</a></span>)}
                    {x.summary && <div className={s.dim}>{x.summary}</div>}
                  </td>
                  <td className={s.mono}>{x.fixed ? `→ ${x.fixed}` : <span className={s.warn}>{t("adv.sbom.noFix")}</span>}</td>
                  <td>
                    <div title={x.components.join("\n")}>{x.components.slice(0, 3).join(" · ")}{x.components.length > 3 ? ` +${x.components.length - 3}` : ""}</div>
                    {x.image && <div className={s.dim}>{x.image}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={s.dim}>{t("adv.sbom.howTo")}</p>
    </div>
  );
}

export default function SecurityAdvisoriesPage() {
  const { t, locale } = useI18n();
  const { clusters, clusterId, setClusterId, loading: clustersLoading } = useAksClusters();
  const realCluster = clusterId && !clusterId.toLowerCase().startsWith(MOCK_SUB) ? clusterId : "";
  const [watch, setWatch] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"advisories" | "components" | "kev">("advisories");
  useEffect(() => { setWatch(loadWatch()); }, []);

  const q = useApiQuery(clustersLoading ? null : `advisories:${realCluster}:${watch.join(",")}:${locale}`, (token) =>
    fetchJsonWithBearer<AdvisoriesResponse>(apiUrl("/api/security/advisories", { clusterId: realCluster || undefined, cves: watch.join(",") || undefined, lang: locale }), token),
  );
  const d = q.data;
  const { main, kev } = useMemo(() => splitItems(d?.items ?? []), [d]);
  const isOpen = (i: AdvisoryItem) => open[i.key] ?? i.status === "affected";

  const add = (e: FormEvent) => {
    e.preventDefault();
    const next = mergeWatch(watch, parseWatch(draft));
    setWatch(next);
    saveWatch(next);
    setDraft("");
  };
  const remove = (id: string) => { const next = watch.filter((x) => x !== id); setWatch(next); saveWatch(next); };

  return (
    <div className={s.page}>
      <PageHeader
        meta={d ? <span>{t("adv.sourceLine")} · {t("common.updated")} {new Date(d.generatedAt).toLocaleTimeString(dateLocale(locale))}</span> : <span>{t("adv.sourceLine")}</span>}
        actions={
          <>
            <Select label={t("common.cluster")} value={clusterId} onChange={setClusterId}
              placeholder={clustersLoading ? t("common.loading") : t("adv.noCluster")}
              options={clusters.map((c) => ({ value: c.id, label: c.name }))} />
            <Button onClick={q.reload} disabled={q.loading}>{q.loading ? t("common.loading") : t("common.refresh")}</Button>
          </>
        }
      />
      <ErrorNotice error={q.error} />
      {!d ? <LoadingState /> : (
        <>
          <ul className={s.sources} aria-label={t("adv.sources")}>
            {d.sources.map((x) => (
              <li key={x.id} className={s.source} data-state={x.state} title={[t(`adv.src.${x.id}.hint`), t(`adv.state.${x.state}`), x.detail ?? "", x.checkedAt ? new Date(x.checkedAt).toLocaleString(dateLocale(locale)) : ""].filter(Boolean).join("\n")}>
                <span aria-hidden="true">{STATE_GLYPH[x.state]}</span>
                {x.url ? <a href={x.url} target="_blank" rel="noreferrer">{t(`adv.src.${x.id}`)}</a> : t(`adv.src.${x.id}`)}
                <span className={x.state === "failed" ? s.bad : s.srOnly}> {t(`adv.state.${x.state}`)}</span>
              </li>
            ))}
          </ul>

          <div className={s.stats}>
            <Stat label={t("adv.kpi.affected")} value={d.summary.affected} tone={d.summary.affected ? "high" : undefined} hint={t("adv.kpi.affectedHint")} />
            <Stat label={t("adv.kpi.unknown")} value={d.summary.unknown} tone={d.summary.unknown ? "medium" : undefined} hint={t("adv.kpi.unknownHint")} />
            <Stat label={t("adv.kpi.findings")} value={d.summary.findingsSevere} tone={d.summary.findingsSevere ? "high" : undefined} hint={t("adv.kpi.findingsHint", { n: d.components.platform + d.components.cluster })} />
            <Stat label={t("adv.kpi.kev")} value={d.summary.kevRecent} hint={t("adv.kpi.kevHint")} />
          </div>

          <Tabs label={t("adv.tabs")} value={tab} onChange={setTab} idPrefix="adv"
            items={[
              { id: "advisories", label: t("adv.tab.advisories"), count: main.length },
              { id: "components", label: t("adv.tab.components"), count: d.summary.findingsSevere },
              { id: "kev", label: t("adv.tab.kev"), count: kev.length },
            ]} />
          {tab === "advisories" && (
            <div className={s.tabBody}>
          <Panel title={t("adv.runtimes")} sub={t("adv.runtimesSub")}>
            <ul className={s.runtimes}>
              {d.runtimes.map((r) => <li key={`${r.product}${r.where}`}><strong>{t(`adv.product.${r.product}`)} {r.version}</strong> <span className={s.dim}>· {r.where} · {t(`adv.ev.${r.evidence}`)}</span></li>)}
            </ul>
          </Panel>

          <form className={s.watchForm} onSubmit={add}>
            <label className={s.watchLabel}>
              <span>{t("adv.watch")}</span>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="CVE-2026-109618, CVE-2026-111497" aria-describedby="adv-watch-hint" />
            </label>
            <Button type="submit" disabled={!parseWatch(draft).length}>{t("adv.watchAdd")}</Button>
            <span id="adv-watch-hint" className={s.dim}>{t("adv.watchHint", { n: 20 })}</span>
            {watch.length > 0 && (
              <ul className={s.watchList}>
                {watch.map((c) => <li key={c}><span className={s.mono}>{c}</span><button type="button" aria-label={t("adv.watchRemove", { id: c })} onClick={() => remove(c)}>✕</button></li>)}
              </ul>
            )}
          </form>

          {main.length === 0 ? <EmptyState title={t("adv.empty")} /> : (
            <ul className={s.cards}>
              {main.map((i) => <AdvisoryCard key={i.key} item={i} open={isOpen(i)} onToggle={() => setOpen({ ...open, [i.key]: !isOpen(i) })} />)}
            </ul>
          )}

            </div>
          )}
          {tab === "components" && <ComponentsPanel d={d} />}
          {tab === "kev" && (
          <Panel title={t("adv.kevTitle", { n: kev.length })} sub={t("adv.kevSub")}>
            {kev.some(kevHitsUs) && <Notice tone="danger">{t("adv.kevHit", { n: kev.filter(kevHitsUs).length })}</Notice>}
            {kev.length > 0 && (
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th scope="col">{t("adv.kevCol.added")}</th><th scope="col">CVE</th><th scope="col">{t("adv.kevCol.what")}</th><th scope="col">{t("adv.kevCol.due")}</th><th scope="col">{t("adv.kevCol.us")}</th></tr></thead>
                  <tbody>
                    {kev.map((i) => {
                      const c = i.cves[0]!;
                      return (
                        <tr key={i.key} data-status={kevHitsUs(i) ? "affected" : undefined}>
                          <td className={s.mono}>{i.date}</td>
                          <td><a className={s.cveId} href={i.url ?? "#"} target="_blank" rel="noreferrer">{c.id}</a></td>
                          <td>{i.title}{c.kev?.ransomware ? <Badge tone="high">{t("adv.ransomware")}</Badge> : null}</td>
                          <td className={s.mono}>{c.kev?.dueDate}</td>
                          <td>{kevHitsUs(i) ? <Badge tone="high">{t("adv.status.affected")}</Badge> : <span className={s.dim}>{t(`adv.status.${i.status}`)}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          )}
        </>
      )}
    </div>
  );
}

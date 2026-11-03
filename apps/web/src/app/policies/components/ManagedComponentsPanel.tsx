"use client";

// AKS 보안 점검 › 인벤토리 › AKS 관리 부품 — the parts Microsoft builds and patches (ama · Cilium/CNS · CSI · Defender ·
// Azure Policy · CoreDNS …). Like the lift in a block of flats: the management office repairs it, we can only read the
// notice board — which CVEs Microsoft has fixed in a newer tag (arrives with the next release / add-on update), which it
// has not yet, and when the next AKS release reaches this region. API services/aksManagedVulns.ts, view lib/aksManagedView.ts.

import { Fragment, useState } from "react";
import type { AksManagedComponent, AksManagedVulnsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, EmptyState, ErrorNotice, LoadingState, Notice, Stat } from "@/components/ui";
import { STATUS_GLYPH, STATUS_LEVEL, compareKind, countsOf, groupByFamily, shortImage } from "@/lib/aksManagedView";
import styles from "../styles.module.css";

const LEARN = "https://learn.microsoft.com/azure/aks/concepts-vulnerability-management";
const CVE_VIEWER = "https://releases.aks.azure.com";

export function ManagedComponentsPanel({ clusterId }: { clusterId: string }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const q = useApiQuery(clusterId ? `aks-managed:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<AksManagedVulnsResponse>(apiUrl("/api/kubernetes/policies/managed-components", { clusterId }), token),
  );
  const d = q.data?.clusterId === clusterId ? q.data : null;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d) return <LoadingState label={t("mg.loading")} />;

  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(dateLocale(locale)) : "—");
  const families = groupByFamily(d.components);
  const all = countsOf(d.components);
  const region = d.release.region;
  const failed = d.sources.filter((s) => s.state !== "ok");

  return (
    <div className={styles.mgRoot}>
      <Notice tone="info" title={t("mg.title")}>
        {t("mg.intro")}{" "}
        <a href={LEARN} target="_blank" rel="noreferrer">{t("mg.policyLink")}</a> · <a href={CVE_VIEWER} target="_blank" rel="noreferrer">{t("mg.trackerLink")}</a>
      </Notice>
      {failed.length > 0 && (
        <Notice tone="warning" title={t("mg.sourcesFailed")}>
          {failed.map((s) => `${t(`mg.src.${s.id}`)} — ${t(`mg.srcState.${s.state}`)}${s.detail ? ` (${s.detail})` : ""}`).join(" · ")}
        </Notice>
      )}

      <div className={styles.mgStats}>
        <Stat label={t("mg.stat.region", { region: d.location ?? "—" })} value={region?.current ?? "—"}
          hint={region ? t("mg.stat.regionSince", { at: date(region.since) }) : t("mg.stat.regionUnknown")} />
        <Stat label={t("mg.stat.latest")} value={d.release.latest ?? "—"}
          hint={d.release.notYetInRegion.length ? t("mg.stat.notYet", { list: d.release.notYetInRegion.join(", ") }) : t("mg.stat.inRegion")} tone={d.release.notYetInRegion.length ? "medium" : "success"} />
        <Stat label={t("mg.stat.components")} value={d.totals.components} hint={t("mg.stat.scanned", { n: d.totals.scanned })} />
        <Stat label={t("mg.stat.cves")} value={d.totals.cves}
          hint={t("mg.stat.split", { fixed: all.fixedInLatest, pending: all.pendingMs, unknown: all.unknown })} />
        <Stat label={t("mg.stat.kev")} value={d.totals.kev} hint={t("mg.stat.kevHint")} tone={d.totals.kev ? "high" : "success"} />
      </div>

      <ul className={styles.mgLegend} aria-label={t("mg.legend")}>
        {(["pendingMs", "fixedInLatest", "unknown"] as const).map((s) => (
          <li key={s} data-level={STATUS_LEVEL[s]}><span className={styles.mgGlyph} aria-hidden="true">{STATUS_GLYPH[s]}</span> <strong>{t(`mg.status.${s}`)}</strong> — {t(`mg.statusHint.${s}`)}</li>
        ))}
        <li data-level="danger"><span className={styles.mgGlyph} aria-hidden="true">■</span> <strong>KEV</strong> — {t("mg.kevLegend")}</li>
      </ul>

      {d.components.length === 0 ? <EmptyState title={t("mg.empty")} /> : (
        <div className={styles.mgTableWrap}>
          <table className={styles.mgTable}>
            <caption className={styles.srOnly}>{t("mg.caption", { n: d.components.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("mg.col.image")}</th>
                <th scope="col">{t("mg.col.where")}</th>
                <th scope="col">{t("mg.col.scan")}</th>
                <th scope="col">{t("mg.col.compare")}</th>
                <th scope="col">{t("mg.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <Fragment key={f.family}>
                  <tr className={styles.mgFamily}>
                    <th scope="rowgroup" colSpan={5}>
                      {t(`mg.family.${f.family}`)} <span className={styles.muted}>· {t("mg.familyN", { n: f.components.length })}</span>
                      <Counts n={f.counts} />
                      <a href={f.notes} target="_blank" rel="noreferrer" className={styles.mgNotes}>{t("mg.notes")} ↗</a>
                    </th>
                  </tr>
                  {f.components.map((c) => {
                    const k = `${c.image}:${c.tag}`;
                    return (
                      <Fragment key={k}>
                        <tr data-open={open === k || undefined}>
                          <th scope="row">
                            <button type="button" className={styles.mgName} aria-expanded={open === k} disabled={!c.cves.length}
                              onClick={() => setOpen(open === k ? null : k)} title={k}>
                              {c.cves.length ? <span aria-hidden="true">{open === k ? "▾" : "▸"} </span> : null}
                              <strong>{shortImage(c.image)}</strong><span className={styles.muted}>:{c.tag}</span>
                            </button>
                          </th>
                          <td className={styles.mgWhere}>{c.where.map((w) => `${w.namespace} · ${w.containers.join(", ")} (${t("mg.pods", { n: w.pods })})`).join(" / ")}</td>
                          <td>{c.scan === "scanned" ? t("mg.scan.n", { n: c.cves.length }) : <span className={styles.muted}>{t(`mg.scan.${c.scan}`)}</span>}</td>
                          <td><Compare c={c} /></td>
                          <td><Counts n={countsOf([c])} /></td>
                        </tr>
                        {open === k && (
                          <tr className={styles.mgCves}>
                            <td colSpan={5}>
                              <ul>
                                {c.cves.map((v) => (
                                  <li key={v.id} data-level={v.kev ? "danger" : STATUS_LEVEL[v.status]}>
                                    <span className={styles.mgGlyph} aria-hidden="true">{v.kev ? "■" : STATUS_GLYPH[v.status]}</span>
                                    <a href={`https://www.cve.org/CVERecord?id=${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer">{v.id}</a>
                                    <span className={styles.muted}>{v.severity ? `${t(`mg.sev.${v.severity}`)}${v.score != null ? ` ${v.score}` : ""}` : t("mg.sev.none")}</span>
                                    <span>{t(`mg.status.${v.status}`)}{v.kev ? ` · ${t("mg.kev")}` : ""}</span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.nodeImages.length > 0 && (
        <section className={styles.mgNodes} aria-label={t("mg.nodes.title")}>
          <h4>{t("mg.nodes.title")}</h4>
          {d.nodeImages.map((n) => (
            <div key={n.image} className={styles.mgNode}>
              <div>
                <strong>{n.image}</strong> <span className={styles.muted}>· {t("mg.nodes.count", { n: n.nodes })}</span>
                {n.regionCurrent ? <span className={styles.muted}> · {t("mg.nodes.regionBuild", { v: n.regionCurrent })}</span> : null}
              </div>
              {n.state === "ok" ? (
                <>
                  <p>{t("mg.nodes.summary", { cves: n.cves, pkgs: n.withCves, all: n.packages, kernel: n.kernelCves })}</p>
                  <p className={styles.muted}>{t("mg.nodes.kernelNote")}</p>
                  <ul className={styles.mgTop}>
                    {n.top.map((p) => <li key={p.name}><code>{p.name}</code> {p.version} — {t("mg.nodes.pkgCves", { n: p.cves })}</li>)}
                  </ul>
                </>
              ) : <p className={styles.muted}>{t(`mg.nodes.state.${n.state}`)}</p>}
            </div>
          ))}
        </section>
      )}

      <p className={styles.panelHint}>
        {t("mg.footer", { at: new Date(d.generatedAt).toLocaleString(dateLocale(locale)) })}
        {d.pending > 0 ? ` · ${t("mg.pending", { n: d.pending })}` : ""}{" "}
        <Button size="sm" variant="ghost" onClick={q.reload}>{t("common.refresh")}</Button>
      </p>
    </div>
  );
}

function Counts({ n }: { n: ReturnType<typeof countsOf> }) {
  const { t } = useI18n();
  const items = [
    n.kev ? { level: "danger", glyph: "■", text: `KEV ${n.kev}`, title: t("mg.kevLegend") } : null,
    n.pendingMs ? { level: "warn", glyph: STATUS_GLYPH.pendingMs, text: String(n.pendingMs), title: t("mg.status.pendingMs") } : null,
    n.fixedInLatest ? { level: "info", glyph: STATUS_GLYPH.fixedInLatest, text: String(n.fixedInLatest), title: t("mg.status.fixedInLatest") } : null,
    n.unknown ? { level: "unknown", glyph: STATUS_GLYPH.unknown, text: String(n.unknown), title: t("mg.status.unknown") } : null,
  ].filter(Boolean) as { level: string; glyph: string; text: string; title: string }[];
  if (!items.length) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.mgCounts}>
      {items.map((x) => <span key={x.level} data-level={x.level} className={styles.mgPill} title={x.title}><span aria-hidden="true">{x.glyph}</span> {x.text}</span>)}
    </span>
  );
}

function Compare({ c }: { c: AksManagedComponent }) {
  const { t } = useI18n();
  const kind = compareKind(c);
  if (kind === "none") return <span className={styles.muted}>{t("mg.cmp.none")}</span>;
  if (kind === "same") return <span>{t("mg.cmp.same")}</span>;
  if (kind === "newerUnscanned") return <span className={styles.muted}>{t("mg.cmp.newerUnscanned", { tag: c.latest!.tag })}</span>;
  return <span>{t("mg.cmp.newer", { tag: c.latest!.tag, n: c.latest!.cves ?? 0 })}</span>;
}

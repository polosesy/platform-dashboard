"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { KbomItem, PolicyInsightsResponse } from "@aud/types";
import { Stat } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { Pill } from "./Inspector";
import styles from "./insights.module.css";

const FLAG_TONE = { drift: "warn", snapshot: "warn", public: "unk" } as const;

type Vuln = NonNullable<KbomItem["vuln"]>;
const exploitedHard = (v: Vuln) => v.exploited === "kev" || v.exploited === "active";

/** One chip per repo: exploited (crit) › critical/high (warn) › scanned clean (ok) */
function VulnPill({ v }: { v: Vuln }) {
  const { t } = useI18n();
  const src = t(`ins.kbom.vuln.src.${v.source}`);
  if (exploitedHard(v)) return <Pill tone="crit" title={src}>{t("ins.kbom.vuln.exploited", { kind: v.exploited! === "kev" ? "KEV" : "CVE.org" })}</Pill>;
  if (v.counts.critical || v.counts.high) return <Pill tone="warn" title={src}>{t("ins.kbom.vuln.sev", { c: v.counts.critical, h: v.counts.high })}</Pill>;
  return <Pill tone="ok" title={src}>{t("ins.kbom.vuln.clean")}</Pill>;
}

/** The CVE card: repos with a critical/high or exploited finding, and how much was scanned (never "0" for "not read") */
function vulnStat(data: PolicyInsightsResponse, t: (k: string, v?: Record<string, string | number>) => string): { label: string; value: string | number; hint?: ReactNode; warn?: boolean } {
  const s = data.kbom.summary;
  const cov = data.vulns?.coverage;
  if (s.vulnerable == null || !cov) return { label: t("ins.kbom.cve"), value: "—", hint: t("ins.kbom.notConnected") };
  const srcs = [cov.defender === "ok" && "Defender", cov.sbom === "ok" && cov.sbomMapped > 0 && "SBOM"].filter(Boolean).join(" · ");
  return {
    label: t("ins.kbom.cve"),
    value: s.scanned ? s.vulnerable : "—",
    warn: s.vulnerable > 0,
    hint: <span title={t("ins.kbom.vuln.coverageTip", { defender: t(`ins.kbom.vuln.def.${cov.defender}`), mapped: cov.sbomMapped, images: cov.images })}>
      {s.scanned ? t("ins.kbom.vuln.hint", { n: s.scanned, m: s.images, src: srcs || "—" }) : t("ins.kbom.vuln.none")}
    </span>,
  };
}

export function KbomPanel({ data }: { data: PolicyInsightsResponse }) {
  const { t } = useI18n();
  const [showManaged, setShowManaged] = useState(false);
  const k = data.kbom;
  const cats = [...new Set(k.items.map((i) => i.category))];
  const managed = k.items.filter((i) => i.managed).length;
  const registries = k.summary.registries.join(", ");
  // KPI card standard (UI kit Stat): label · number or "—" · reason — same width and height in one grid
  const stats: Array<{ label: string; value: string | number; hint?: ReactNode; warn?: boolean }> = [
    { label: t("ins.kbom.images"), value: k.summary.images, hint: managed ? t("ins.kbom.hint.managed", { n: managed }) : undefined },
    { label: t("ins.kbom.registries"), value: k.summary.registries.length, hint: registries ? <span title={registries}>{registries}</span> : undefined },
    { label: t("ins.kbom.drift"), value: k.summary.drift, warn: k.summary.drift > 0, hint: t("ins.kbom.hint.drift") },
    { label: t("ins.kbom.snapshot"), value: k.summary.snapshot, warn: k.summary.snapshot > 0, hint: t("ins.kbom.hint.snapshot") },
    { label: t("ins.kbom.publicPull"), value: k.summary.publicPull, warn: k.summary.publicPull > 0, hint: t("ins.kbom.hint.publicPull") },
    { label: t("ins.kbom.digest"), value: `${k.summary.digestPinned}/${k.summary.images}`, warn: k.summary.digestPinned < k.summary.images,
      hint: k.summary.images > k.summary.digestPinned ? t("ins.kbom.hint.tagOnly", { n: k.summary.images - k.summary.digestPinned }) : undefined },
    vulnStat(data, t),
  ];
  return (
    <section className={styles.panel} aria-label={t("ins.kbom.aria")}>
      <div className={styles.panelH}>
        <div>
          <h3>{t("ins.kbom.title")}</h3>
          <div className={styles.sub}>{t("ins.kbom.sub")}</div>
        </div>
        <button className={styles.fchip} aria-pressed={showManaged} onClick={() => setShowManaged(!showManaged)}>
          {showManaged ? t("ins.kbom.hideManaged") : t("ins.kbom.showManaged", { n: managed })}
        </button>
      </div>
      <div className={styles.panelB} style={{ display: "grid", gap: 12 }}>
        <div className={styles.kbSum}>
          {stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} hint={x.hint} tone={x.warn ? "medium" : undefined} />)}
        </div>
        {data.gitops && data.gitops.state !== "ok" && data.gitops.state !== "notInstalled" ? (
          <div className={styles.muted} style={{ fontSize: 12 }}>{t(`ins.kbom.gitops.${data.gitops.state}`)}</div>
        ) : null}
        <div className={styles.kbPlat}>
          {k.platform.map((p) => (
            <div key={p.label}>
              <div className={styles.muted} style={{ fontSize: 11 }}>{p.label}</div>
              <div className={styles.v}>{p.value}</div>
              {p.note && <div className={styles.s}>{p.note}</div>}
            </div>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.tbl}>
            <thead><tr><th>{t("ins.kbom.col.tech")}</th><th>{t("ins.kbom.col.version")}</th><th>{t("ins.kbom.col.source")}</th><th>{t("ins.kbom.col.where")}</th><th>{t("ins.kbom.col.deployedFrom")}</th><th>{t("ins.kbom.col.signals")}</th></tr></thead>
            <tbody>
              {cats.map((cat) => {
                const all = k.items.filter((i) => i.category === cat);
                const items = all.filter((i) => showManaged || !i.managed);
                if (!items.length) return null;
                return (
                  <Fragment key={cat}>
                    <tr className={styles.catRow}><td colSpan={6}>{cat} <span className={styles.muted} style={{ fontWeight: 500 }}>{items.length}{all.length > items.length ? ` (+${t("ins.managed")} ${all.length - items.length})` : ""}</span></td></tr>
                    {items.map((x) => (
                      <tr key={x.repo}>
                        <td><b>{x.tech}</b>{x.managed && <span className={styles.mgd}>{t("ins.managed")}</span>}<div className={`${styles.mono} ${styles.muted}`} style={{ fontSize: 11 }}>{x.repo}</div></td>
                        <td>{x.versions.map((v) => <span key={v} className={styles.ver} data-bad={/snapshot|latest/i.test(v) || x.versions.length > 1 || undefined}>{v}</span>)}</td>
                        <td className={styles.mono}>{x.registry}</td>
                        <td className={styles.muted} style={{ fontSize: 12 }}>{x.workloads.map((w) => w.split("/")[1]).join(", ")}</td>
                        <td style={{ fontSize: 12 }}>{x.sources?.length ? x.sources.map((src) => (
                          <div key={`${src.appNamespace}/${src.app}`} title={`${src.repo}${src.path ? ` · ${src.path}` : src.chart ? ` · chart ${src.chart}` : ""}${src.syncedRevision ? ` · ${src.syncedRevision.slice(0, 12)}` : ""}`}>
                            <b>{src.app}</b> <span className={styles.muted}>{src.path ?? src.chart ?? ""}</span>
                          </div>
                        )) : <span className={styles.muted}>-</span>}</td>
                        <td>
                          {x.vuln && <VulnPill v={x.vuln} />}
                          {x.flags.map((f) => <Pill key={f.key} tone={FLAG_TONE[f.key]}>{f.label}</Pill>)}
                          {!x.flags.length && !x.vuln && <span className={styles.muted}>-</span>}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

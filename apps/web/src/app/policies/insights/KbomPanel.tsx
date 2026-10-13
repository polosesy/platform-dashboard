"use client";

import { Fragment, useState } from "react";
import type { PolicyInsightsResponse } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { Pill } from "./Inspector";
import styles from "./insights.module.css";

const FLAG_TONE = { drift: "warn", snapshot: "warn", public: "unk" } as const;

export function KbomPanel({ data }: { data: PolicyInsightsResponse }) {
  const { t } = useI18n();
  const [showManaged, setShowManaged] = useState(false);
  const k = data.kbom;
  const cats = [...new Set(k.items.map((i) => i.category))];
  const managed = k.items.filter((i) => i.managed).length;
  const stats: Array<[boolean, string | number, string]> = [
    [false, k.summary.images, t("ins.kbom.images")],
    [false, k.summary.registries.length, `${t("ins.kbom.registries")} · ${k.summary.registries.join(", ")}`],
    [k.summary.drift > 0, k.summary.drift, t("ins.kbom.drift")],
    [k.summary.snapshot > 0, k.summary.snapshot, t("ins.kbom.snapshot")],
    [k.summary.publicPull > 0, k.summary.publicPull, t("ins.kbom.publicPull")],
    [k.summary.digestPinned < k.summary.images, `${k.summary.digestPinned}/${k.summary.images}`, t("ins.kbom.digest")],
    [false, t("ins.kbom.notConnected"), t("ins.kbom.cve")],
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
          {stats.map(([warn, v, l]) => <div key={l} className={styles.kbStat} data-warn={warn || undefined}><b>{v}</b>{l}</div>)}
        </div>
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
            <thead><tr><th>{t("ins.kbom.col.tech")}</th><th>{t("ins.kbom.col.version")}</th><th>{t("ins.kbom.col.source")}</th><th>{t("ins.kbom.col.where")}</th><th>{t("ins.kbom.col.signals")}</th></tr></thead>
            <tbody>
              {cats.map((cat) => {
                const all = k.items.filter((i) => i.category === cat);
                const items = all.filter((i) => showManaged || !i.managed);
                if (!items.length) return null;
                return (
                  <Fragment key={cat}>
                    <tr className={styles.catRow}><td colSpan={5}>{cat} <span className={styles.muted} style={{ fontWeight: 500 }}>{items.length}{all.length > items.length ? ` (+${t("ins.managed")} ${all.length - items.length})` : ""}</span></td></tr>
                    {items.map((x) => (
                      <tr key={x.repo}>
                        <td><b>{x.tech}</b>{x.managed && <span className={styles.mgd}>{t("ins.managed")}</span>}<div className={`${styles.mono} ${styles.muted}`} style={{ fontSize: 11 }}>{x.repo}</div></td>
                        <td>{x.versions.map((v) => <span key={v} className={styles.ver} data-bad={/snapshot|latest/i.test(v) || x.versions.length > 1 || undefined}>{v}</span>)}</td>
                        <td className={styles.mono}>{x.registry}</td>
                        <td className={styles.muted} style={{ fontSize: 12 }}>{x.workloads.map((w) => w.split("/")[1]).join(", ")}</td>
                        <td>{x.flags.length ? x.flags.map((f) => <Pill key={f.key} tone={FLAG_TONE[f.key]}>{f.label}</Pill>) : <span className={styles.muted}>-</span>}</td>
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

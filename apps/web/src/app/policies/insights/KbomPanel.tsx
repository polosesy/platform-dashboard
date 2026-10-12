"use client";

import { Fragment, useState } from "react";
import type { PolicyInsightsResponse } from "@aud/types";
import { Pill } from "./Inspector";
import styles from "./insights.module.css";

const FLAG_TONE = { drift: "warn", snapshot: "warn", public: "unk" } as const;

export function KbomPanel({ data }: { data: PolicyInsightsResponse }) {
  const [showManaged, setShowManaged] = useState(false);
  const k = data.kbom;
  const cats = [...new Set(k.items.map((i) => i.category))];
  const managed = k.items.filter((i) => i.managed).length;
  const stats: Array<[boolean, string | number, string]> = [
    [false, k.summary.images, "이미지(기술)"],
    [false, k.summary.registries.length, `레지스트리 · ${k.summary.registries.join(", ")}`],
    [k.summary.drift > 0, k.summary.drift, "버전 혼재"],
    [k.summary.snapshot > 0, k.summary.snapshot, "비릴리스 태그 실행 중"],
    [k.summary.publicPull > 0, k.summary.publicPull, "공개 레지스트리 직접 pull"],
    [k.summary.digestPinned < k.summary.images, `${k.summary.digestPinned}/${k.summary.images}`, "다이제스트 고정"],
    [false, "미연동", "취약점(CVE)"],
  ];
  return (
    <section className={styles.panel} aria-label="클러스터 구성 목록">
      <div className={styles.panelH}>
        <div>
          <h3>구성 목록 (KBOM) · 실행 중인 기술과 버전</h3>
          <div className={styles.sub}>워크로드 파드 템플릿의 이미지와 노드 정보에서 생성. 취약점(CVE) 데이터는 연결되지 않았습니다.</div>
        </div>
        <button className={styles.fchip} aria-pressed={showManaged} onClick={() => setShowManaged(!showManaged)}>
          {showManaged ? "AKS 관리 이미지 숨기기" : `AKS 관리 이미지 ${managed}개 포함`}
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
            <thead><tr><th>기술</th><th>버전</th><th>출처</th><th>실행 위치</th><th>신호</th></tr></thead>
            <tbody>
              {cats.map((cat) => {
                const all = k.items.filter((i) => i.category === cat);
                const items = all.filter((i) => showManaged || !i.managed);
                if (!items.length) return null;
                return (
                  <Fragment key={cat}>
                    <tr className={styles.catRow}><td colSpan={5}>{cat} <span className={styles.muted} style={{ fontWeight: 500 }}>{items.length}{all.length > items.length ? ` (+AKS 관리 ${all.length - items.length})` : ""}</span></td></tr>
                    {items.map((x) => (
                      <tr key={x.repo}>
                        <td><b>{x.tech}</b>{x.managed && <span className={styles.mgd}>AKS 관리</span>}<div className={`${styles.mono} ${styles.muted}`} style={{ fontSize: 11 }}>{x.repo}</div></td>
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

"use client";

// VPA recommendation beside what the workload asks for now (Kubernetes API — services/workloadVpa.ts). Per container
// and resource: request · limit · VPA target · VPA's lower–upper bound. Only VPA's own semantics are marked: the target
// above the limit and a request below the lower bound in the warning tone, a request above the upper bound in a
// neutral tone (VPA never recommends CPU below its 25m floor, so "above upper" is common and rarely waste).

import type { ResourcePair, VpaContainer, WorkloadVpaResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { ErrorNotice, LoadingState } from "@/components/ui";
import { formatBytes, formatCores } from "@/lib/workloadHeatView";
import styles from "../styles.module.css";

const RES = ["memory", "cpu"] as const;

export function WorkloadVpaSection({ clusterId, namespace, workload, kind }: { clusterId: string; namespace: string; workload: string; kind: string | null }) {
  const { t } = useI18n();
  const q = useApiQuery(`vpa:${clusterId}:${namespace}:${workload}:${kind ?? ""}`, (token) =>
    fetchJsonWithBearer<WorkloadVpaResponse>(apiUrl("/api/observability/vpa", { clusterId, namespace, workload, kind }), token),
  );
  // Memory in whole Mi below 10Gi: VPA bounds sit a few Mi from the request (1180Mi vs 1181Mi) — 1.2Gi would hide it
  const fmt = (res: "memory" | "cpu", p: ResourcePair | null) => {
    const v = p?.[res];
    if (v == null) return "—";
    if (res === "cpu") return formatCores(v);
    return v < 10 * 1024 ** 3 ? `${Math.round(v / 1024 ** 2).toLocaleString()}Mi` : formatBytes(v);
  };
  const range = (c: VpaContainer, res: "memory" | "cpu") => {
    if (c.lower?.[res] == null || c.upper?.[res] == null) return "—";
    const lo = fmt(res, c.lower), hi = fmt(res, c.upper);
    return lo === hi ? lo : `${lo} ~ ${hi}`;
  };

  return (
    <>
      <h4 className={styles.stackTitle}>{t("ob.vpa.title")}</h4>
      {q.error ? <ErrorNotice error={q.error} /> : !q.data ? <LoadingState /> : q.data.state !== "ok" ? (
        <p className={styles.stackMuted}>{t(`ob.vpa.${q.data.state}`)}</p>
      ) : (
        q.data.vpas.map((v) => (
          <div key={v.name} className={styles.vpaBox}>
            <p className={styles.vpaHead}>
              <span className={styles.vpaMode} data-off={v.mode === "Off" || undefined}>{v.mode ?? "—"}</span>
              <span className={styles.stackMuted}>{t(v.mode === "Off" ? "ob.vpa.modeOff" : "ob.vpa.modeApply")}</span>
              {v.recommending === false && <span className={styles.stackMuted}>· {t("ob.vpa.noRec")}</span>}
            </p>
            {v.containers.map((c) => (
              <table key={c.name} className={styles.vpaTable} aria-label={c.name}>
                <caption title={c.name}>{c.name}</caption>
                <thead>
                  <tr><th /><th>{t("ob.vpa.request")}</th><th>{t("ob.vpa.limit")}</th><th>{t("ob.vpa.target")}</th><th>{t("ob.vpa.range")}</th></tr>
                </thead>
                <tbody>
                  {RES.map((res) => (
                    <tr key={res}>
                      <th scope="row">{t(`ob.vpa.res.${res}`)}</th>
                      <td>{fmt(res, c.request)}</td>
                      <td>{fmt(res, c.limit)}</td>
                      <td className={styles.vpaTarget}>{fmt(res, c.target)}</td>
                      <td>{range(c, res)}</td>
                    </tr>
                  ))}
                </tbody>
                {c.notes.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={5} className={styles.vpaNotes}>
                        {c.notes.map((n) => (
                          <span key={`${n.resource}:${n.kind}`} className={styles.vpaNote} data-tone={n.kind === "aboveUpper" ? "info" : "warn"} title={t(`ob.vpa.noteHint.${n.kind}`)}>
                            {t(`ob.vpa.res.${n.resource}`)} · {t(`ob.vpa.note.${n.kind}`)}
                          </span>
                        ))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            ))}
          </div>
        ))
      )}
    </>
  );
}

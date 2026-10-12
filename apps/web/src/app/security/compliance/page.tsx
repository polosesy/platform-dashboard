"use client";

import { Badge, EmptyState, LoadingState, Panel } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "../SecurityContext";
import { PostureNotices, SecurityHeader, useGap } from "../components";
import s from "../security.module.css";

/** 규정 준수 — passed/failed controls per regulatory standard, and Defender plan coverage. */
export default function SecurityCompliancePage() {
  const { t } = useI18n();
  const { posture } = useSecurity();
  const complianceGap = useGap("compliance");
  const plansGap = useGap("plans");

  return (
    <div className={s.page}>
      <SecurityHeader />
      <PostureNotices />
      {!posture ? (
        <LoadingState />
      ) : (
        <div className={s.split}>
          <Panel title={t("sec.standardsTitle")} sub={complianceGap ? undefined : String(posture.compliance.length)}>
            {complianceGap ? (
              <EmptyState title={t("sec.collectFailed")} />
            ) : posture.compliance.length === 0 ? (
              <EmptyState title={t("sec.noStandards")} />
            ) : (
              <>
                <div className={s.legend}>
                  <span><i className={`${s.dot} ${s.pass}`} />{t("sec.passed")}</span>
                  <span><i className={`${s.dot} ${s.failSeg}`} />{t("sec.failed")}</span>
                  <span><i className={`${s.dot} ${s.skip}`} />{t("sec.skipped")}</span>
                </div>
                {posture.compliance.map((c) => {
                  const total = Math.max(1, c.passed + c.failed + c.skipped);
                  return (
                    <div key={c.name} className={s.standard}>
                      <div className={s.standardHead}>
                        <span className={s.standardName}>{c.name}</span>
                        <span className={s.num}>
                          {t("sec.passed")} {c.passed} · {t("sec.failed")} {c.failed}
                          {c.skipped ? ` · ${t("sec.skipped")} ${c.skipped}` : ""}
                        </span>
                      </div>
                      <div className={s.stack} role="img" aria-label={`${c.name}: ${t("sec.passed")} ${c.passed}, ${t("sec.failed")} ${c.failed}`}>
                        <span className={s.pass} style={{ width: `${(c.passed / total) * 100}%` }} />
                        <span className={s.failSeg} style={{ width: `${(c.failed / total) * 100}%` }} />
                        <span className={s.skip} style={{ width: `${(c.skipped / total) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </Panel>

          <Panel title={t("sec.plansTitle")} flush>
            {plansGap ? (
              <div className={s.pad}><EmptyState title={t("sec.collectFailed")} /></div>
            ) : (
              <div className={`${s.tableWrap} ${s.tableFlush}`}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t("sec.plan")}</th>
                      <th scope="col">{t("sec.tier")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posture.plans.map((p) => (
                      <tr key={p.name}>
                        <td>{p.name}{p.subPlan ? <span className={s.dim}> · {p.subPlan}</span> : null}</td>
                        <td>{p.tier === "Standard" ? <Badge tone="success">{t("sec.protected")}</Badge> : <Badge tone="medium">{t("sec.unprotected")}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

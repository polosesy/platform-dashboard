"use client";

// 보안 › 이슈·통합 위험 › Azure 위험 조합 (API /api/security/azure-risk, docs/architecture/security-roadmap.md 5.3 ②):
// Wiz toxic combinations on Azure resources — Internet exposure × a High Defender recommendation × a managed identity
// with a privileged role. Each factor with its evidence; "could not tell" is shown as such (never as "no"), and the
// resources that could be a combination but a factor is unknown are counted. Each combination is also an issue above.

import { useCallback } from "react";
import type { AzureAttackPath, AzureRiskCombo, AzureRiskFactor, AzureRiskResponse } from "@aud/types";
import { Badge, Chip, EmptyState, ErrorNotice, LoadingState, Notice, Panel } from "@/components/ui";
import type { ChipLevel } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import s from "./risk.module.css";

// the issue list's mapping (the badge kit has no separate critical tone)
const SEV_TONE = { critical: "high", high: "high", medium: "medium" } as const;
const STATE_CHIP: Record<AzureRiskFactor["state"], ChipLevel> = { yes: "warn", no: "ok", unknown: "unknown", na: "neutral" };

/** The issue title of a combination in the page's language (lib/issueQueue has no translations) */
export function useAzureTitle() {
  const { t } = useI18n();
  return useCallback((c: AzureRiskCombo) => t(`azr.kind.${c.kind}`, { name: c.name }), [t]);
}

/** The same anchor the issue's link points at (azure:… combinations, path:… attack paths) */
export const comboAnchor = (key: string) => `azure-${key.replace(/^(azure|path):/, "").replace(/[^a-z0-9-]/g, "-")}`;

export function useAzurePathTitle() {
  const { t } = useI18n();
  return useCallback((p: AzureAttackPath) => t(`azp.ends.${p.ends}`, { name: p.entry.name }), [t]);
}

export function AzureRiskPanel({ data, error, loading }: { data: AzureRiskResponse | undefined; error: string | null | undefined; loading: boolean }) {
  const { t } = useI18n();
  const factor = (name: "exposure" | "high" | "identity", f: AzureRiskFactor & { count?: number; roles?: AzureRiskCombo["identity"]["roles"] }) => {
    const what = f.state === "yes"
      ? name === "high" ? t("azr.high.yes", { n: f.count ?? 0 })
        : name === "identity" ? (f.roles ?? []).map((r) => `${t(`azr.role.${r.role}`)} @ ${t(`azr.scope.${r.scope}`)}`).join(" · ")
        : f.limited ? t("azr.exposure.limited") : t("azr.exposure.any")
      : t(`azr.state.${f.state}`);
    return (
      <span className={s.azFactor}>
        <Chip level={STATE_CHIP[f.state]} title={f.reason ? t("azr.unknownWhy", { r: f.reason }) : undefined}>{t(`azr.factor.${name}`)}</Chip>
        <span className={s.dim}>{what}{f.detail && f.state === "yes" && name !== "identity" ? ` — ${f.detail}` : ""}</span>
      </span>
    );
  };
  return (
    <Panel id="azure-risk" title={t("azr.title")} sub={t("azr.sub")}
      footer={<span className={s.dim}>{t("azr.foot")}</span>}>
      {error ? <ErrorNotice error={error} />
        : !data ? (loading ? <LoadingState label={t("azr.loading")} /> : null)
        : (
          <>
            {data.gaps.length ? (
              <Notice tone="warning" title={t("azr.gaps")}>{data.gaps.map((g) => `${t(`azr.section.${g.section}`)}: ${g.message}`).join(" · ")}</Notice>
            ) : null}
            <p className={s.azSummary}>
              {t("azr.summary", { e: data.counts.exposed, h: data.counts.high, p: data.counts.privileged, c: data.counts.combos })}
              {data.counts.undetermined ? <> · <strong>{t("azr.undetermined", { n: data.counts.undetermined })}</strong></> : null}
            </p>
            {!data.combos.length ? <EmptyState title={t("azr.none")}>{data.counts.undetermined ? t("azr.noneButUnknown") : t("azr.noneHint")}</EmptyState> : (
              <ul className={s.azList}>
                {data.combos.map((c) => (
                  <li key={c.key} id={comboAnchor(c.key)} className={s.azItem}>
                    <div className={s.azHead}>
                      <Badge tone={SEV_TONE[c.sev]}>{t(`iq.sev.${c.sev}`)}</Badge>
                      <strong>{t(`azr.kind.${c.kind}`, { name: c.name })}</strong>
                      <a href={c.portalUrl} target="_blank" rel="noreferrer noopener">{t("azr.portal")}</a>
                    </div>
                    <span className={s.dim}>{c.type} · {c.resourceGroup}{c.exposure.limited ? ` · ${t("azr.sevLowered")}` : ""}</span>
                    <div className={s.azFactors}>
                      {factor("exposure", c.exposure)}
                      {factor("high", c.high)}
                      {factor("identity", c.identity)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </Panel>
  );
}

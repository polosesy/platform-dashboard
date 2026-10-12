"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useMsal } from "@azure/msal-react";
import type { PostureDomain, PostureRecommendation, PostureSection, PostureSeverity } from "@aud/types";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { Badge, ErrorNotice, Notice, PageHeader, SearchInput, Segmented, type BadgeTone } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { useSecurity } from "./SecurityContext";
import s from "./security.module.css";

export const DOMAINS: PostureDomain[] = ["identity", "network", "data", "compute", "container", "appServices", "other"];
const SEV_TONE: Record<string, BadgeTone> = { High: "high", Medium: "medium", Low: "low", Informational: "neutral" };

/** Translate a known code, otherwise show Defender's raw value (never invent a label). */
export function useLabel() {
  const { t } = useI18n();
  return (prefix: string, raw: string) => {
    const key = `${prefix}.${raw}`;
    const v = t(key);
    return v === key ? raw : v;
  };
}

export function relativeTime(iso: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return t("common.minutesAgo", { n: mins });
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? t("common.hoursAgo", { n: hrs }) : t("common.daysAgo", { n: Math.floor(hrs / 24) });
}

export function SeverityBadge({ severity }: { severity: string }) {
  const label = useLabel();
  return <Badge tone={SEV_TONE[severity] ?? "neutral"}>{label("sec.sev", severity)}</Badge>;
}

/** Page header shared by the /security pages: menu title, subscription picker, data source. */
export function SecurityHeader() {
  const { t } = useI18n();
  const { subscriptions, subscriptionId, setSubscriptionId, posture, loading } = useSecurity();
  return (
    <PageHeader
      actions={<SubscriptionSelect subscriptions={subscriptions} value={subscriptionId} onChange={setSubscriptionId} />}
      meta={
        <>
          <span>{t("sec.source")}</span>
          {posture && !loading ? <span>· {t("common.updated")} {relativeTime(posture.generatedAt, t)}</span> : null}
          {loading ? <span>· {t("common.loading")}</span> : null}
        </>
      }
    />
  );
}

/** Sample-data and partial-failure banners — always above any number. */
export function PostureNotices() {
  const { t } = useI18n();
  const { accounts } = useMsal();
  const { posture, error } = useSecurity();
  return (
    <>
      <ErrorNotice error={error} />
      {posture?.source === "mock" ? (
        <Notice tone="warning" title={t("common.sampleData")}>
          {accounts.length ? t("sec.mockSignedIn") : t("sec.mockSignedOut")}
          {posture.note && accounts.length ? <span className={s.dim}> ({posture.note})</span> : null}
        </Notice>
      ) : null}
      {posture?.gaps.length ? (
        <Notice tone="danger" title={t("sec.gapsTitle")}>
          {posture.gaps.map((g) => t(`sec.section.${g.section}`)).join(", ")}
        </Notice>
      ) : null}
    </>
  );
}

/** True when this section failed to load (show "not collected", never "none"). */
export function useGap(section: PostureSection): boolean {
  const { posture } = useSecurity();
  return !!posture?.gaps.some((g) => g.section === section);
}

/* ── Findings table: one row per recommendation, expandable ── */

export function FindingsTable({ recommendations, showDomain = true }: { recommendations: PostureRecommendation[]; showDomain?: boolean }) {
  const { t } = useI18n();
  const label = useLabel();
  const [sev, setSev] = useState<PostureSeverity | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recommendations.filter(
      (r) =>
        (sev === "all" || r.severity === sev) &&
        (!q || r.title.toLowerCase().includes(q) || r.samples.some((x) => x.name.toLowerCase().includes(q) || x.resourceGroup.toLowerCase().includes(q))),
    );
  }, [recommendations, sev, query]);

  const count = (v: PostureSeverity) => recommendations.filter((r) => r.severity === v).length;
  return (
    <div className={s.findings}>
      <div className={s.filters}>
        <Segmented
          label={t("sec.filterSeverity")}
          value={sev}
          onChange={setSev}
          items={[
            { id: "all", label: `${t("common.all")} ${recommendations.length}` },
            { id: "High", label: `${t("sec.sev.High")} ${count("High")}` },
            { id: "Medium", label: `${t("sec.sev.Medium")} ${count("Medium")}` },
            { id: "Low", label: `${t("sec.sev.Low")} ${count("Low")}` },
          ]}
        />
        <SearchInput label={t("common.search")} value={query} onChange={setQuery} placeholder={t("sec.searchFindings")} />
      </div>

      {rows.length === 0 ? (
        <div className={s.emptyRow}>{t("sec.noFindings")}</div>
      ) : (
        <ul className={s.rows}>
          {rows.map((r) => {
            const expanded = open === r.key;
            const panelId = `rec-${r.key}`;
            const total = r.unhealthy + r.healthy;
            return (
              <li key={r.key} className={s.row} data-open={expanded || undefined}>
                <button type="button" className={s.rowHead} aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : r.key)}>
                  <span className={s.rowSev}><SeverityBadge severity={r.severity} /></span>
                  <span className={s.rowTitle}>{r.title}</span>
                  <span className={s.rowMeta}>
                    {showDomain ? <span className={s.chip}>{label("sec.domain", r.domain)}</span> : null}
                    {r.threats.slice(0, 2).map((th) => <span key={th} className={s.chipThreat}>{label("sec.threat", th)}</span>)}
                  </span>
                  <span className={s.rowCount} title={t("sec.col.affected")}>{t("sec.unhealthyOf", { u: r.unhealthy, t: total })}</span>
                </button>
                {expanded ? (
                  <div id={panelId} className={s.rowBody}>
                    {r.description ? <Detail title={t("sec.description")}>{r.description}</Detail> : null}
                    {r.remediation ? <Detail title={t("sec.remediation")}><span className={s.pre}>{r.remediation}</span></Detail> : null}
                    {r.userImpact || r.implementationEffort ? (
                      <div className={s.facts}>
                        {r.userImpact ? <span>{t("sec.userImpact")}: <b>{r.userImpact}</b></span> : null}
                        {r.implementationEffort ? <span>{t("sec.effort")}: <b>{r.implementationEffort}</b></span> : null}
                      </div>
                    ) : null}
                    {r.samples.length ? (
                      <Detail title={t("sec.samples")}>
                        <ul className={s.samples}>
                          {r.samples.map((x, i) => (
                            <li key={`${x.name}-${i}`}>
                              <span className={s.sampleName}>{x.type === "subscription" ? t("sec.subscriptionScope") : x.name}</span>
                              <span className={s.dim}>{x.type}{x.resourceGroup ? ` · ${x.resourceGroup}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      </Detail>
                    ) : null}
                    <a className={s.portal} href={r.portalUrl} target="_blank" rel="noopener noreferrer">{t("sec.portal")} ↗</a>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={s.detail}>
      <div className={s.detailTitle}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

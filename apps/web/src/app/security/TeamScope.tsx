"use client";

// 보안 개요 팀 범위 (security-roadmap 5.7 ⑤): the scope picker and the per-team summary. Counts come from
// /api/security/team-scope (per resource group, exact) and are split by the owner rules with the issue list's `teamOf`
// (lib/teamScope.ts). The chosen team is the issue list's (`aud.issues.team`, this browser) — one choice for both.

import { useEffect, useMemo, useState } from "react";
import type { PostureRecommendation, SecurityTeamScopeResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { ALL, NO_GROUP, NO_TEAM, teamScopeView, type ScopeBucket, type TeamScopeView } from "@/lib/teamScope";
import { CodeBlock, ErrorNotice, LinkButton, LoadingState, Panel, Select } from "@/components/ui";
import s from "./security.module.css";

const TEAM_KEY = "aud.issues.team";

export function useTeamScope(subscriptionId: string, enabled: boolean, recs: PostureRecommendation[]) {
  const q = useApiQuery(enabled && subscriptionId ? `team-scope:${subscriptionId}` : null, (token) =>
    fetchJsonWithBearer<SecurityTeamScopeResponse>(apiUrl("/api/security/team-scope", { subscriptionId }), token));
  const view = useMemo(() => (q.data ? teamScopeView(q.data, recs) : null), [q.data, recs]);
  const [scope, setScope] = useState<string>(ALL);
  useEffect(() => { try { const v = localStorage.getItem(TEAM_KEY); if (v) setScope(v); } catch { /* storage blocked */ } }, []);
  const pick = (v: string) => {
    setScope(v);
    // "no group" means nothing on the issue list — not shared
    if (v !== NO_GROUP) try { localStorage.setItem(TEAM_KEY, v); } catch { /* storage blocked */ }
  };
  const bucket: ScopeBucket | null = view && scope !== ALL ? view.buckets.find((x) => x.id === scope) ?? null : null;
  return { q, data: q.data, view, scope: bucket ? scope : ALL, pick, bucket, rules: q.data?.owners ?? [] };
}
export type TeamScopeState = ReturnType<typeof useTeamScope>;

/** The scope picker + what the chosen scope covers — the same on every /security page that splits by team */
export function TeamScopeBar({ team, note }: { team: TeamScopeState; note?: string }) {
  const { t } = useI18n();
  if (!team.view && !team.q.error) return null;
  return (
    <div className={s.scopeBar}>
      {team.q.error ? <span className={s.dim}>{t("sec.team.unread")}</span> : <ScopePicker view={team.view} scope={team.scope} pick={team.pick} />}
      {team.bucket ? <span className={s.dim}>{t("sec.team.scopeHint", { name: bucketName(t, team.bucket.id), g: team.bucket.groups.length })}{note ? ` · ${note}` : ""}</span> : null}
    </div>
  );
}

export function bucketName(t: (k: string, v?: Record<string, string | number>) => string, id: string): string {
  return id === ALL ? t("sec.team.all") : id === NO_TEAM ? t("sec.team.unowned") : id === NO_GROUP ? t("sec.team.noGroup") : id;
}

export function ScopePicker({ view, scope, pick }: { view: TeamScopeView | null; scope: string; pick: (v: string) => void }) {
  const { t } = useI18n();
  if (!view) return null;
  const options = [ALL, ...view.buckets.map((b) => b.id)].map((id) => ({ value: id, label: bucketName(t, id) }));
  return <Select label={t("sec.team.scope")} value={scope} onChange={pick} options={options} />;
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());

/** One row per team (rule order), unowned, no group — and the subscription total they add up to */
export function TeamSummaryPanel({ q, view, data, scope, pick }: {
  q: { error: string | null; loading: boolean }; view: TeamScopeView | null; data: SecurityTeamScopeResponse | undefined; scope: string; pick: (v: string) => void;
}) {
  const { t } = useI18n();
  if (q.error) return <Panel title={t("sec.team.title")}><ErrorNotice error={q.error} /></Panel>;
  if (!view || !data) return <Panel title={t("sec.team.title")}><LoadingState /></Panel>;
  const row = (b: ScopeBucket) => {
    const none = b.kind === "team" && !b.rgRules; // namespace rules only: no Azure resources are this team's here
    const cell = (v: number | null | undefined) => (none ? "—" : n(v));
    return (
      <tr key={b.id} className={b.id === scope ? s.teamRowOn : undefined}>
        <th scope="row">
          {b.kind === "all" ? t("sec.team.all") : <LinkButton onClick={() => pick(b.id === scope ? ALL : b.id)}>{bucketName(t, b.id)}</LinkButton>}
          {none ? <span className={s.dim}> · {t("sec.team.nsOnly")}</span> : null}
        </th>
        <td className={s.num}>{none ? "—" : b.groups.length}</td>
        <td className={s.num}>{cell(b.resources)}</td>
        <td className={s.num}>{cell(b.affected?.High)}</td>
        <td className={s.num}>{cell(b.affected?.Medium)}</td>
        <td className={s.num}>{cell(b.affected?.Low)}</td>
        <td className={s.num}>{cell(b.findings?.total)}</td>
        <td className={s.num}>{cell(b.alerts?.total)}</td>
      </tr>
    );
  };
  const example = JSON.stringify({ owners: [{ team: "payments", resourceGroups: ["rg-payments-*"] }, { team: "platform", namespaces: ["kube-system"], resourceGroups: ["rg-aks-*"] }] }, null, 2);
  return (
    <Panel title={t("sec.team.title")} sub={t("sec.team.sub")}
      footer={<span className={s.dim}>{t("sec.team.foot", { shared: view.alertsShared })}</span>}>
      {data.gaps.length ? <p className={s.dim}>{t("sec.team.gaps", { s: data.gaps.map((g) => g.section).join(", ") })}</p> : null}
      <div className={s.teamTableWrap}>
        <table className={s.teamTable}>
          <thead>
            <tr>
              <th scope="col">{t("sec.team.col.team")}</th><th scope="col">{t("sec.team.col.groups")}</th><th scope="col">{t("sec.team.col.resources")}</th>
              <th scope="col">{t("sec.team.col.high")}</th><th scope="col">{t("sec.team.col.medium")}</th><th scope="col">{t("sec.team.col.low")}</th>
              <th scope="col">{t("sec.team.col.findings")}</th><th scope="col">{t("sec.team.col.alerts")}</th>
            </tr>
          </thead>
          <tbody>{view.buckets.map(row)}</tbody>
          <tfoot>{row(view.total)}</tfoot>
        </table>
      </div>
      {view.rgRuleCount === 0 ? (
        <>
          <p className={s.dim}>{data.owners.length ? t("sec.team.noRgRules", { n: data.owners.length }) : t("sec.team.noRules")}</p>
          <CodeBlock code={example} label={t("sec.team.exampleLabel")} copyLabel={t("sec.team.copy")} copiedLabel={t("sec.team.copied")} />
        </>
      ) : null}
    </Panel>
  );
}

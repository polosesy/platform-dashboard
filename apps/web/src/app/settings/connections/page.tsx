"use client";

import { useState } from "react";
import type { ConnectionCheckResponse, ConnectionFeature, ConnectionCheckStatus, FeatureStatus } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useMe } from "@/lib/useMe";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, Panel, type BadgeTone } from "@/components/ui";
import s from "./styles.module.css";

const FEATURES: ConnectionFeature[] = ["inventory", "metrics", "logs", "security", "cost", "aksCredential", "flowLogBlobs", "prometheus"];
const STATUS_TONE: Record<ConnectionCheckStatus, BadgeTone> = { ok: "success", warning: "medium", failed: "high" };
const FEATURE_TONE: Record<FeatureStatus, BadgeTone> = { ok: "success", missing: "high", unknown: "neutral" };

/**
 * Azure connections — how the platform reads each customer's Azure (the platform identity, Lighthouse, a customer
 * service principal, or user-delegated OBO). Everyone sees the connections their role reaches; admins can run the
 * read-only connection check (token, visible subscriptions, permission matrix, over-privilege, workspaces).
 */
export default function ConnectionsPage() {
  const { t, locale } = useI18n();
  const me = useMe();
  const getApiToken = useApiToken();
  const [checks, setChecks] = useState<Record<string, ConnectionCheckResponse>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = me.data?.role === "admin";
  const connections = me.data?.connections ?? [];

  const runCheck = async (key: string) => {
    setRunning(key);
    setError(null);
    try {
      const token = await getApiToken();
      const r = await fetchJsonWithBearer<ConnectionCheckResponse>(apiUrl(`/api/azure/connections/${encodeURIComponent(key)}/check`), token);
      setChecks((prev) => ({ ...prev, [key]: r }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(locale)) : t("conn.never"));

  return (
    <div className={s.page}>
      <PageHeader />
      <Notice tone="info">{t("conn.intro")}</Notice>
      <ErrorNotice error={me.error ?? error} />
      {me.loading && !me.data ? (
        <LoadingState />
      ) : me.data?.anonymous ? (
        <Notice tone="info">{t("auth.state.signin")}</Notice>
      ) : (
        <Panel title={t("conn.title")} sub={String(connections.length)} actions={isAdmin ? undefined : <span className={s.hint}>{t("conn.adminOnly")}</span>}>
          {connections.length === 0 ? (
            <EmptyState title={t("conn.empty")} />
          ) : (
            <div className={s.list}>
              {connections.map((c) => {
                const check = checks[c.key];
                const last = check ? { at: check.generatedAt, status: check.status } : c.lastCheck;
                return (
                  <article key={c.key} className={s.card}>
                    <header className={s.cardHead}>
                      <div className={s.cardTitle}>
                        <strong>{c.displayName}</strong>
                        <code className={s.key}>{c.key}</code>
                      </div>
                      <Badge tone="info">{t(`conn.mode.${c.mode}`)}</Badge>
                      <span className={s.meta}>{t("conn.col.subs")} {c.subscriptionCount}</span>
                      <span className={s.meta}>{t("conn.col.workspaces")} {c.workspaceCount}</span>
                      <span className={s.meta}>
                        {t("conn.col.lastCheck")} {when(last?.at)}{" "}
                        {last ? <Badge tone={STATUS_TONE[last.status]}>{t(`conn.status.${last.status}`)}</Badge> : null}
                      </span>
                      {isAdmin ? (
                        <Button size="sm" onClick={() => void runCheck(c.key)} disabled={running !== null}>
                          {running === c.key ? t("conn.checking") : t("conn.check")}
                        </Button>
                      ) : null}
                    </header>
                    {check ? <CheckResult check={check} /> : null}
                  </article>
                );
              })}
            </div>
          )}
        </Panel>
      )}
      <p className={s.docs}>{t("conn.docs")}</p>
    </div>
  );
}

function CheckResult({ check }: { check: ConnectionCheckResponse }) {
  const { t } = useI18n();
  if (!check.token.ok) return <Notice tone="danger">{t("conn.token.failed", { code: check.token.code ?? "-" })}</Notice>;
  const warnings = [...new Set(check.subscriptions.flatMap((x) => x.warnings))];
  return (
    <div className={s.result}>
      <div className={s.line}>
        <Badge tone="success">{t("conn.token.ok")}</Badge>
        <span>{check.visible ? t("conn.visible", { ...check.visible }) : t("conn.visibleUnknown")}</span>
      </div>
      {warnings.length ? (
        <Notice tone="warning" title={t("conn.warnTitle")}>
          <ul className={s.warnList}>{warnings.map((w) => <li key={w}>{t(`conn.warn.${w}`)}</li>)}</ul>
        </Notice>
      ) : null}
      {check.subscriptions.length ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{t("conn.col.subs")}</th>
                {FEATURES.map((f) => <th key={f}>{t(`conn.feature.${f}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {check.subscriptions.map((sub) => (
                <tr key={sub.label}>
                  <td className={s.subCell}>
                    {sub.label}
                    {!sub.reachable ? <span className={s.err}>{t("conn.unreachable", { error: sub.error ?? "-" })}</span> : null}
                  </td>
                  {FEATURES.map((f) => (
                    <td key={f}>
                      <Badge tone={FEATURE_TONE[sub.features[f]]} title={sub.features[f] === "unknown" ? t("conn.fs.unknownHint") : undefined}>
                        {t(`conn.fs.${sub.features[f]}`)}
                      </Badge>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {check.workspaces.map((w) => (
        <div key={w.label} className={s.line}>
          <span>{t("conn.workspace", { label: w.label })}</span>
          <Badge tone={w.ok ? "success" : "high"}>{w.ok ? t("conn.ws.ok") : t("conn.ws.failed", { code: w.code ?? "-" })}</Badge>
        </div>
      ))}
    </div>
  );
}

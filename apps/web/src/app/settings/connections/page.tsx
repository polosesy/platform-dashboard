"use client";

import { useMemo, useState } from "react";
import type { ClusterCheckResponse, ConnectionCheckResponse, ConnectionCheckStatus, ConnectionFeature, FeatureCatalogResponse, FeatureStatus, PermissionCell, PermissionKey } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useMe } from "@/lib/useMe";
import { dateLocale, useI18n } from "@/lib/i18n";
import { CELL_TONE, READY_TONE, cellText, featuresOf, permOf, rollupFeature, tierOrder, useFeatureCatalog } from "@/lib/featureCatalog";
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, Panel, Select, type BadgeTone } from "@/components/ui";
import { PermissionTable } from "../PermissionTable";
import s from "./styles.module.css";
import ss from "../settings.module.css";

const SUB_FEATURES: ConnectionFeature[] = ["inventory", "metrics", "logs", "security", "cost", "aksCredential", "flowLogBlobs", "prometheus"];
const STATUS_TONE: Record<ConnectionCheckStatus, BadgeTone> = { ok: "success", warning: "medium", failed: "high" };
const FEATURE_TONE: Record<FeatureStatus, BadgeTone> = { ok: "success", missing: "high", unknown: "neutral" };

/**
 * Azure connections — how the platform reads each customer's Azure (the platform identity, Lighthouse, a customer
 * service principal, or user-delegated OBO). Everyone sees the connections their role reaches; admins can run the
 * read-only check: token, visible subscriptions, each feature's readiness (subscription and sampled resource scope,
 * then one cluster's Kubernetes permissions on demand), over-privilege, workspaces. Packages and the full permission
 * list: /settings/features.
 */
export default function ConnectionsPage() {
  const { t, locale } = useI18n();
  const me = useMe();
  const getApiToken = useApiToken();
  const catalog = useFeatureCatalog();
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
                    <dl className={s.tenantRow}>
                      <dt>{t("conn.tenant")}</dt>
                      <dd>{c.tenantName ?? <span className={s.meta}>{t("conn.tenantNameUnset")}</span>}</dd>
                      <dt>{t("conn.tenantId")}</dt>
                      <dd>
                        {c.tenantId ? (
                          <>
                            <code className={s.key}>{c.tenantId}</code> <CopyId value={c.tenantId} />
                          </>
                        ) : (
                          <span title={t("conn.tenantIdMasked")}><code className={s.key}>…{c.tenantIdTail}</code></span>
                        )}
                      </dd>
                    </dl>
                    {check ? <CheckResult check={check} connKey={c.key} cat={catalog.data ?? null} /> : null}
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

/** Copies the full directory id (admins only see it) */
function CopyId({ value }: { value: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined);
  };
  return <Button size="sm" variant="ghost" onClick={copy} ariaLabel={t("conn.copyTenantId")} title={t("conn.copyTenantId")}>{done ? t("conn.copied") : "⧉"}</Button>;
}

function CheckResult({ check, connKey, cat }: { check: ConnectionCheckResponse; connKey: string; cat: FeatureCatalogResponse | null }) {
  const { t } = useI18n();
  const [cluster, setCluster] = useState<ClusterCheckResponse | null>(null);
  // The Kubernetes cells come from a cluster check, when one has run
  const cells = useMemo<Partial<Record<PermissionKey, PermissionCell>>>(() => ({ ...(check.permissions ?? {}), ...(cluster?.permissions ?? {}) }), [check.permissions, cluster]);
  if (!check.token.ok) return <Notice tone="danger">{t("conn.token.failed", { code: check.token.code ?? "-" })}</Notice>;
  const warnings = [...new Set([...check.subscriptions.flatMap((x) => x.warnings), ...(check.resourceWarnings ?? [])])];
  const ws = check.workspaceSummary ?? { n: check.workspaces.length, ok: check.workspaces.filter((w) => w.ok).length, failed: check.workspaces.filter((w) => !w.ok).length };
  const resourceKeys = SUB_FEATURES.filter((f) => cat && permOf(cat, f)?.scope.kind === "resource");
  return (
    <div className={s.result}>
      <div className={s.line}>
        <Badge tone="success">{t("conn.token.ok")}</Badge>
        <span>{check.visible ? t("conn.visible", { ...check.visible }) : t("conn.visibleUnknown")}</span>
        <span className={s.meta}>{t("conn.ws.summary", { n: ws.n, ok: ws.ok, failed: ws.failed })}</span>
      </div>
      {warnings.length ? (
        <Notice tone="warning" title={t("conn.warnTitle")}>
          <ul className={s.warnList}>{warnings.map((w) => <li key={w}>{t(`conn.warn.${w}`)}</li>)}</ul>
        </Notice>
      ) : null}

      {/* Each feature: ready / limited / not available, and the permissions behind it */}
      {cat && check.permissions ? (
        <section className={s.section} aria-label={t("conn.ready.title")}>
          <h3 className={s.sectionTitle}>{t("conn.ready.title")}</h3>
          <p className={ss.muted}>{t("conn.ready.hint")}</p>
          {tierOrder(cat).map((tier) => (
            <div key={tier} className={ss.tierBlock}>
              <h4 className={ss.tierBlockTitle} data-tier={tier}>{t(`tier.${tier}.name`)}</h4>
              {featuresOf(cat, tier).map((f) => {
                const r = rollupFeature(f, cells);
                const reason = r.missingRequired.length ? t("conn.reason.missingRequired", { list: r.missingRequired.map((k) => permOf(cat, k)?.role ?? k).join(", ") })
                  : r.unknown.length ? t("conn.reason.unknown", { list: r.unknown.map((k) => permOf(cat, k)?.role ?? k).join(", ") })
                  : r.missingOptional.length ? t("conn.reason.missingOptional", { list: r.missingOptional.map((k) => permOf(cat, k)?.role ?? k).join(", ") })
                  : null;
                return (
                  <details key={f.id} className={ss.feature}>
                    <summary className={ss.featureHead}>
                      <span className={ss.featureName}>{t(`feat.${f.id}.name`)}</span>
                      <Badge tone={READY_TONE[r.readiness]}>{t(`conn.ready.${r.readiness}`)}</Badge>
                      {reason ? <span className={ss.reason}>{reason}</span> : null}
                    </summary>
                    <PermissionTable cat={cat} feature={f} cells={cells} />
                  </details>
                );
              })}
            </div>
          ))}
        </section>
      ) : null}

      {check.clusters?.length ? <ClusterCheck connKey={connKey} clusters={check.clusters} result={cluster} onResult={setCluster} /> : null}

      {/* The old view: every subscription × the subscription-scope check, plus the connection's resource samples */}
      {check.subscriptions.length ? (
        <details className={s.more}>
          <summary>{t("conn.matrix.title")}</summary>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>{t("conn.col.subs")}</th>
                  {SUB_FEATURES.map((f) => <th key={f}>{t(`conn.feature.${f}`)}</th>)}
                </tr>
              </thead>
              <tbody>
                {check.subscriptions.map((sub) => (
                  <tr key={sub.label}>
                    <td className={s.subCell}>
                      {sub.label}
                      {!sub.reachable ? <span className={s.err}>{t("conn.unreachable", { error: sub.error ?? "-" })}</span> : null}
                    </td>
                    {SUB_FEATURES.map((f) => (
                      <td key={f}>
                        <Badge tone={FEATURE_TONE[sub.features[f]]} title={sub.features[f] === "unknown" ? t("conn.fs.unknownHint") : undefined}>
                          {t(`conn.fs.${sub.features[f]}`)}
                        </Badge>
                      </td>
                    ))}
                  </tr>
                ))}
                {check.permissions ? (
                  <tr className={s.sampleRow}>
                    <td className={s.subCell}>{t("conn.matrix.samples")}</td>
                    {SUB_FEATURES.map((f) => {
                      if (!resourceKeys.includes(f)) return <td key={f} />;
                      const c = check.permissions![f];
                      const ct = cellText(c);
                      return <td key={f}><Badge tone={c ? CELL_TONE[c.status] : "neutral"}>{t(ct.key, ct.vars)}</Badge></td>;
                    })}
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {ws.n ? (
        <details className={s.more}>
          <summary>{t("conn.ws.summary", { n: ws.n, ok: ws.ok, failed: ws.failed })}</summary>
          {[...check.workspaces].sort((a, b) => Number(a.ok) - Number(b.ok)).map((w) => (
            <div key={w.label} className={s.line}>
              <span>{t("conn.workspace", { label: w.label })}</span>
              <Badge tone={w.ok ? "success" : "high"}>{w.ok ? t("conn.ws.ok") : t("conn.ws.failed", { code: w.code ?? "-" })}</Badge>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

/** One cluster's in-cluster permissions (SelfSubjectAccessReview — nothing is stored in the cluster) */
function ClusterCheck({ connKey, clusters, result, onResult }: {
  connKey: string;
  clusters: Array<{ id: string; name: string }>;
  result: ClusterCheckResponse | null;
  onResult: (r: ClusterCheckResponse | null) => void;
}) {
  const { t } = useI18n();
  const getApiToken = useApiToken();
  const [picked, setPicked] = useState(clusters[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getApiToken();
      onResult(await fetchJsonWithBearer<ClusterCheckResponse>(apiUrl(`/api/azure/connections/${encodeURIComponent(connKey)}/cluster-check`, { resourceId: picked }), token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const k8sKeys = ["k8sRead", "k8sPodLogs", "hubbleExec"] as const;
  return (
    <section className={s.section} aria-label={t("conn.cluster.title")}>
      <h3 className={s.sectionTitle}>{t("conn.cluster.title")}</h3>
      <div className={s.line}>
        <Select label={t("conn.cluster.pick")} value={picked} onChange={setPicked} options={clusters.map((c) => ({ value: c.id, label: c.name }))} />
        <Button size="sm" onClick={() => void run()} disabled={busy || !picked}>{busy ? t("conn.checking") : t("conn.cluster.run")}</Button>
        <span className={ss.muted}>{t("conn.cluster.ssarNote")}</span>
      </div>
      <ErrorNotice error={error} />
      {result ? (
        <div className={s.result}>
          <div className={s.line}>
            <span className={s.meta}>{result.cluster}</span>
            <Badge tone={result.access === "entra" || result.access === "localAccount" ? "success" : "high"}>{t(`conn.cluster.access.${result.access}`)}</Badge>
            {result.code && result.access !== "entra" && result.access !== "localAccount" ? <code className={s.key}>{result.code}</code> : null}
          </div>
          {Object.keys(result.permissions).length ? (
            <div className={s.line}>
              {k8sKeys.map((k) => {
                const c = result.permissions[k];
                if (!c) return null;
                const ct = cellText(c);
                return <span key={k} className={s.k8sCell}>{t(`conn.cluster.perm.${k}`)} <Badge tone={CELL_TONE[c.status]}>{t(ct.key, ct.vars)}</Badge></span>;
              })}
            </div>
          ) : null}
          {result.missingRules.length ? <p className={ss.muted}>{t("conn.cluster.missingRules", { list: result.missingRules.join(", ") })}</p> : null}
          {result.warnings.length ? (
            <Notice tone="warning" title={t("conn.warnTitle")}>
              <ul className={s.warnList}>{result.warnings.map((w) => <li key={w}>{t(`conn.warn.${w}`)}</li>)}</ul>
            </Notice>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

"use client";

import type { FeatureCatalogResponse, PlanTierId } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { NAV_GROUPS } from "@/lib/navConfig";
import { featuresOf, permOf, scopeText, tierOrder, useFeatureCatalog } from "@/lib/featureCatalog";
import { ErrorNotice, LoadingState, Notice, PageHeader, Panel } from "@/components/ui";
import { CopyCommand, PermissionTable } from "../PermissionTable";
import s from "../settings.module.css";

const NAV_LABEL = new Map(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.href, i.labelKey] as const)));

/**
 * Features & permissions — what each package (a proposal, not a price list) adds, and the minimum read permission
 * every feature needs (Azure RBAC on the subscription or the resource, Kubernetes RBAC in the cluster). Static and
 * shareable: no tenant data. The live check per connection is on /settings/connections.
 */
export default function FeaturesPage() {
  const { t } = useI18n();
  const q = useFeatureCatalog();
  const cat = q.data;
  return (
    <div className={s.page}>
      <PageHeader />
      <Notice tone="info">{t("feat.notice")}</Notice>
      <ErrorNotice error={q.error} />
      {!cat ? <LoadingState /> : <Catalog cat={cat} />}
    </div>
  );
}

function Catalog({ cat }: { cat: FeatureCatalogResponse }) {
  const { t } = useI18n();
  const order = tierOrder(cat);
  const roles = (tier: PlanTierId) => [...new Set(featuresOf(cat, tier).flatMap((f) => f.requires).map((k) => permOf(cat, k)?.role).filter((r): r is string => !!r))];
  return (
    <>
      {/* Packages side by side: each one adds features to the one before */}
      <div className={s.tiers}>
        {order.map((tier, i) => (
          <section key={tier} className={s.tier} data-tier={tier} aria-labelledby={`tier-h-${tier}`}>
            <h2 id={`tier-h-${tier}`} className={s.tierName}>{t(`tier.${tier}.name`)}</h2>
            <p className={s.tagline}>{t(`tier.${tier}.tagline`)}</p>
            <a className={s.tierLink} href={`#tier-${tier}`}>{t("tier.seePermissions")}</a>
            <p className={s.includes}>{i === 0 ? t("tier.base") : t("tier.includes", { tier: t(`tier.${order[i - 1]}.name`) })}</p>
            <ul className={s.featureList}>
              {featuresOf(cat, tier).map((f) => (
                <li key={f.id}>
                  <span className={s.check} aria-hidden="true">✓</span>
                  <span><strong>{t(`feat.${f.id}.name`)}:</strong> {t(`feat.${f.id}.desc`)}</span>
                </li>
              ))}
            </ul>
            <div className={s.tierRoles}>
              <span className={s.tierRolesTitle}>{t("tier.newRoles")}</span>
              {roles(tier).map((r) => <span key={r} className={s.roleTag}>{r}</span>)}
            </div>
          </section>
        ))}
      </div>

      {/* Every feature: where it is, what it needs, what is lost without the optional parts */}
      <Panel title={t("feat.byFeature")}>
        {order.map((tier) => (
          <div key={tier} id={`tier-${tier}`} className={s.tierBlock}>
            <h3 className={s.tierBlockTitle} data-tier={tier}>{t(`tier.${tier}.name`)}</h3>
            {featuresOf(cat, tier).map((f) => (
              <details key={f.id} className={s.feature} open={f.id === "aksSecurityCheck"}>
                <summary className={s.featureHead}>
                  <span className={s.featureName}>{t(`feat.${f.id}.name`)}</span>
                  <span className={s.screens}>{f.routes.map((r) => t(NAV_LABEL.get(r) ?? r)).filter((x, k, a) => a.indexOf(x) === k).join(" · ")}</span>
                  {f.preconditions?.length ? <span className={s.pre}>{t("feat.preconditions")}: {f.preconditions.map((p) => t(`feat.pre.${p}`)).join(" · ")}</span> : null}
                </summary>
                <PermissionTable cat={cat} feature={f} />
                {f.platformRole ? <p className={s.muted}>{t("feat.platformRole", { role: t(`auth.role.${f.platformRole}`) })}</p> : null}
              </details>
            ))}
          </div>
        ))}
      </Panel>

      {/* All permissions once: role, where, the built-in role id, the grant command */}
      <Panel title={t("feat.allPermissions")} sub={String(cat.permissions.length)}>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{t("feat.col.role")}</th>
                <th>{t("feat.col.scope")}</th>
                <th>{t("feat.col.why")}</th>
                <th>{t("feat.col.roleId")}</th>
                <th aria-label={t("feat.copyGrant")} />
              </tr>
            </thead>
            <tbody>
              {cat.permissions.map((p) => {
                const sc = scopeText(p);
                return (
                  <tr key={p.key}>
                    <td className={s.role}>{p.role}{p.gate ? <span className={s.sample}>{t(`feat.gate.${p.gate}`)}</span> : null}</td>
                    <td>{t(sc.key, sc.vars)}</td>
                    <td className={s.why}>{t(`perm.${p.key}.why`)}</td>
                    <td><code className={s.code}>{p.roleDefinitionId ?? (p.scope.kind === "kubernetes" ? p.scope.manifest : "-")}</code></td>
                    <td><CopyCommand text={p.grant} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={s.muted}>{t("feat.grantNote")}</p>
      </Panel>
    </>
  );
}

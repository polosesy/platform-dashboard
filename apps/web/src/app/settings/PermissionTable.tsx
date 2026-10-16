"use client";

import { useState } from "react";
import type { FeatureCatalogResponse, FeatureDef, PermissionCell, PermissionKey } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { CELL_TONE, cellText, permOf, scopeText } from "@/lib/featureCatalog";
import { Badge } from "@/components/ui";
import s from "./settings.module.css";

/** Copies a grant command (placeholders) — the dashboard never runs it */
export function CopyCommand({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={s.copy}
      title={`${text}\n\n${t("feat.grantNote")}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined);
      }}
    >
      {done ? t("feat.copied") : t("feat.copyGrant")}
    </button>
  );
}

/**
 * One feature's permissions: required, then optional — role, where it is granted, why / what is lost without it,
 * and (on the connections page) this connection's result. Role names are proper nouns from the catalog.
 */
export function PermissionTable({ cat, feature, cells }: { cat: FeatureCatalogResponse; feature: FeatureDef; cells?: Partial<Record<PermissionKey, PermissionCell>> }) {
  const { t } = useI18n();
  const rows = [...feature.requires.map((k) => ({ k, need: "required" as const })), ...feature.optional.map((k) => ({ k, need: "optional" as const }))];
  if (!rows.length) return <p className={s.muted}>{t("feat.noPermission")}</p>;
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th>{t("feat.col.need")}</th>
            <th>{t("feat.col.role")}</th>
            <th>{t("feat.col.scope")}</th>
            <th>{t("feat.col.why")}</th>
            {cells ? <th>{t("feat.col.result")}</th> : null}
            <th aria-label={t("feat.copyGrant")} />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ k, need }) => {
            const p = permOf(cat, k);
            if (!p) return null;
            const sc = scopeText(p);
            const c = cells?.[k];
            const ct = cellText(c);
            return (
              <tr key={`${need}:${k}`}>
                <td><Badge tone={need === "required" ? "info" : "neutral"}>{t(`feat.need.${need}`)}</Badge></td>
                <td className={s.role}>{p.role}</td>
                <td>{t(sc.key, sc.vars)}</td>
                <td className={s.why}>
                  {t(`perm.${k}.why`)}
                  {need === "optional" ? <span className={s.without}>{t(`feat.${feature.id}.without.${k}`)}</span> : null}
                </td>
                {cells ? (
                  <td>
                    <Badge tone={c ? CELL_TONE[c.status] : "neutral"}>{t(ct.key, ct.vars)}</Badge>
                    {c?.sampled && c.status !== "partial" && c.sampled.checked < c.sampled.total ? <span className={s.sample}>{t("conn.ps.sampled", { checked: c.sampled.checked, total: c.sampled.total })}</span> : null}
                  </td>
                ) : null}
                <td><CopyCommand text={p.grant} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

// 보안 › 이슈·통합 위험 › Azure 공격 경로 (API /api/security/azure-risk `paths`, security-roadmap 5.3 ③): from the
// Internet through an exposed entry, its High findings, its managed identity's privileged and data roles, to the data
// stores inside each role's scope — only links with evidence, and where the chain stops is said (no inferred hops).

import { useState } from "react";
import type { AzureAttackPath, AzureRiskResponse } from "@aud/types";
import { ResourceSecurityCard } from "@/components/ResourceSecurityCard";
import { Badge, Chip, EmptyState, LinkButton, Panel } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { comboAnchor } from "./AzureRiskPanel";
import s from "./risk.module.css";

const SEV_TONE = { critical: "high", high: "high", medium: "medium" } as const;

export function AzurePathsPanel({ data }: { data: AzureRiskResponse | undefined }) {
  const { t } = useI18n();
  const [card, setCard] = useState<string | null>(null);
  if (!data) return null;
  const roleText = (r: AzureAttackPath["roles"][number]) =>
    `${r.kind === "privileged" ? t(`azr.role.${r.role}`) : t(`azp.data.${r.role}`, { rw: r.write ? t("azp.write") : t("azp.read") })}${r.viaKeys ? ` (${t("azp.viaKeys")})` : ""} @ ${t(`azr.scope.${r.scope}`)}${r.scopeName ? ` ${r.scopeName}` : ""}`;
  return (
    <Panel id="azure-paths" title={t("azp.title")} sub={t("azp.sub")} footer={<span className={s.dim}>{t("azp.foot")}</span>}>
      {!data.paths.length ? <EmptyState title={t("azp.none")}>{t("azp.noneHint")}</EmptyState> : (
        <ul className={s.azList}>
          {data.paths.map((p) => (
            <li key={p.key} id={`${comboAnchor(p.key)}-path`} className={s.azItem}>
              <div className={s.azHead}>
                <Badge tone={SEV_TONE[p.sev]}>{t(`iq.sev.${p.sev}`)}</Badge>
                <strong>{t(`azp.ends.${p.ends}`, { name: p.entry.name })}</strong>
                <LinkButton ariaExpanded={card === p.key} onClick={() => setCard(card === p.key ? null : p.key)}>{card === p.key ? t("rsc.close") : t("rsc.open")}</LinkButton>
              </div>
              {card === p.key ? <ResourceSecurityCard resourceId={p.entry.resourceId} /> : null}
              <ol className={s.azChain} aria-label={t("azp.chain")}>
                <li><Chip level="neutral" glyph={false}>{t("azp.internet")}</Chip></li>
                <li>
                  <Chip level="warn" title={p.entry.detail}>{p.entry.name}</Chip>
                  <span className={s.dim}>{p.entry.type} · {p.entry.limited ? t("azr.exposure.limited") : t("azr.exposure.any")}{p.entry.detail ? ` — ${p.entry.detail}` : ""}</span>
                </li>
                {p.vuln ? <li><Chip level="warn">{t("azp.vuln", { n: p.vuln.count })}</Chip><span className={s.dim}>{p.vuln.names.join(" · ")}</span></li> : null}
                {p.roles.map((r, i) => (
                  <li key={i}>
                    <Chip level={r.kind === "privileged" || r.write ? "danger" : "warn"}>{roleText(r)}</Chip>
                    <span className={s.dim}>
                      {r.reaches.length ? r.reaches.map((x) => `${t(`azp.jewel.${x.kind}`)} ${x.count}${x.names.length ? ` (${x.names.join(", ")}${x.count > x.names.length ? " …" : ""})` : ""}`).join(" · ") : t("azp.noJewel")}
                    </span>
                  </li>
                ))}
                {p.ends === "entry" ? (
                  <li><span className={s.dim}>{p.identityUnknown ? t("azp.stopUnknown") : p.identity.principals ? t("azp.stopRoles", { p: p.identity.principals, o: p.identity.otherRoles }) : t("azp.stopNoIdentity")}</span></li>
                ) : null}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

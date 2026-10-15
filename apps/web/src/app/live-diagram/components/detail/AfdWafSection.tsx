"use client";

import type { DiagramNodeSpec } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { maskGuids } from "@/lib/mask";
import { wafFacts, type WafPolicyInfo } from "@/lib/liveWaf";
import { FetchFailed } from "./kindSections";
import { Group, KV, Section } from "./primitives";
import styles from "../../styles.module.css";

/** The Front Door WAF verdict counts (NODE_BINDINGS.frontDoorAfd, one hour, the whole profile) — shown here only */
export const WAF_METRICS = new Set(["wafBlock", "wafLog", "wafTotal"]);

/**
 * Front Door WAF (catalog EDGE-10 / EDGE-11): which served domains a WAF policy blocks for, only detects for, or
 * leaves uncovered — configuration read from the security policies and the policies themselves. The hour's verdict
 * counts are for the whole profile (not per policy). Nothing here changes the card status.
 */
export function AfdWafSection({ node, metrics, measured }: { node: DiagramNodeSpec; metrics?: Record<string, number | null>; measured: boolean }) {
  const { t } = useI18n();
  const f = wafFacts(node.metadata);
  if (!f) return null;
  const c = f.counts;
  const warnDomains = f.domains.filter((d) => d.state === "detect" || d.state === "disabled" || d.state === "none");
  const unknownDomains = f.domains.filter((d) => d.state === "unknown");
  const num = (v: number | null | undefined) => (v == null ? null : Math.round(v).toLocaleString());
  const total = metrics?.wafTotal;
  const verdicts = total == null
    ? t(measured ? "ld.waf.noRecords" : "ld.unmeasured")
    : t("ld.waf.verdicts", {
      block: num(metrics?.wafBlock) ?? t("ld.waf.noBlock"),
      log: num(metrics?.wafLog) ?? "0",
      total: num(total)!,
    });

  const policyRows = (p: WafPolicyInfo) => {
    const standard = /^standard/i.test(p.sku ?? "");
    const prevention = p.mode?.toLowerCase() === "prevention";
    return (
      <Group key={p.name} title={maskGuids(p.name)}>
        <KV label={t("ld.waf.mode")}>
          <span data-tone={p.mode && !prevention ? "warn" : undefined} className={styles.wafValue}>
            {p.mode ? t(`ld.waf.mode.${p.mode.toLowerCase()}`) : t("ld.peering.unknownValue")}
          </span>
          {p.enabled === false ? <> · <span data-tone="warn" className={styles.wafValue}>{t("ld.waf.disabled")}</span></> : null}
          {p.sku ? ` · ${p.sku.replace(/_AzureFrontDoor$/, "")}` : ""}
        </KV>
        <KV label={t("ld.waf.managed")}>
          {p.managed?.length
            ? p.managed.map((m) => `${m.type} ${m.version}${m.action ? ` (${t(`ld.waf.action.${m.action.toLowerCase()}`)})` : ""}`).join(" · ")
            : standard ? t("ld.waf.customOnly") : p.managed ? t("ld.waf.noManaged") : <span className={styles.dpMuted}>{t("ld.waf.managedUnknown")}</span>}
        </KV>
        {prevention && p.managed?.some((m) => m.action?.toLowerCase() === "log") ? <div className={styles.dpMuted}>{t("ld.waf.logInPrevention")}</div> : null}
        <KV label={t("ld.waf.customRules")}>{p.customRules}</KV>
        {p.domains.length ? <KV label={t("ld.waf.domains")}>{p.domains.join(", ")}</KV> : null}
      </Group>
    );
  };

  return (
    <Section id="afd-waf" title={t("ld.waf.title")}>
      {f.state === "noDomains"
        ? <div className={styles.dpMuted}>{t("ld.waf.noDomains")}</div>
        : <div className={styles.dpMuted}>{t("ld.waf.summary", { m: c.served, prevent: c.prevent, detect: c.detect, disabled: c.disabled, none: c.none, unknown: c.unknown })}</div>}
      {f.readError === "securityPolicies" ? <FetchFailed what={t("ld.waf.securityPolicies")} /> : null}
      {f.readError === "wafPolicies" ? <FetchFailed what={t("ld.waf.policies")} /> : null}
      {warnDomains.length ? (
        <Group title={t("ld.waf.gaps", { n: warnDomains.length })}>
          {warnDomains.map((d) => (
            <KV key={d.host} label={d.host} mono>
              <span data-tone="warn" className={styles.wafValue}>{t(`ld.waf.domain.${d.state}`)}</span>{d.policy ? ` · ${maskGuids(d.policy)}` : ""}
            </KV>
          ))}
        </Group>
      ) : null}
      {unknownDomains.length ? (
        <Group title={t("ld.waf.unknownDomains", { n: unknownDomains.length })}>
          {unknownDomains.map((d) => (
            <KV key={d.host} label={d.host} mono>
              <span className={styles.dpMuted}>{t(`ld.waf.reason.${d.reason ?? "policyUnreadable"}`)}</span>
            </KV>
          ))}
        </Group>
      ) : null}
      {f.policies.map(policyRows)}
      <KV label={t("ld.waf.verdictsLabel")}>{verdicts}</KV>
      {f.unserved.length ? <div className={styles.dpMuted}>{t("ld.waf.unserved", { list: f.unserved.join(", ") })}</div> : null}
    </Section>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import type { DiagramNodeSpec } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { maskGuids } from "@/lib/mask";
import { policyPill, wafBadge, wafFacts, type WafDomainInfo, type WafFacts, type WafPolicyInfo, type WafTone } from "@/lib/liveWaf";
import { Badge, Button } from "@/components/ui";
import { FetchFailed } from "./kindSections";
import { CopyButton, Group, KV, Section, TwoLine } from "./primitives";
import { getAzureIconUrl } from "../../utils/azureIcons";
import styles from "../../styles.module.css";

/** The Front Door WAF verdict counts (NODE_BINDINGS.frontDoorAfd, one hour, the whole profile) — WAF panel only */
export const WAF_METRICS = new Set(["wafBlock", "wafLog", "wafTotal"]);

const STATE_TONE: Record<WafTone, string | undefined> = { public: "warning", muted: "unknown", neutral: undefined };
const BADGE_TONE: Record<WafTone, "neutral" | "medium" | "low"> = { neutral: "neutral", public: "medium", muted: "low" };
const POLICY_LIMIT = 5;

function Pill({ tone, children }: { tone: WafTone; children: ReactNode }) {
  return <span className={styles.dpState} data-state={STATE_TONE[tone]}>{children}</span>;
}

/** A long list shown `limit` rows at a time */
function Folded<T>({ items, limit, render }: { items: T[]; limit: number; render: (x: T) => ReactNode }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <>
      {shown.map(render)}
      {items.length > limit ? (
        <button type="button" className={styles.dpLink} onClick={() => setAll(!all)}>
          {all ? t("ld.waf.panel.showLess") : t("ld.waf.panel.showMore", { n: items.length - limit })}
        </button>
      ) : null}
    </>
  );
}

const unitsKey = (f: WafFacts) => (f.unit === "listener" ? "ld.waf.sub.listeners" : "ld.waf.sub.domains");

/**
 * WAF in the resource panel of a Front Door / Application Gateway: which policy, which mode — one row each — and the
 * units without a WAF / not judged. Everything else is in the WAF panel (the badge, a sub-card, or "WAF 상세 보기").
 */
export function WafSummarySection({ node, onWafSelect }: { node: DiagramNodeSpec; onWafSelect?: (nodeId: string, key: string | null) => void }) {
  const { t } = useI18n();
  const f = wafFacts(node.metadata);
  if (!f) return null;
  const open = (key: string | null) => () => onWafSelect?.(node.id, key);
  const policies = f.policies.slice(0, POLICY_LIMIT);
  return (
    <Section id="waf" title={t("ld.waf.title")} count={f.policies.length || undefined}>
      {f.readError === "securityPolicies" ? <FetchFailed what={t("ld.waf.securityPolicies")} /> : null}
      {f.readError === "wafPolicies" ? <FetchFailed what={t("ld.waf.policies")} /> : null}
      {f.state === "noDomains" ? <div className={styles.dpMuted}>{t(f.unit === "listener" ? "ld.waf.noListeners" : "ld.waf.noDomains")}</div> : null}
      {policies.map((p) => {
        const pp = policyPill(p);
        return (
          <TwoLine key={p.name} onClick={open(`p:${p.name}`)}
            main={<><Pill tone={pp.tone}>{t(pp.pill)}</Pill> · {maskGuids(p.name)}</>}
            sub={[t(unitsKey(f), { n: p.domains.length }), p.level && f.unit === "listener" ? t(`ld.waf.level.${p.level}`) : null].filter(Boolean).join(" · ")} />
        );
      })}
      {f.policies.length > POLICY_LIMIT ? <TwoLine onClick={open(null)} main={t("ld.waf.sub.moreTitle", { n: f.policies.length - POLICY_LIMIT })} /> : null}
      {f.counts.none > 0 ? (
        <TwoLine onClick={open("none")}
          main={<><Pill tone="public">{t("ld.waf.pill.noBlock")}</Pill> · {t("ld.waf.sub.none")}</>}
          sub={f.skuNoWaf ? t("ld.waf.agw.skuNoWaf") : [t(unitsKey(f), { n: f.counts.none }), endpointNone(f) ? t("ld.waf.sub.endpointNone", { n: endpointNone(f) }) : null].filter(Boolean).join(" · ")} />
      ) : null}
      {f.counts.unknown > 0 ? (
        <TwoLine onClick={open("unknown")} main={<><Pill tone="muted">{t("ld.waf.pill.unknown")}</Pill> · {t("ld.waf.sub.unknown")}</>} sub={t(unitsKey(f), { n: f.counts.unknown })} />
      ) : null}
      {f.state !== "noDomains" ? (
        <div className={styles.dpActions}><Button size="sm" onClick={open(null)}>{t("ld.waf.panel.open")} →</Button></div>
      ) : null}
    </Section>
  );
}

const counted = (f: WafFacts) => (d: WafDomainInfo) => f.unit === "domain" || d.kind === "public";
const endpointNone = (f: WafFacts) => f.domains.filter((d) => d.state === "none" && d.kind === "endpoint" && counted(f)(d)).length;

/** WAF panel (the badge, a sub-card or "WAF 상세 보기"): overview (key null), one policy ("p:<name>"), "none", "unknown" */
export function WafPanel({ parent, wafKey, metrics, measured, onSelectNode, onWafSelect, onClose }: {
  parent: DiagramNodeSpec;
  wafKey: string | null;
  metrics?: Record<string, number | null>;
  measured: boolean;
  onSelectNode?: (id: string) => void;
  onWafSelect?: (nodeId: string, key: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const f = wafFacts(parent.metadata);
  const kind = parent.resourceKind ?? parent.icon;
  const where = (
    <>
      {t(kind === "appGateway" ? "ld.waf.panel.ofAgw" : "ld.waf.panel.ofAfd")} ·{" "}
      <button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(parent.id)}>{parent.label}</button>
    </>
  );
  const policy = wafKey?.startsWith("p:") ? f?.policies.find((p) => `p:${p.name}` === wafKey) : undefined;
  const badge = wafBadge(parent.metadata);
  const header = (title: string, status: ReactNode, actions?: ReactNode) => (
    <header className={styles.dpHeader}>
      <div className={styles.dpTitleRow}>
        <img src={getAzureIconUrl("waf")} alt="" width={20} height={20} />
        <h2 className={styles.dpTitle} tabIndex={-1}>{title}</h2>
        <button type="button" className={styles.dpClose} onClick={onClose} aria-label={t("hb.close")}>✕</button>
      </div>
      <div className={styles.dpWhere}>{where}</div>
      <div className={styles.dpStatusRow}>{status}</div>
      {actions}
    </header>
  );
  if (!f) {
    return (
      <aside className={styles.detailPanel} aria-label="WAF">
        {header("WAF", null)}
        <div className={styles.dpBody}><div className={styles.dpMuted}>{t("ld.waf.panel.noFacts")}</div></div>
      </aside>
    );
  }
  const goOverview = <button type="button" className={styles.dpLink} onClick={() => onWafSelect?.(parent.id, null)}>{t("ld.waf.panel.overview")}</button>;
  const domainRow = (d: WafDomainInfo) => (
    <TwoLine key={`${d.kind}:${d.host}`} main={d.host} mono copy={d.host}
      sub={[t(`ld.waf.kind.${d.kind}`), d.policy && !policy ? maskGuids(d.policy) : null, d.reason ? t(`ld.waf.reason.${d.reason}`) : d.state !== "prevent" ? t(`ld.waf.domain.${d.state}`) : null].filter(Boolean).join(" · ")} />
  );
  const noneList = () => {
    const none = f.domains.filter((d) => d.state === "none");
    const custom = none.filter((d) => d.kind === "custom");
    const endpoint = none.filter((d) => d.kind === "endpoint");
    const listeners = none.filter((d) => d.kind === "public" || d.kind === "private");
    return (
      <Section id="waf-none" title={t(f.unit === "listener" ? "ld.waf.panel.noneListeners" : "ld.waf.panel.noneTitle")} count={f.counts.none}>
        {f.skuNoWaf ? <div className={styles.dpMuted}>{t("ld.waf.agw.skuNoWaf")}</div> : null}
        {custom.length ? <Group title={t("ld.waf.panel.customDomains", { n: custom.length })}><Folded items={custom} limit={8} render={domainRow} /></Group> : null}
        {endpoint.length ? (
          <Group title={t("ld.waf.panel.endpointDomains", { n: endpoint.length })}>
            <Folded items={endpoint} limit={8} render={domainRow} />
            {f.counts.prevent + f.counts.detect > 0 ? <div className={styles.dpReason}>{t("ld.waf.panel.bypass")}</div> : null}
          </Group>
        ) : null}
        {listeners.length ? <Folded items={listeners} limit={8} render={domainRow} /> : null}
        {f.unit === "domain" && none.length ? <div className={styles.dpMuted}>{t("ld.waf.panel.noneFix")}</div> : null}
      </Section>
    );
  };
  const unknownList = () => {
    const unknown = f.domains.filter((d) => d.state === "unknown");
    return unknown.length ? (
      <Section id="waf-unknown" title={t("ld.waf.panel.unknownTitle")} count={unknown.length}>
        <Folded items={unknown} limit={8} render={domainRow} />
      </Section>
    ) : null;
  };

  // ── One policy ──
  if (policy) {
    const pp = policyPill(policy);
    const standard = /^standard/i.test(policy.sku ?? "");
    const prevention = policy.mode?.toLowerCase() === "prevention";
    const covered = f.domains.filter((d) => d.policy === policy.name);
    const portal = policy.id ? `https://portal.azure.com/#@/resource${policy.id}` : null;
    return (
      <aside className={styles.detailPanel} aria-label={policy.name}>
        {header(maskGuids(policy.name), <Badge tone={BADGE_TONE[pp.tone]}>{t(pp.pill)}</Badge>,
          policy.id ? (
            <div className={styles.dpActions}>
              {portal ? <a className={styles.dpPortal} href={portal} target="_blank" rel="noreferrer">{t("ld.panel.portal")} ↗</a> : null}
              <CopyButton value={policy.id} label={t("ld.panel.copyId")} />
            </div>
          ) : null)}
        <div className={styles.dpBody}>
          <Section id="waf-policy" title={t("ld.waf.panel.summary")}>
            <KV label={t("ld.waf.mode")}>{policy.mode ? t(`ld.waf.mode.${policy.mode.toLowerCase()}`) : t("ld.peering.unknownValue")}</KV>
            <KV label={t("ld.waf.state")}>{policy.enabled == null ? t("ld.peering.unknownValue") : t(policy.enabled ? "ld.waf.enabled" : "ld.waf.disabled")}</KV>
            {policy.sku ? <KV label="SKU">{policy.sku.replace(/_AzureFrontDoor$/, "")}</KV> : null}
            {policy.level ? <KV label={t("ld.waf.levelLabel")}>{t(`ld.waf.level.${policy.level}`)}</KV> : null}
          </Section>
          <Section id="waf-rules" title={t("ld.waf.panel.rules")}>
            <Group title={t("ld.waf.managed")}>
              {policy.managed?.length
                ? policy.managed.map((m) => <TwoLine key={`${m.type}@${m.version}`} main={`${m.type} ${m.version}`} sub={m.action ? t("ld.waf.panel.action", { action: t(`ld.waf.action.${m.action.toLowerCase()}`) }) : null} />)
                : <div className={styles.dpMuted}>{t(standard ? "ld.waf.customOnly" : policy.managed ? "ld.waf.noManaged" : "ld.waf.managedUnknown")}</div>}
              {prevention && policy.managed?.some((m) => m.action?.toLowerCase() === "log") ? <div className={styles.dpReason}>{t("ld.waf.logInPrevention")}</div> : null}
            </Group>
            <KV label={t("ld.waf.customRules")}>{policy.customRules}</KV>
          </Section>
          <Section id="waf-covered" title={t(f.unit === "listener" ? "ld.waf.panel.coveredListeners" : "ld.waf.panel.covered")} count={covered.length || policy.domains.length}>
            {covered.length
              ? <Folded items={covered} limit={10} render={domainRow} />
              : <Folded items={policy.domains} limit={10} render={(h: string) => <TwoLine key={h} main={h} mono />} />}
          </Section>
          {kind === "frontDoor" ? <div className={styles.dpMuted}>{t("ld.waf.panel.noPerPolicy")} {goOverview}</div> : null}
        </div>
      </aside>
    );
  }

  // ── The units without a WAF / not judged, alone ──
  if (wafKey === "none" || wafKey === "unknown") {
    return (
      <aside className={styles.detailPanel} aria-label="WAF">
        {header(t(wafKey === "none" ? "ld.waf.sub.none" : "ld.waf.sub.unknown"), <Badge tone={wafKey === "none" ? "medium" : "low"}>{t(wafKey === "none" ? "ld.waf.pill.noBlock" : "ld.waf.pill.unknown")}</Badge>)}
        <div className={styles.dpBody}>
          {wafKey === "none" ? noneList() : unknownList()}
          <div className={styles.dpMuted}>{goOverview}</div>
        </div>
      </aside>
    );
  }

  // ── Overview ──
  const c = f.counts;
  const total = metrics?.wafTotal;
  const num = (v: number | null | undefined) => (v == null ? null : Math.round(v).toLocaleString());
  return (
    <aside className={styles.detailPanel} aria-label="WAF">
      {header(t("ld.waf.panel.overview"), badge ? <Badge tone={BADGE_TONE[badge.tone]}>{t(badge.labelKey, badge.vars)}</Badge> : null)}
      <div className={styles.dpBody}>
        {f.readError === "securityPolicies" ? <FetchFailed what={t("ld.waf.securityPolicies")} /> : null}
        {f.readError === "wafPolicies" ? <FetchFailed what={t("ld.waf.policies")} /> : null}
        <Section id="waf-states" title={t(f.unit === "listener" ? "ld.waf.panel.statesListeners" : "ld.waf.panel.states")} count={c.served}>
          <KV label={t("ld.waf.pill.prevention")}>{c.prevent}</KV>
          <KV label={t("ld.waf.pill.detection")}><Pill tone={c.detect ? "public" : "neutral"}>{c.detect}</Pill></KV>
          <KV label={t("ld.waf.pill.disabled")}><Pill tone={c.disabled ? "public" : "neutral"}>{c.disabled}</Pill></KV>
          <KV label={t("ld.waf.sub.none")}><Pill tone={c.none ? "public" : "neutral"}>{c.none}</Pill></KV>
          <KV label={t("ld.waf.pill.unknown")}><Pill tone={c.unknown ? "muted" : "neutral"}>{c.unknown}</Pill></KV>
        </Section>
        {f.policies.length ? (
          <Section id="waf-policies" title={t("ld.waf.panel.policies")} count={f.policies.length}>
            {f.policies.map((p: WafPolicyInfo) => {
              const pp = policyPill(p);
              return (
                <TwoLine key={p.name} onClick={() => onWafSelect?.(parent.id, `p:${p.name}`)}
                  main={<><Pill tone={pp.tone}>{t(pp.pill)}</Pill> · {maskGuids(p.name)}</>}
                  sub={[t(unitsKey(f), { n: p.domains.length }), f.unit === "listener" && p.level ? t(`ld.waf.level.${p.level}`) : t("ld.waf.sub.rules", { m: p.managed ? p.managed.length : "—", c: p.customRules })].join(" · ")} />
              );
            })}
          </Section>
        ) : null}
        {c.none > 0 ? noneList() : null}
        {unknownList()}
        <Section id="waf-verdicts" title={t("ld.waf.panel.verdicts")}>
          {kind === "frontDoor" ? (
            total == null ? <div className={styles.dpMuted}>{t(measured ? "ld.waf.noRecords" : "ld.unmeasured")}</div> : (
              <>
                <KV label={t("ld.waf.action.block")}>{num(metrics?.wafBlock) ?? t("ld.waf.noBlock")}</KV>
                <KV label={t("ld.waf.action.log")}>{num(metrics?.wafLog) ?? "0"}</KV>
                <KV label={t("ld.waf.panel.total")}>{num(total)}</KV>
              </>
            )
          ) : <div className={styles.dpMuted}>{t("ld.waf.agw.verdictsUnbound")}</div>}
          {kind === "frontDoor" ? <div className={styles.dpMuted}>{t("ld.waf.panel.verdictsNote")}</div> : null}
        </Section>
        {f.unserved.length ? (
          <Section id="waf-unserved" title={t("ld.waf.panel.unservedTitle")} count={f.unserved.length} defaultOpen={false}>
            <Folded items={f.unserved} limit={8} render={(h: string) => <TwoLine key={h} main={h} mono />} />
          </Section>
        ) : null}
      </div>
    </aside>
  );
}

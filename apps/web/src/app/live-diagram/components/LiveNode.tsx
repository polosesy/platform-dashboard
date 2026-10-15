"use client";

import { memo, type CSSProperties } from "react";
import type { GatewayFacts } from "@/lib/liveBackends";
import { useI18n } from "@/lib/i18n";
import type { NodeProps } from "reactflow";
import type { HealthRule, HealthStatus, InboundExposure, LiveNode as LiveNodeState, LiveSourceState, PowerState, SparklineData, DiagramIconKind, SubResource } from "@aud/types";
import type { HybridFacts } from "@/lib/liveHybrid";
import type { WafChip } from "@/lib/liveWaf";
import { cardStatus } from "@/lib/liveStatus";
import { getAzureIconUrl } from "../utils/azureIcons";
import { HiddenHandles } from "./HiddenHandles";
import { Spark } from "./Spark";
import { FullNameTag } from "./NameParts";
import type { NamePart } from "@/lib/liveNames";
import type { UsageChip } from "@/lib/plUsage";
import { pipChip } from "@/lib/livePip";
import { cardCells, cellTone, compactPercent, isUsagePair, metricCells, METRIC_META, sparkDomain, USAGE_DEFAULT_THRESHOLD, type MetricCell } from "@/lib/liveMetricFormat";
import { middleEllipsis } from "@/lib/liveNames";
import { maskGuids } from "@/lib/mask";
import styles from "../styles.module.css";

export type NsgBadgeInfo = {
  nodeId: string;
  label: string;
  icon: DiagramIconKind;
  azureResourceId?: string;
};

export type LiveNodeData = {
  label: string;
  /** Name without the words its VNet repeats (lib/liveNames) — the full name shows in a tag while selected */
  shortName?: string;
  /** The full name split into the words the short name kept and dropped */
  nameParts?: NamePart[];
  /** Selected (detail panel open) — shows the full-name tag */
  focused?: boolean;
  icon: DiagramIconKind;
  health: HealthStatus;
  healthScore: number;
  metrics: Record<string, number | null>;
  hasAlert: boolean;
  sparklines?: Record<string, SparklineData>;
  /** Metric keys the API reads for this kind (NODE_BINDINGS); empty → the card shows a relation line */
  boundMetrics?: string[];
  /** Usage thresholds from the kind's health rules (cpu 85, memory 80, …) — the gauge turns orange there */
  usageWarn?: Record<string, number>;
  /** The kind's health rules (from the API) — a card value is toned by the same rules that set the status */
  healthRules?: HealthRule[];
  /** Private Link use chips (lib/plUsage usageChips): PE "사용 n" / "사용 기록 없음" / "근거 없음", PaaS "사용처 n" / "공용 접근" */
  plChips?: UsageChip[];
  /** Why metrics may be missing: sign-in needed, not collected (example diagram), … */
  metricsState?: LiveSourceState;
  /** One line for kinds without metrics ("→ App Service · Private Link", "연결 서브넷 3") — already translated */
  relation?: string;
  endpoint?: string;
  subResources?: SubResource[];
  onSubResourceSelect?: (sr: SubResource) => void;
  resourceKind?: string;
  azureResourceId?: string;
  powerState?: PowerState;
  /** What the status rests on (API evidence ladder) — observed / configured / notApplicable change the pill */
  basis?: LiveNodeState["basis"];
  archRole?: string;
  archGroupId?: string;
  nsgBadge?: NsgBadgeInfo;
  onNsgSelect?: (nodeId: string) => void;
  aksClusterArmId?: string;
  vmssExpanded?: boolean;
  onVmssExpand?: (nodeId: string, azureResourceId: string, aksClusterArmId?: string) => void;
  isUnused?: boolean; // public IP not attached to any resource
  /** Shown only because a configured link reaches it — it belongs to this other VNet */
  ghostOf?: string;
  /** Fault impact role: the failing resource, or one configured hop away from it */
  impact?: "source" | "affected";
  /** LB / App Gateway: unresolved pool members, created by AKS, outbound only (lib/liveBackends) */
  gateway?: GatewayFacts;
  /** VPN gateway (S2S connection count, SKU) / on-premises site (address ranges, BGP, connection state at read time) */
  hybrid?: HybridFacts;
  /** Flexible-mode VM: the scale set it belongs to (catalog VMSS-03) */
  scaleSet?: string;
  /** Generic PaaS card: its ARM type */
  armType?: string;
  /** VM: the NSG verdict on its own public IP (catalog PIP-04, lib/livePip) */
  pipExposure?: InboundExposure;
  /** Front Door WAF coverage chip (lib/liveWaf.ts, catalog EDGE-10) — configuration, never the card status */
  waf?: WafChip;
};

/** Kind as the card's second line names it (product names / CAF abbreviations — not translated) */
const KIND_ABBR: Record<string, string> = {
  vm: "VM", vmss: "VMSS", aks: "AKS", containerApp: "Container Apps",
  functionApp: "Functions", appService: "App Service", sql: "SQL",
  storage: "Storage", redis: "Redis", cosmosDb: "Cosmos DB",
  postgres: "PostgreSQL", keyVault: "Key Vault", appGateway: "App GW",
  lb: "LB", frontDoor: "Front Door", trafficManager: "Traffic Manager",
  firewall: "Firewall", natGateway: "NAT GW", appInsights: "App Insights", logAnalytics: "Log Analytics",
  nic: "NIC", nsg: "NSG", dns: "DNS", privateEndpoint: "PE", publicIP: "Public IP",
  serviceBus: "Service Bus", eventHub: "Event Hubs",
  agc: "AGC", vnetGateway: "VNet GW", bastion: "Bastion",
};

/** Generic PaaS card: the product from the ARM type (product names, not translated) */
const PAAS_ABBR: Record<string, string> = {
  "microsoft.containerregistry/registries": "Container Registry", "microsoft.cognitiveservices/accounts": "AI Services",
  "microsoft.cache/redisenterprise": "Redis Enterprise", "microsoft.documentdb/mongoclusters": "Cosmos DB (Mongo vCore)",
};

const PRIVATE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Second line: what it is and where it answers (private IP, frontend kind), from configuration only */
function describe(d: LiveNodeData, t: TFn): string {
  const kind = d.resourceKind ?? d.icon;
  if (kind === "paas") return PAAS_ABBR[d.armType ?? ""] ?? "PaaS";
  const abbr = KIND_ABBR[kind] ?? kind;
  const subs = d.subResources ?? [];
  const nics = subs.filter((s) => s.kind === "nic");
  const nicIp = nics.find((s) => s.endpoint)?.endpoint;
  const publics = subs.filter((s) => s.kind === "publicIP");
  const frontends = subs.filter((s) => s.kind === "frontendIP");
  switch (kind) {
    case "vm":
      return [abbr, nicIp, nics.length > 1 ? t("ld.card.nics", { n: nics.length }) : null].filter(Boolean).join(" · ");
    case "vmss":
      return d.archRole === "aks-vmss" ? `${abbr} · ${t("ld.card.aksPool")}` : abbr;
    case "lb": {
      if (publics.length && publics.length === subs.length) return `${abbr} · ${t("ld.card.public")} ${publics[0]!.endpoint ?? ""}`.trim();
      const fe = frontends[0]?.endpoint ?? publics[0]?.endpoint;
      return fe ? `${abbr} · ${PRIVATE.test(fe) ? t("ld.card.internal") : t("ld.card.public")} ${fe}` : abbr;
    }
    case "appGateway": {
      const fe = frontends[0]?.endpoint;
      if (!fe) return abbr;
      return `${abbr} · ${PRIVATE.test(fe) ? t("ld.card.privateFrontend") : t("ld.card.publicFrontend")}`;
    }
    case "privateEndpoint":
      return [abbr, nicIp ?? (d.endpoint && PRIVATE.test(d.endpoint) ? d.endpoint : undefined)].filter(Boolean).join(" · ");
    case "natGateway":
      return `${abbr} · ${t("ld.card.publicIps", { n: publics.length })}`;
    case "vnetGateway": {
      const h = d.hybrid?.kind === "gateway" ? d.hybrid : undefined;
      return [abbr, h?.sku, h?.s2s ? t("ld.card.s2s", { n: h.s2s }) : null].filter(Boolean).join(" · ");
    }
    case "onPremSite": {
      const h = d.hybrid?.kind === "site" ? d.hybrid : undefined;
      return [t("ld.kind.onPremSite"), h ? t("ld.card.ranges", { n: h.prefixes }) : null].filter(Boolean).join(" · ");
    }
    default:
      return abbr;
  }
}

/** Rough text widths (px) to decide whether the second metric cell still leaves room for the trend */
const textW = (s: string, ko: number, other: number) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? ko : other), 0);

export const LiveNode = memo(function LiveNode({ id: nodeId, data }: NodeProps<LiveNodeData>) {
  const { t } = useI18n();
  const { label, icon, health, metrics, hasAlert, sparklines, subResources, resourceKind, azureResourceId, powerState, archRole, nsgBadge, onNsgSelect, aksClusterArmId, vmssExpanded, onVmssExpand, isUnused, ghostOf, impact } = data;
  const status = cardStatus(health, powerState, impact, data.basis);
  const name = data.shortName || label;
  const original = azureResourceId ? azureResourceId.split("/").pop() ?? label : label;
  const fullName = maskGuids(original);
  // Tag only when the card does not already show the whole name (13 = the summary zoom's clip, the tightest)
  const showTag = !!data.focused && (fullName !== name || [...name].length > 13);
  const kind = resourceKind ?? icon;

  // ── metrics: bound keys only; trend = the series the API keeps for this node ──
  // Spec keys plus what the API now reads for the kind (a diagram saved before memory was added still shows it)
  const specBound = data.boundMetrics ?? [];
  const bound = [...specBound, ...Object.keys(metrics).filter((k) => !specBound.includes(k))];
  // The kind's two card metrics (lib/liveMetricFormat CARD_CELLS): cell 1 = load / activity with the trend,
  // cell 2 = quality. Compute kinds are a usage pair (two gauges).
  const fallbackTrend = sparklines ? Object.values(sparklines).find((s) => s.values.length >= 2)?.metric : undefined;
  const cellKeys = cardCells(kind, bound, fallbackTrend);
  const first = cellKeys[0] ? sparklines?.[cellKeys[0]] : undefined;
  const trend = first && first.values.length >= 2 ? first : undefined;
  const trendKey = trend ? cellKeys[0] : undefined;
  const cells = metricCells(cellKeys, metrics, cellKeys[0]);
  const threshold = (k: string) => data.usageWarn?.[k] ?? USAGE_DEFAULT_THRESHOLD;
  const tone = (k: string) => cellTone(k, metrics, data.healthRules, threshold(k));
  // crit is drawn like warn inside the card — red belongs to the status pill and the fault-impact outline
  const toneAttr = (k: string) => { const x = tone(k); return x === "crit" || x === "warn" ? "warn" : x; };
  const usageLabel = (k: string) => t(k === "memory" ? "ld.metric.memShort" : METRIC_META[k]?.label ?? k);
  const pair = isUsagePair(cellKeys);
  const usagePair = pair ? cellKeys : [];
  const anyValue = cells.some((c) => c.state === "value");
  const cellText = (c: MetricCell) => ({
    key: t(METRIC_META[c.key]?.label ?? c.key),
    value: c.state === "value" ? c.value : t("ld.unmeasured"),
    unit: c.state === "value" ? `${c.unit}${c.unitKey ? t(c.unitKey) : ""}` : "",
  });
  const shown = cells.slice(0, 2).map(cellText);
  // Second cell only while the trend keeps at least 48 px
  const cellW = (c: { key: string; value: string; unit: string }) => Math.max(textW(c.key, 10, 6), textW(c.value, 9.6, 9.6) + textW(c.unit, 11, 6.6));
  const trendW = shown.length > 1 ? 196 - (cellW(shown[0]!) + 12 + cellW(shown[1]!)) - 8 : 196 - cellW(shown[0] ?? { key: "", value: "", unit: "" }) - 20;
  const twoCells = shown.length > 1 && trendW >= 48;
  const visibleCells = twoCells ? shown : shown.slice(0, 1);
  const trendColor = status.tone === "high" || status.tone === "medium" ? status.color : "rgba(var(--accent-rgb), 0.85)";
  const metricsBlocked = !anyValue && (data.metricsState === "signin" || data.metricsState === "disabled");
  const cellTitle = cells.map((c) => {
    const x = cellText(c);
    const x2 = tone(c.key);
    const warn = x2 === "warn" || x2 === "crit" ? ` (${t(x2 === "crit" ? "ld.card.cellCrit" : "ld.card.cellWarn")})` : "";
    return `${x.key} ${x.value}${x.unit}${warn}`;
  }).join(" · ");
  const spark = trend && trendKey
    ? <Spark className={styles.cardSpark} values={trend.values} domain={sparkDomain(trendKey, trend.values)} color={trendColor} />
    : <span className={styles.cardSpark} data-empty="true" aria-hidden="true">—</span>;
  /** 4 px bar in the key line — neutral grey, orange at the health-rule threshold; nothing drawn without a value */
  const gauge = (v: number | null) => (
    <span className={styles.cardGauge} aria-hidden="true">
      <i style={{ width: v == null || v <= 0 ? 0 : `max(1.5px, ${Math.min(100, v)}%)` }} />
    </span>
  );

  // ── chips on the second line (at most two, by priority) ──
  const publicIp = subResources?.find((s) => s.kind === "publicIP")?.endpoint;
  const chips: Array<{ key: string; el: React.ReactNode }> = [];
  // Observed Private Link use first: it is what this card is about when the layer is on
  for (const c of data.plChips ?? []) {
    chips.push({ key: `pl:${c.key}`, el: <span className={styles.cardChip} data-tone={c.tone === "warn" ? "public" : c.tone === "muted" ? "muted" : "pl"} title={t(`${c.key}.hint`)}>{t(c.key, c.vars)}</span> });
  }
  if (archRole === "aks-vmss" && azureResourceId && onVmssExpand) {
    chips.push({ key: "inst", el: (
      <button type="button" className={styles.cardChip} onClick={(e) => { e.stopPropagation(); onVmssExpand(nodeId, azureResourceId, aksClusterArmId); }}>
        {t("ld.card.instances")} {vmssExpanded ? "▴" : "▾"}
      </button>
    ) });
  }
  if (data.waf) {
    const w = data.waf;
    chips.push({ key: "waf", el: <span className={styles.cardChip} data-tone={w.tone} title={t(w.hint.key, w.hint.vars)}>{t(w.key, w.vars)}</span> });
  }
  if (data.pipExposure) {
    // What the Internet may do with this VM's own public IP — from the NSG verdict, never from traffic
    const c = pipChip(data.pipExposure, publicIp);
    chips.push({ key: "pip", el: <span className={styles.cardChip} data-tone={c.tone} title={c.title}>⊕ {t(c.key, c.vars)}</span> });
  } else if (publicIp && kind !== "lb" && kind !== "natGateway") chips.push({ key: "pip", el: <span className={styles.cardChip} data-tone="public" title={publicIp}>⊕ {t("ld.card.public")}</span> });
  if (nsgBadge) {
    chips.push({ key: "nsg", el: (
      <button type="button" className={styles.cardChip} title={nsgBadge.label} onClick={(e) => { e.stopPropagation(); onNsgSelect?.(nsgBadge.nodeId); }}>NSG</button>
    ) });
  }
  if (ghostOf) chips.push({ key: "ghost", el: <span className={styles.cardChip} title={t("ld.ghostHint", { vnet: ghostOf })}>↗ {middleEllipsis(ghostOf, 12)}</span> });
  if (isUnused) chips.push({ key: "unused", el: <span className={styles.cardChip} title={t("ld.unusedPipHint")}>{t("ld.unused")}</span> });
  // Gateways: members the pool names but no resource could be matched to — said, never guessed
  const gw = data.gateway;
  if (gw?.unresolved) chips.push({ key: "unres", el: <span className={styles.cardChip} data-tone="public" title={t("ld.chip.unresolvedBackends.hint")}>{t("ld.chip.unresolvedBackends", { n: gw.unresolved })}</span> });
  if (gw?.outboundOnly) chips.push({ key: "outOnly", el: <span className={styles.cardChip} title={t("ld.chip.outboundOnly.hint")}>{t("ld.chip.outboundOnly")}</span> });
  if (gw?.aksManaged) chips.push({ key: "aks", el: <span className={styles.cardChip} title={t("ld.chip.aksManaged.hint")}>{t("ld.chip.aksManaged")}</span> });
  const hy = data.hybrid;
  if (hy?.kind === "site" && hy.status !== "Connected") chips.push({ key: "s2sState", el: <span className={styles.cardChip} data-tone="public" title={t("ld.hybrid.readTime")}>{t(`ld.hybrid.status.${hy.status}`)}</span> });
  if (hy?.kind === "gateway" && hy.activeActive) chips.push({ key: "aa", el: <span className={styles.cardChip} title={t("ld.hybrid.activeActive")}>A/A</span> });
  if (hy?.bgp) chips.push({ key: "bgp", el: <span className={styles.cardChip} title={t("ld.chip.bgp.hint")}>BGP</span> });
  if (hy?.kind === "site" && hy.nat) chips.push({ key: "nat", el: <span className={styles.cardChip} title={t("ld.chip.s2sNat.hint")}>NAT</span> });
  if (data.scaleSet != null) chips.push({ key: "vmss", el: <span className={styles.cardChip} title={t("ld.chip.scaleSet.hint", { name: data.scaleSet })}>{t("ld.chip.scaleSet", { name: middleEllipsis(data.scaleSet, 12) })}</span> });

  const line3 = !cellKeys.length
    ? <div className={styles.cardRelation}>{data.relation ?? t(kind === "vmss" ? "ld.card.vmssNoMetrics" : "ld.card.noMetrics")}</div>
    : metricsBlocked
      ? <div className={styles.cardRelation}>{t(data.metricsState === "signin" ? "ld.card.signin" : "ld.card.notCollected")}</div>
      : pair
        ? (
          <div className={styles.cardMetrics} data-pair="true" title={cellTitle}>
            {usagePair.map((k) => {
              const v = metrics[k] ?? null;
              return (
                <div key={k} className={styles.cardCell} data-usage={toneAttr(k)} data-unmeasured={v == null || undefined}>
                  <span className={styles.cardCellKey}>
                    {k === trendKey ? <i className={styles.cardTrendDot} style={{ background: trendColor }} /> : null}
                    {usageLabel(k)}
                    {gauge(v)}
                  </span>
                  <span className={styles.cardCellVal}>{v == null ? t("ld.unmeasuredShort") : <>{compactPercent(v)}<small>%</small></>}</span>
                </div>
              );
            })}
            {spark}
          </div>
        )
        : (
          <div className={styles.cardMetrics} title={cellTitle}>
            {visibleCells.map((c, i) => (
              <div key={i} className={styles.cardCell} data-usage={toneAttr(cells[i]!.key)} data-unmeasured={cells[i]!.state === "unmeasured" || undefined}>
                <span className={styles.cardCellKey}>{cells[i]!.key === trendKey ? <i className={styles.cardTrendDot} style={{ background: trendColor }} /> : null}{c.key}</span>
                <span className={styles.cardCellVal}>{c.value}<small>{c.unit}</small></span>
              </div>
            ))}
            {spark}
          </div>
        );

  const primary = shown[0];
  const glyphQuiet = status.key === "ld.status.ok" || status.key === "ld.power.running";

  return (
    <div
      className={styles.card}
      data-ghost={ghostOf ? "true" : undefined}
      data-impact={impact}
      data-tone={status.tone}
      data-focused={data.focused || undefined}
      style={{ "--status": status.color } as CSSProperties}
      title={showTag ? undefined : fullName}
      aria-label={fullName}
    >
      <HiddenHandles />
      {showTag && <FullNameTag fullName={fullName} original={original} parts={original === label ? data.nameParts : undefined} ghostOf={ghostOf} />}
      <span className={styles.cardStrip} aria-hidden="true" />
      {hasAlert && <span className={styles.cardAlertDot} aria-label={t("live.alerts")} />}

      {/* Detail (zoom ≥ 0.78) */}
      <div className={`${styles.cardBody} ${styles.lodDetail}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl(icon)} alt="" width={18} height={18} />
          <span className={styles.cardName}>{middleEllipsis(name, 18)}</span>
          {status.glyph ? <span className={styles.cardPill} data-tone={status.tone}>{status.glyph} {t(status.key)}</span> : null}
        </div>
        <div className={styles.cardRow2}>
          <span className={styles.cardDesc}>{describe(data, t)}</span>
          {chips.slice(0, 2).map((c) => <span key={c.key} className={styles.cardChipWrap}>{c.el}</span>)}
        </div>
        <div className={styles.cardDivider} />
        {line3}
      </div>

      {/* Summary (0.40–0.78): big name, one metric, the trend */}
      <div className={`${styles.cardBody} ${styles.lodSummary}`}>
        <div className={styles.cardRow1}>
          <img src={getAzureIconUrl(icon)} alt="" width={24} height={24} />
          <span className={styles.cardNameBig}>{middleEllipsis(name, 13)}</span>
          {!glyphQuiet && <span className={styles.cardGlyphBig} style={{ color: status.color }}>{status.glyph}</span>}
        </div>
        {pair && !metricsBlocked ? (
          <div className={styles.cardMeters} title={cellTitle}>
            {usagePair.map((k) => {
              const v = metrics[k] ?? null;
              return (
                <div key={k} className={styles.cardMeter} data-usage={toneAttr(k)} data-unmeasured={v == null || undefined}>
                  <span className={styles.cardMeterKey}>{usageLabel(k)}</span>
                  {gauge(v)}
                  <span className={styles.cardMeterVal}>{v == null ? t("ld.unmeasuredShort") : <>{compactPercent(v)}<small>%</small></>}</span>
                </div>
              );
            })}
          </div>
        ) : cellKeys.length && primary && !metricsBlocked ? (
          <div className={styles.cardMetricBig} data-usage={toneAttr(cellKeys[0]!)}>
            <span className={styles.cardCellKeyBig}>{primary.key}</span>
            <span className={styles.cardCellValBig}>{primary.value}<small>{primary.unit}</small></span>
            {trend && trendKey ? <Spark className={styles.cardSparkBig} values={trend.values} domain={sparkDomain(trendKey, trend.values)} color={trendColor} /> : null}
          </div>
        ) : null}
      </div>

      {/* Outline (< 0.40): the name only, tinted by status */}
      <div className={`${styles.cardBody} ${styles.lodGlance}`}>
        <img src={getAzureIconUrl(icon)} alt="" width={32} height={32} />
        <span className={styles.cardNameHuge}>{middleEllipsis(name, 16)}</span>
      </div>
    </div>
  );
});

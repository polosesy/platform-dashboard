"use client";

import { useMemo } from "react";
import type {
  AksNodeCondition,
  AlertRuleInfo,
  PrivateLinkUsageResponse,
  DiagramEdgeSpec,
  DiagramNodeSpec,
  DiagramSpec,
  FaultImpact,
  HealthRule,
  LiveAlert,
  LiveEdge,
  LiveNode,
  LiveSourceState,
  PowerState,
} from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { Badge, Button } from "@/components/ui";
import { maskGuids } from "@/lib/mask";
import { shortNamesWithParts } from "@/lib/liveNames";
import { NameParts } from "./NameParts";
import { PrivateLinkUsageSection } from "./detail/PrivateLinkUsage";
import { cardCells, formatMetric, METRIC_META, sparkDomain } from "@/lib/liveMetricFormat";
import { isInferredEdge } from "@/lib/liveScope";
import { relationLabel } from "@/lib/liveStyle";
import { getAzureIconUrl } from "../utils/azureIcons";
import { formatAzureRegion } from "../utils/regionFormat";
import { cardStatus } from "@/lib/liveStatus";
import { Spark } from "./Spark";
import { CopyButton, Group, KV, Section, StaticSection, useRelativeTime } from "./detail/primitives";
import { gatewayFrontends, unresolvedBackends } from "@/lib/liveBackends";
import { AgcFacts, AksApiEndpoint, AksCluster, AksNodePool, BackendPools, FrontDoorFacts, NsgRules, useAksPlane, useBackendPool, useNsgDetail, useVmssInstances } from "./detail/kindSections";
import styles from "../styles.module.css";

type ConnectedEdge = {
  edgeSpec: DiagramEdgeSpec;
  liveEdge?: LiveEdge;
  peerLabel: string;
  direction: "inbound" | "outbound";
};

type VmssInstancePanelData = {
  computerName: string;
  powerState: string;
  provisioningState?: string;
  privateIp?: string;
  nodePoolName?: string;
  nodeImageVersion?: string;
  conditions?: AksNodeCondition[];
  parentVmssId: string;
  label: string;
};

type ResourceDetailPanelProps = {
  /** The diagram in view — peers, subnets and NSGs are looked up here */
  spec: DiagramSpec;
  nodeSpec: DiagramNodeSpec | null;
  liveNode: LiveNode | null;
  alerts: LiveAlert[];
  alertRules: AlertRuleInfo[];
  connectedEdges: ConnectedEdge[];
  /** Fault impacts in view (this node may be a source or a neighbour) */
  impacts?: FaultImpact[];
  /** Alerts in view, for the "back to alerts" line */
  alertCount?: number;
  generatedAt?: string;
  metricsState?: LiveSourceState;
  /** The "추정 의존성" layer is on — guessed connections are listed (folded) */
  showInferred?: boolean;
  /** Who uses the Private Endpoints of the VNet in view (null = not loaded / not one VNet) */
  usage?: PrivateLinkUsageResponse | null;
  usageLoading?: boolean;
  /** Select another resource and bring it into view */
  onSelectNode?: (id: string) => void;
  onBack?: () => void;
  onClose: () => void;
  vmssInstance?: VmssInstancePanelData | null;
};

const PRIVATE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const PROV = ["Succeeded", "Creating", "Updating", "Deleting", "Failed"];

/** IPv4 inside a CIDR */
function inCidr(ip: string, cidr: string | undefined): boolean {
  if (!cidr || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!base || !Number.isFinite(bits)) return false;
  const num = (s: string) => s.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (num(ip) & mask) === (num(base) & mask);
}

const OP_KEY: Record<string, string> = { "<": "ld.op.lt", "<=": "ld.op.le", ">": "ld.op.gt", ">=": "ld.op.ge" };

/** "{type}/{name}" of an ARM id — the subscription and resource group have their own rows */
function shortArmId(id: string): string {
  const parts = id.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function subscriptionOf(id: string | undefined): string | undefined {
  return id?.match(/\/subscriptions\/([^/]+)/i)?.[1];
}

export function ResourceDetailPanel(props: ResourceDetailPanelProps) {
  const { nodeSpec, vmssInstance } = props;
  if (!nodeSpec && vmssInstance) return <VmssInstancePanel data={vmssInstance} onClose={props.onClose} />;
  if (!nodeSpec) return null;
  return <NodePanel {...props} nodeSpec={nodeSpec} />;
}

function NodePanel({ spec, nodeSpec: node, liveNode, alerts, alertRules, connectedEdges, impacts = [], alertCount = 0, generatedAt, metricsState, showInferred, usage, usageLoading, onSelectNode, onBack, onClose }: ResourceDetailPanelProps & { nodeSpec: DiagramNodeSpec }) {
  const { t } = useI18n();
  const ago = useRelativeTime();
  const kind = node.resourceKind ?? node.icon;
  const archRole = node.metadata?.archRole;
  const byId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec.nodes]);

  // Names inside this view (the VNet's own words dropped), same as the cards
  const names = useMemo(() => {
    const vnetOf = (id: string) => {
      const self = byId.get(id);
      if (self?.metadata?.ghostOf) return self.metadata.ghostOf;
      let cur = self;
      while (cur?.parentId) cur = byId.get(cur.parentId);
      return cur && cur !== self && cur.icon === "vnet" ? cur.label : undefined;
    };
    const entry = (n: DiagramNodeSpec) => ({ id: n.id, label: n.label, kind: n.resourceKind ?? n.icon });
    return new Map([
      ...shortNamesWithParts(spec.nodes.filter((n) => n.nodeType === "group" && n.icon !== "vnet").map(entry), vnetOf),
      ...shortNamesWithParts(spec.nodes.filter((n) => n.nodeType !== "group" && !n.metadata?.nsgAttachedTo).map(entry), vnetOf),
    ]);
  }, [spec.nodes, byId]);
  const nameOf = (id: string) => names.get(id)?.text ?? byId.get(id)?.label ?? id;

  const subnet = node.parentId ? byId.get(node.parentId) : undefined;
  const isSubnetParent = subnet?.icon === "subnet";
  const vnet = isSubnetParent && subnet?.parentId ? byId.get(subnet.parentId) : subnet?.icon === "vnet" ? subnet : undefined;

  // ── status: the card's status, with the rule that decided it ──
  const health = liveNode?.health ?? "unknown";
  const powerState = liveNode?.powerState as PowerState | undefined;
  const role = impacts.find((i) => i.sourceNodeId === node.id) ? "source" as const : impacts.some((i) => i.affectedNodeIds.includes(node.id)) ? "affected" as const : undefined;
  const status = cardStatus(health, powerState, role, liveNode?.basis);
  const metrics = liveNode?.metrics ?? {};
  const specBound = Object.entries(node.bindings).filter(([, b]) => b.source !== "composite").map(([k]) => k);
  // Plus metrics the API now reads for the kind (diagram saved before memory was added)
  // The card's two metrics first (same order as the card), then the rest the API reads for the kind
  const allBound = [...specBound, ...Object.keys(metrics).filter((k) => !specBound.includes(k))];
  const first = cardCells(node.resourceKind ?? node.icon, allBound);
  const bound = [...first.filter((k) => allBound.includes(k)), ...allBound.filter((k) => !first.includes(k))];
  const rules: HealthRule[] = node.bindings.health?.rules ?? [];
  const failing = (health === "warning" || health === "critical")
    ? rules.find((r) => !(r.op === ">" && r.threshold === 0) && metrics[r.metric] != null && !passes(metrics[r.metric]!, r))
    : undefined;
  const reason = failing
    ? (() => {
        const v = formatMetric(failing.metric, metrics[failing.metric]!);
        const thr = formatMetric(failing.metric, failing.threshold);
        return t("ld.panel.reason", { metric: t(METRIC_META[failing.metric]?.label ?? failing.metric), value: `${v.value}${v.unit}${v.unitKey ? t(v.unitKey) : ""}`, threshold: `${thr.value}${thr.unit}`, op: t(OP_KEY[failing.op] ?? "ld.op.lt") });
      })()
    : health === "unknown" && bound.length && (metricsState === "signin" || metricsState === "disabled")
      ? t(metricsState === "signin" ? "ld.card.signin" : "ld.card.notCollected")
      // What the state rests on (Resource Health, approvals, traffic both ways — the API's evidence ladder)
      : liveNode?.reasons?.length
        ? liveNode.reasons.map((r) => t(r)).join(" · ")
        : undefined;

  const armId = node.azureResourceId;
  const portal = armId && armId.startsWith("/subscriptions/") && !armId.startsWith("/subscriptions/mock/") ? `https://portal.azure.com/#@/resource${armId}` : undefined;
  const fullName = maskGuids(armId ? armId.split("/").pop() ?? node.label : node.label);

  // ── kind-specific lookups ──
  const backend = useBackendPool(armId, kind);
  const nsgDetail = useNsgDetail(armId, kind);
  const aks = useAksPlane(armId, kind, archRole);
  const vmss = useVmssInstances(armId, archRole);

  // ── connections, grouped by meaning ──
  type Row = { id: string; peer: string; arrow: "←" | "→"; rel: string; edge: DiagramEdgeSpec };
  const groups = useMemo(() => {
    const g = { in: [] as Row[], out: [] as Row[], egress: [] as Row[], privateLink: [] as Row[], peering: [] as Row[], inferred: [] as Row[] };
    for (const ce of connectedEdges) {
      const e = ce.edgeSpec;
      const peer = e.source === node.id ? e.target : e.source;
      const rel = relationLabel(e, byId);
      const row: Row = { id: e.id, peer, arrow: ce.direction === "inbound" ? "←" : "→", rel: rel ? t(rel.key, rel.vars) : t("ld.panel.relConfig"), edge: e };
      if (isInferredEdge(e)) g.inferred.push({ ...row, rel: t("ld.layer.inferred") });
      else if (e.edgeKind === "outbound-internet" || e.edgeKind === "natgw-association") g.egress.push(row);
      else if (e.edgeKind === "privateLink") g.privateLink.push(row);
      else if (e.edgeKind === "peering") g.peering.push(row);
      else (ce.direction === "inbound" ? g.in : g.out).push(row);
    }
    return g;
  }, [connectedEdges, node.id, byId, t]);
  const configuredCount = groups.in.length + groups.out.length + groups.egress.length + groups.privateLink.length + groups.peering.length;

  const peerRow = (r: Row) => {
    const p = byId.get(r.peer);
    const pSub = p?.parentId ? byId.get(p.parentId) : undefined;
    const peerName = p?.resourceKind === "internet" ? t(p.metadata?.direction === "ingress" ? "ld.internetIn" : "ld.internetOut") : nameOf(r.peer);
    const where = pSub?.icon === "subnet" ? nameOf(pSub.id) : p?.metadata?.ghostOf ? `↗ ${p.metadata.ghostOf}` : "";
    return (
      <button key={r.id} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(r.peer)}>
        <span className={styles.dpConnArrow}>{r.arrow}</span>
        <span className={styles.dpConnRel} title={r.rel}>{r.rel}</span>
        {/* Name on one line, where it lives under it — long Azure names truncate (full text in the tooltip) */}
        <span className={styles.dpConnPeer}>
          <span className={styles.dpConnName}>
            {p ? <img src={getAzureIconUrl(p.icon)} alt="" width={14} height={14} /> : null}
            <span className={styles.dpConnText} title={peerName}>{peerName}</span>
          </span>
          {where ? <span className={styles.dpConnWhere} title={where}>{where}</span> : null}
        </span>
      </button>
    );
  };
  const groupBlock = (key: string, rows: Row[]) => rows.length ? (
    <Group key={key} title={t(`ld.panel.conn.${key}`)}>
      {rows.slice(0, 5).map(peerRow)}
      {rows.length > 5 ? <div className={styles.dpMuted}>{t("ld.panel.more", { n: rows.length - 5 })}</div> : null}
    </Group>
  ) : null;

  // ── network facts (configuration only) ──
  const nics = (node.subResources ?? []).filter((s) => s.kind === "nic");
  const publics = (node.subResources ?? []).filter((s) => s.kind === "publicIP");
  const frontends = (node.subResources ?? []).filter((s) => s.kind === "frontendIP" || s.kind === "publicIP");
  // Frontends with their listeners, and pool members no resource matched (lib/liveBackends, catalog AGW-01 / AGW-04)
  const gwFrontends = gatewayFrontends(node.metadata);
  const unresolved = unresolvedBackends(node.metadata);
  const subnets = spec.nodes.filter((n) => n.icon === "subnet" && n.nodeType === "group");
  const subnetForIp = (ip?: string) => (ip ? subnets.find((s) => inCidr(ip, s.metadata?.prefix ?? s.endpoint)) : undefined);
  const nsgOn = (targetId: string | undefined) => (targetId ? spec.nodes.filter((n) => n.icon === "nsg" && n.metadata?.nsgAttachedTo === targetId) : []);
  const subnetNsgs = nsgOn(isSubnetParent ? subnet?.id : undefined);
  const ownNsgs = nsgOn(node.id);
  const egressVia = (isSubnetParent ? subnet : kind === "subnet" ? node : undefined)?.metadata;
  const showNetwork = isSubnetParent || (kind !== "lb" && (nics.length > 0 || publics.length > 0)) || kind === "subnet";

  // ── metric rows with their trend ──
  const sparks = liveNode?.sparklines ?? {};
  const series = Object.values(sparks).find((s) => s.timestamps.length >= 2);
  const windowMin = series ? Math.max(1, Math.round((Date.parse(series.timestamps[series.timestamps.length - 1]!) - Date.parse(series.timestamps[0]!)) / 60000)) : 0;

  const privateIp = nics.find((s) => s.endpoint)?.endpoint ?? (node.endpoint && PRIVATE.test(node.endpoint) ? node.endpoint : undefined);
  const kindName = t(`ld.kind.${kind}`) === `ld.kind.${kind}` ? kind : t(`ld.kind.${kind}`);
  const incomingPe = spec.edges.filter((e) => e.edgeKind === "privateLink" && e.target === node.id).map((e) => e.source);
  const peTarget = spec.edges.find((e) => e.edgeKind === "privateLink" && e.source === node.id)?.target;
  const natSubnets = spec.edges.filter((e) => e.edgeKind === "natgw-association" && e.target === node.id).map((e) => e.source);
  const tags = Object.entries(node.tags ?? {});
  const sub = subscriptionOf(armId);

  return (
    <aside className={styles.detailPanel} aria-label={node.label}>
      <header className={styles.dpHeader}>
        {onBack && (alertCount > 0 || impacts.length > 0) ? (
          <button type="button" className={styles.dpBack} onClick={onBack}>← {t("ld.panel.back", { alerts: alertCount, impacts: impacts.length })}</button>
        ) : null}
        <div className={styles.dpTitleRow}>
          <img src={getAzureIconUrl(node.icon)} alt="" width={20} height={20} />
          <h2 className={styles.dpTitle} tabIndex={-1}>{nameOf(node.id)}</h2>
          <button type="button" className={styles.dpClose} onClick={onClose} aria-label={t("hb.close")}>✕</button>
        </div>
        <div className={styles.dpFullName}>
          {/* Short name's words bold inside the full name (masked names are shown as they are) */}
          <span className={styles.dpFullNameText}>{fullName === node.label && names.get(node.id) ? <NameParts parts={names.get(node.id)!.parts} /> : fullName}</span>
          <CopyButton value={node.label} />
        </div>
        <div className={styles.dpWhere}>
          {kindName}
          {isSubnetParent && subnet ? <> · <button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(subnet.id)}>{nameOf(subnet.id)}</button></> : null}
          {vnet ? <> › {vnet.label}</> : null}
          {node.metadata?.placement === "public-frontend" ? <> · {t("ld.panel.noSubnetPublic")}</> : null}
        </div>
        <div className={styles.dpStatusRow}>
          <Badge tone={status.tone}>{status.glyph} {t(status.key)}</Badge>
          {reason ? <span className={styles.dpReason}>{reason}</span> : null}
          {generatedAt ? <span className={styles.dpUpdated}>{t("ld.panel.updated", { when: ago(generatedAt) })}</span> : null}
        </div>
        {armId ? (
          <div className={styles.dpActions}>
            {portal ? <a className={styles.dpPortal} href={portal} target="_blank" rel="noreferrer">{t("ld.panel.portal")} ↗</a> : null}
            <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(armId).catch(() => undefined); }}>{t("ld.panel.copyId")}</Button>
          </div>
        ) : null}
      </header>

      <div className={styles.dpBody}>
        {/* Fault impact */}
        {role ? (
          <Section id="impact" title={t("ld.impact.title")}>
            {role === "source"
              ? (() => {
                  const fi = impacts.find((i) => i.sourceNodeId === node.id)!;
                  return (
                    <>
                      <div className={styles.dpMuted}>{t("ld.panel.impactSource", { n: fi.affectedNodeIds.length })}</div>
                      {fi.affectedNodeIds.map((id) => (
                        <button key={id} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(id)}>
                          <span className={styles.dpConnArrow}>▲</span><span className={styles.dpConnPeer}>{nameOf(id)}</span>
                        </button>
                      ))}
                    </>
                  );
                })()
              : impacts.filter((i) => i.affectedNodeIds.includes(node.id)).map((i) => (
                  <button key={i.sourceNodeId} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(i.sourceNodeId)}>
                    <span className={styles.dpConnArrow}>■</span><span className={styles.dpConnRel}>{t("ld.panel.impactFrom")}</span><span className={styles.dpConnPeer}>{nameOf(i.sourceNodeId)}</span>
                  </button>
                ))}
          </Section>
        ) : null}

        {/* Alerts */}
        {alerts.length > 0 ? (
          <Section id="alerts" title={t("detail.alerts")} count={alerts.length}>
            {alerts.map((a) => (
              <div key={a.id} className={styles.dpTwoLine}>
                <span className={styles.dpTwoLineMain}>
                  <span className={styles.dpState} data-state={a.severity}>{a.severity === "critical" ? "■" : a.severity === "warning" ? "▲" : "●"} {t(`ld.sev.${a.severity}`)}</span> · {a.title}
                </span>
                <span className={styles.dpTwoLineSub}>{ago(a.firedAt)}{a.summary ? ` · ${a.summary}` : ""}</span>
              </div>
            ))}
            {alertRules.length ? <AlertRules rules={alertRules} /> : null}
          </Section>
        ) : (
          <StaticSection title={t("detail.alerts")} note={t("live.noAlerts")}>
            {alertRules.length ? <AlertRules rules={alertRules} inline /> : null}
          </StaticSection>
        )}

        {/* Metrics */}
        {bound.length > 0 ? (
          <Section id="metrics" title={t("detail.metrics")}>
            {bound.map((k) => {
              const v = metrics[k];
              const f = v != null ? formatMetric(k, v) : null;
              const s = sparks[k];
              return (
                <div key={k} className={styles.dpMetric}>
                  <span className={styles.dpLabel}>{t(METRIC_META[k]?.label ?? k)}</span>
                  <span className={styles.dpMetricVal} data-unmeasured={f ? undefined : "true"}>{f ? <>{f.value}<small>{f.unit}{f.unitKey ? t(f.unitKey) : ""}</small></> : t("ld.unmeasured")}</span>
                  {s && s.values.length >= 2 ? <Spark className={styles.dpSpark} values={s.values} domain={sparkDomain(k, s.values)} color="rgba(var(--accent-rgb), 0.85)" /> : <span className={styles.dpSpark} />}
                </div>
              );
            })}
            <div className={styles.dpFoot}>
              {series ? t("ld.panel.metricFoot", { min: windowMin, n: series.timestamps.length }) : t("ld.panel.metricFootNoTrend")}
            </div>
          </Section>
        ) : null}

        {/* Connections */}
        {configuredCount > 0 || (showInferred && groups.inferred.length) ? (
          <Section id="connections" title={t("detail.connections")} count={configuredCount}>
            {groupBlock("in", groups.in)}
            {groupBlock("out", groups.out)}
            {groupBlock("egress", groups.egress)}
            {groupBlock("privateLink", groups.privateLink)}
            {groupBlock("peering", groups.peering)}
            {showInferred && groups.inferred.length ? (
              <Section id="connections-inferred" title={t("ld.panel.conn.inferred")} count={groups.inferred.length} defaultOpen={false}>
                {groups.inferred.map(peerRow)}
              </Section>
            ) : null}
          </Section>
        ) : null}

        {/* Private Link use (observed in logs) */}
        <PrivateLinkUsageSection node={node} spec={spec} usage={usage} loading={usageLoading} nameOf={nameOf} onSelectNode={onSelectNode} />

        {/* Network */}
        {showNetwork ? (
          <Section id="network" title={t("ld.panel.network")}>
            {isSubnetParent && subnet ? <KV label={t("ld.panel.where")}>{nameOf(subnet.id)}{vnet ? ` › ${vnet.label}` : ""}</KV> : null}
            {(isSubnetParent ? subnet : kind === "subnet" ? node : undefined)?.metadata?.prefix ? <KV label={t("ld.panel.subnetCidr")} mono>{(isSubnetParent ? subnet : node)!.metadata!.prefix}</KV> : null}
            {kind !== "lb" && nics.length ? (
              <KV label={t("ld.card.nics", { n: nics.length })}>
                {nics.slice(0, 4).map((n) => {
                  const s = subnetForIp(n.endpoint);
                  return <span key={n.id} className={styles.dpLine}><span data-mono="true">{n.endpoint ?? t("ld.panel.unknownValue")}</span>{" "}<span className={styles.dpMuted}>{s ? nameOf(s.id) : t("ld.panel.subnetUnknown")}</span></span>;
                })}
                {nics.length > 4 ? <span className={styles.dpMuted}>{t("ld.panel.more", { n: nics.length - 4 })}</span> : null}
              </KV>
            ) : null}
            {kind !== "lb" && publics.length ? <KV label={t("ld.panel.publicIp")} mono copy={publics[0]!.endpoint}>{publics.map((p) => p.endpoint).join(", ")}</KV> : null}
            {subnetNsgs.map((n) => <KV key={n.id} label={t("ld.panel.subnetNsg")}><button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(n.id)}>{n.label}</button></KV>)}
            {ownNsgs.map((n) => <KV key={n.id} label={t("ld.panel.nicNsg")}><button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(n.id)}>{n.label}</button></KV>)}
            {egressVia?.egressVia ? <KV label={t("ld.lane.egress")}>{egressVia.egressVia === "nat" ? t("ld.egress.nat", { name: egressVia.egressName ?? "" }) : t(`ld.egress.${egressVia.egressVia}`)}</KV> : null}
            {kind === "subnet" ? <KV label={t("ld.panel.cards")}>{spec.nodes.filter((n) => n.parentId === node.id && n.nodeType !== "group").length}</KV> : null}
          </Section>
        ) : null}

        {/* Kind-specific */}
        {(kind === "lb" || kind === "appGateway") ? (
          <>
            <Section id="frontend" title={t("ld.panel.frontend")}>
              {gwFrontends.length ? gwFrontends.map((f) => (
                <KV key={f.name} label={t(`ld.panel.frontend.${f.kind}`)} mono copy={f.ip}>
                  {`${f.ip ?? t("ld.panel.unknownValue")} · ${f.ruleBound ? t("ld.panel.frontend.listeners", { n: f.listeners.length }) : t("ld.panel.frontend.unused")}`}
                </KV>
              )) : frontends.length ? frontends.map((f) => (
                <KV key={f.id} label={f.endpoint && PRIVATE.test(f.endpoint) ? t("ld.card.internal") : t("ld.card.public")} mono copy={f.endpoint}>{f.endpoint ?? t("ld.panel.unknownValue")}</KV>
              )) : <div className={styles.dpMuted}>{t("ld.panel.unknownValue")}</div>}
              {kind === "appGateway" && frontends.length && frontends.every((f) => f.endpoint && PRIVATE.test(f.endpoint)) ? <div className={styles.dpMuted}>{t("ld.panel.noInternetEntry")}</div> : null}
            </Section>
            <Section id="backend" title={t("detail.backendPool")}>
              <BackendPools pools={backend.pools} loading={backend.loading} failed={backend.failed} />
              {unresolved.length ? (
                <Group title={t("ld.chip.unresolvedBackends", { n: unresolved.length })}>
                  {unresolved.map((u, i) => (
                    <KV key={`${u.pool}-${u.address}-${i}`} label={u.pool} mono>{`${u.address} — ${t(`ld.backend.reason.${u.reason}`)}`}</KV>
                  ))}
                </Group>
              ) : null}
            </Section>
          </>
        ) : null}
        {kind === "nsg" ? <NsgRules nsg={nsgDetail.nsg} loading={nsgDetail.loading} failed={nsgDetail.failed} /> : null}
        {kind === "agc" ? <AgcFacts node={node} /> : null}
        {kind === "frontDoor" ? <FrontDoorFacts node={node} /> : null}
        {kind === "aks" && archRole === "aks-control-plane" ? <AksApiEndpoint node={node} /> : null}
        {kind === "aks" && archRole !== "aks-control-plane" ? <AksCluster detail={aks.detail} loading={aks.loading} failed={aks.failed} /> : null}
        {archRole === "aks-vmss" ? <AksNodePool node={node} instances={vmss.instances} loading={vmss.loading} failed={vmss.failed} /> : null}
        {kind === "privateEndpoint" && peTarget ? (
          <Section id="pe" title={t("ld.panel.peTarget")}>
            <button type="button" className={styles.dpConn} onClick={() => onSelectNode?.(peTarget)}>
              <span className={styles.dpConnArrow}>→</span><span className={styles.dpConnRel}>Private Link</span><span className={styles.dpConnPeer}>{nameOf(peTarget)}</span>
            </button>
            {privateIp ? <KV label={t("ld.panel.privateIp")} mono copy={privateIp}>{privateIp}</KV> : null}
          </Section>
        ) : null}
        {incomingPe.length ? (
          <Section id="pe-in" title={t("ld.panel.incomingPe")} count={incomingPe.length}>
            {incomingPe.map((id) => {
              const pe = byId.get(id);
              const s = pe?.parentId ? byId.get(pe.parentId) : undefined;
              return (
                <button key={id} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(id)}>
                  <span className={styles.dpConnArrow}>←</span><span className={styles.dpConnPeer}>{s ? `${nameOf(s.id)} › ` : ""}{nameOf(id)}</span>
                </button>
              );
            })}
          </Section>
        ) : null}
        {kind === "natGateway" ? (
          <Section id="nat" title={t("ld.panel.natSubnets")} count={natSubnets.length}>
            {natSubnets.map((id) => (
              <button key={id} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(id)}>
                <span className={styles.dpConnArrow}>←</span><span className={styles.dpConnPeer}>{nameOf(id)}</span>
              </button>
            ))}
            {publics.length ? <KV label={t("ld.panel.publicIp")} mono>{publics.map((p) => p.endpoint).join(", ")}</KV> : null}
          </Section>
        ) : null}

        {/* Properties (folded) */}
        <Section id="properties" title={t("ld.panel.properties")} defaultOpen={false}>
          <KV label={t("detail.kind")}>{kindName}</KV>
          {node.location ? <KV label={t("detail.location")}>{formatAzureRegion(node.location)} ({node.location})</KV> : null}
          {node.resourceGroup ? <KV label={t("detail.resourceGroup")} copy={node.resourceGroup}>{node.resourceGroup}</KV> : null}
          {sub ? <KV label={t("ld.panel.subscription")} mono copy={sub}>{maskGuids(sub)}</KV> : null}
          {armId ? <KV label={t("detail.azureId")} mono copy={armId}>{maskGuids(shortArmId(armId))}</KV> : null}
          {node.metadata?.placement === "rg-guess" ? <div className={styles.dpMuted}>{t("ld.panel.rgGuess")}</div> : null}
          {tags.length ? (
            <KV label={t("ld.panel.tags", { n: tags.length })}>
              <span className={styles.dpChips}>{tags.map(([k, v]) => <span key={k} className={styles.dpTag}>{k}: {maskGuids(v)}</span>)}</span>
            </KV>
          ) : null}
        </Section>
      </div>
    </aside>
  );
}

function passes(value: number, r: HealthRule): boolean {
  switch (r.op) {
    case "<": return value < r.threshold;
    case "<=": return value <= r.threshold;
    case ">": return value > r.threshold;
    case ">=": return value >= r.threshold;
    case "==": return Math.abs(value - r.threshold) < 0.001;
    default: return true;
  }
}

function AlertRules({ rules, inline }: { rules: AlertRuleInfo[]; inline?: boolean }) {
  const { t } = useI18n();
  const body = rules.map((r) => (
    <div key={r.id} className={styles.dpTwoLine}>
      <span className={styles.dpTwoLineMain}>{t(`ld.sevNum.${Math.min(4, Math.max(0, r.severity))}`)} (Sev{r.severity}) · {r.name}{!r.enabled ? ` · ${t("detail.disabled")}` : ""}</span>
      {r.condition ? <span className={styles.dpTwoLineSub}>{r.condition}</span> : null}
    </div>
  ));
  if (inline) {
    return (
      <details className={styles.dpInlineDetails}>
        <summary>{t("ld.panel.alertRules", { n: rules.length })}</summary>
        {body}
      </details>
    );
  }
  return <Section id="alert-rules" title={t("detail.alertRules")} count={rules.length} defaultOpen={false}>{body}</Section>;
}

/** An AKS node (VMSS instance) clicked on the canvas — only what Azure / Kubernetes reported */
function VmssInstancePanel({ data, onClose }: { data: VmssInstancePanelData; onClose: () => void }) {
  const { t } = useI18n();
  const power = ["running", "stopped", "deallocated", "starting", "stopping"].includes(data.powerState) ? `ld.power.${data.powerState}` : "ld.power.unknown";
  const poolName = data.nodePoolName ?? data.parentVmssId.split("/").pop()?.replace(/^aks-/, "").replace(/-[0-9a-f]+-vmss$/i, "") ?? data.parentVmssId;
  const conditions = data.conditions ? Object.fromEntries(data.conditions.map((c) => [c.type, c])) : null;
  return (
    <aside className={styles.detailPanel} aria-label={data.computerName}>
      <header className={styles.dpHeader}>
        <div className={styles.dpTitleRow}>
          <img src={getAzureIconUrl("vm")} alt="" width={20} height={20} />
          <h2 className={styles.dpTitle} tabIndex={-1}>{data.computerName}</h2>
          <button type="button" className={styles.dpClose} onClick={onClose} aria-label={t("hb.close")}>✕</button>
        </div>
        <div className={styles.dpWhere}>{t("ld.node.subtitle")} · {poolName}</div>
        <div className={styles.dpStatusRow}><Badge tone={data.powerState === "running" ? "neutral" : "medium"}>{t(power)}</Badge></div>
      </header>
      <div className={styles.dpBody}>
        <Section id="vmss-node" title={t("ld.node.essentials")}>
          <KV label={t("ld.node.provisioning")}>{data.provisioningState ? (PROV.includes(data.provisioningState) ? t(`ld.prov.${data.provisioningState}`) : data.provisioningState) : t("ld.panel.unknownValue")}</KV>
          <KV label={t("ld.node.pool")}>{poolName}</KV>
          <KV label={t("ld.node.internalIp")} mono>{data.privateIp ?? t("ld.panel.unknownValue")}</KV>
          <KV label={t("ob.externalIp")}>{t("ld.panel.unknownValue")}</KV>
          <KV label={t("ld.node.hostname")} mono>{data.computerName}</KV>
          {data.nodeImageVersion ? <KV label={t("ld.node.image")} mono>{data.nodeImageVersion}</KV> : null}
        </Section>
        <Section id="vmss-conditions" title={t("ld.node.conditions")}>
          {(["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"] as const).map((type) => {
            if (conditions) {
              const c = conditions[type];
              const normal = type === "Ready" ? c?.status === "True" : c?.status === "False";
              return <KV key={type} label={t(`ld.cond.${type}`)}><span className={styles.dpState} data-state={!c ? "unknown" : normal ? "healthy" : "unhealthy"} title={c?.message}>{t(!c ? "ld.cond.unknown" : normal ? "ld.cond.normal" : "ld.cond.abnormal")}</span></KV>;
            }
            // No Kubernetes data: Azure state only — marked as an estimate, never green
            return <KV key={type} label={t(`ld.cond.${type}`)}><span className={styles.dpState} data-state="unknown">{t("ld.cond.unknown")}</span> <span className={styles.dpTag}>{t("ld.panel.estimate")}</span></KV>;
          })}
        </Section>
      </div>
    </aside>
  );
}

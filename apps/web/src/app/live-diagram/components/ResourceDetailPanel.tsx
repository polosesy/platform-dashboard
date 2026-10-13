import { useState, useCallback } from "react";
import type {
  DiagramNodeSpec,
  DiagramEdgeSpec,
  LiveNode,
  LiveEdge,
  LiveAlert,
  AlertRuleInfo,
  HealthStatus,
  PowerState,
  SparklineData,
  SubResource,
  NsgInfo,
  BackendPoolInfo,
  AksPlaneDetail,
  AksNodePoolInfo,
  AksExposurePathInfo,
  AksVmssInstance,
  AksNodeCondition,
} from "@aud/types";
import { nodeColor, defaultTokens } from "../utils/designTokens";
import { getAzureIconUrl } from "../utils/azureIcons";
import { fmtMetric } from "./LiveNode";
import { D3Sparkline } from "./D3Sparkline";
import { useI18n } from "@/lib/i18n";
import { localizeLabel } from "../utils/localizeLabel";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import styles from "../styles.module.css";
import { hex, rgba } from "@/lib/palette";

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
  nodeSpec: DiagramNodeSpec | null;
  liveNode: LiveNode | null;
  alerts: LiveAlert[];
  alertRules: AlertRuleInfo[];
  connectedEdges: ConnectedEdge[];
  onClose: () => void;
  vmssInstance?: VmssInstancePanelData | null;
};

const healthLabel: Record<HealthStatus, string> = {
  ok: "Healthy",
  warning: "Warning",
  critical: "Critical",
  unknown: "Unknown",
};

/** Map internal resource kind to display name */
export const RESOURCE_KIND_DISPLAY: Record<string, string> = {
  vnet: "Virtual Network",
  subnet: "Subnet",
  nsg: "Network Security Group",
  nic: "Network Interface",
  vm: "Virtual Machine",
  vmss: "VM Scale Set",
  aks: "Azure Kubernetes Service",
  containerApp: "Container App",
  appGateway: "Application Gateway",
  lb: "Load Balancer",
  frontDoor: "Front Door",
  trafficManager: "Traffic Manager",
  privateEndpoint: "Private Endpoint",
  storage: "Storage Account",
  sql: "SQL Database",
  cosmosDb: "Cosmos DB",
  redis: "Azure Cache for Redis",
  postgres: "PostgreSQL",
  keyVault: "Key Vault",
  appInsights: "Application Insights",
  logAnalytics: "Log Analytics Workspace",
  firewall: "Azure Firewall",
  functionApp: "Function App",
  appService: "App Service",
  serviceBus: "Service Bus",
  eventHub: "Event Hub",
  natGateway: "NAT Gateway",
  publicIP: "Public IP Address",
};

const POWER_STATE_LABEL: Record<PowerState, string> = {
  running: "Running",
  stopped: "Stopped",
  deallocated: "Deallocated",
  starting: "Starting",
  stopping: "Stopping",
  unknown: "Unknown",
};

/** Resource kinds that have no meaningful operational state */
const HIDE_STATUS_KINDS = new Set([
  "vnet", "subnet", "nsg", "nic", "dns", "privateEndpoint",
]);

function truncateId(id: string, maxLen = 60): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "...";
}

/** Value display with copy-to-clipboard on hover */
function CopyableValue({
  value,
  className,
  title,
  style,
  children,
}: {
  value: string;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);

  return (
    <span className={`${styles.copyableWrap} ${className ?? ""}`} title={title} style={style}>
      <span className={styles.copyableText}>{children ?? value}</span>
      <button
        type="button"
        className={styles.copyBtn}
        onClick={handleCopy}
        aria-label={t("ld.copy")}
      >
        {copied ? "\u2713" : "\u2398"}
      </button>
    </span>
  );
}

function fmtRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.max(0, Math.floor(diff / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtThroughput(bps: number | undefined): string {
  if (bps == null) return "-";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

const SEVERITY_LABELS: Record<number, string> = {
  0: "Sev0 (Critical)",
  1: "Sev1 (Error)",
  2: "Sev2 (Warning)",
  3: "Sev3 (Informational)",
  4: "Sev4 (Verbose)",
};

const SEVERITY_COLORS: Record<number, string> = {
  0: hex("danger"),
  1: hex("egress"),
  2: hex("warning"),
  3: hex("accent"),
  4: rgba("ink", 0.45),
};

// ── Backend Pool Detail Section (LB / Application Gateway) ──

const BACKEND_POOL_KINDS = new Set(["lb", "appGateway"]);

function useBackendPool(azureResourceId: string | undefined, resourceKind: string | undefined) {
  const enabled = !!azureResourceId && !!resourceKind && BACKEND_POOL_KINDS.has(resourceKind);
  const { data, error, loading } = useApiQuery(
    enabled ? `backend-pool:${resourceKind}:${azureResourceId}` : null,
    (token) =>
      fetchJsonWithBearer<{ pools: BackendPoolInfo[] }>(apiUrl("/api/live/backend-pool", { resourceId: azureResourceId, resourceKind }), token),
    { tokenOptional: true },
  );
  return { pools: enabled && !loading && !error ? (data?.pools ?? []) : [], loading };
}

const MEMBER_STATE_COLOR: Record<string, string> = {
  Healthy: hex("ok"),
  Unhealthy: hex("danger"),
  Unknown: rgba("ink", 0.45),
};

function BackendPoolSection({ pools, loading }: { pools: BackendPoolInfo[]; loading: boolean }) {
  const { t } = useI18n();

  if (loading) {
    return (
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>{t("detail.backendPool")}</div>
        <div className={styles.detailEmpty}>{t("live.loading")}</div>
      </div>
    );
  }

  if (pools.length === 0) return null;

  return (
    <>
      {pools.map((pool) => (
        <div key={pool.name} className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>{t("detail.backendPool")}</div>
          <div className={styles.essentialsList}>
            {/* Pool Name */}
            <div className={styles.essentialsRow}>
              <span className={styles.essentialsLabel}>{t("detail.backendPool.name")}</span>
              <span className={styles.essentialsValue}>{pool.name}</span>
            </div>

            {/* LB Rules */}
            {pool.loadBalancingRules && pool.loadBalancingRules.length > 0 && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.backendPool.rules")}</span>
                <div className={styles.backendPoolRuleTags}>
                  {pool.loadBalancingRules.map((r) => (
                    <span key={r} className={styles.backendPoolRuleTag}>{r}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Health Probe */}
            {pool.probe && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.backendPool.probe")}</span>
                <span className={styles.essentialsValue}>
                  {pool.probe.protocol}/{pool.probe.port}
                  {pool.probe.path ? ` ${pool.probe.path}` : ""}
                  {" · "}{pool.probe.intervalSec}s
                  {" · "}{pool.probe.unhealthyThreshold}x
                </span>
              </div>
            )}
          </div>

          {/* Members */}
          <div className={styles.backendPoolMemberHeader}>
            {t("detail.backendPool.members")} ({pool.members.length})
          </div>
          <div className={styles.backendPoolMemberList}>
            {pool.members.map((m, i) => (
              <div key={`${m.name}-${i}`} className={styles.backendPoolMemberRow}>
                <span
                  className={styles.backendPoolMemberState}
                  style={{ color: MEMBER_STATE_COLOR[m.state ?? "Unknown"] }}
                  title={m.state}
                >
                  {m.state === "Healthy" ? "●" : m.state === "Unhealthy" ? "●" : "○"}
                </span>
                <span className={styles.backendPoolMemberName}>{m.name}</span>
                <span className={styles.backendPoolMemberAddr}>
                  {m.ipAddress ?? m.fqdn ?? ""}
                  {m.port ? `:${m.port}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ── NSG Rules Detail Section ──

function useNsgDetail(azureResourceId: string | undefined, resourceKind: string | undefined) {
  const enabled = resourceKind === "nsg" && !!azureResourceId;
  const { data, error, loading } = useApiQuery(
    enabled ? `nsg-detail:${azureResourceId}` : null,
    (token) => fetchJsonWithBearer<NsgInfo>(apiUrl("/api/live/nsg-detail", { resourceId: azureResourceId }), token),
    { tokenOptional: true },
  );
  return { nsg: enabled && !loading && !error ? (data ?? null) : null, loading };
}

function NsgRulesSection({ nsg, loading }: { nsg: NsgInfo | null; loading: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"Inbound" | "Outbound">("Inbound");

  if (loading) {
    return (
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>{t("detail.nsgRules")}</div>
        <div className={styles.detailEmpty}>{t("live.loading")}</div>
      </div>
    );
  }

  if (!nsg) return null;

  const inbound = nsg.effectiveRules.filter(r => r.direction === "Inbound").sort((a, b) => a.priority - b.priority);
  const outbound = nsg.effectiveRules.filter(r => r.direction === "Outbound").sort((a, b) => a.priority - b.priority);
  const rules = tab === "Inbound" ? inbound : outbound;

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>{t("detail.nsgRules")}</div>

      {/* Tab selector */}
      <div className={styles.nsgTabBar}>
        <button
          type="button"
          className={`${styles.nsgTab} ${tab === "Inbound" ? styles.nsgTabActive : ""}`}
          onClick={() => setTab("Inbound")}
        >
          {t("detail.inbound")} ({inbound.length})
        </button>
        <button
          type="button"
          className={`${styles.nsgTab} ${tab === "Outbound" ? styles.nsgTabActive : ""}`}
          onClick={() => setTab("Outbound")}
        >
          {t("detail.outbound")} ({outbound.length})
        </button>
      </div>

      {/* Column header */}
      <div className={styles.nsgRuleHeader}>
        <span>{t("detail.nsgAccess")}</span>
        <span>{t("detail.nsgProto")}</span>
        <span>{t("detail.nsgPort")}</span>
        <span>{t("detail.nsgSource")}</span>
        <span>{t("detail.nsgDest")}</span>
        <span>{t("detail.nsgPriority")}</span>
      </div>

      {/* Rules list */}
      <div className={styles.nsgRulesList}>
        {rules.map((rule) => (
          <div
            key={`${rule.direction}-${rule.priority}-${rule.name}`}
            className={`${styles.nsgDetailRule} ${rule.access === "Allow" ? styles.nsgDetailRuleAllow : styles.nsgDetailRuleDeny}`}
            title={rule.name}
          >
            <span className={styles.nsgDetailAccess}>
              {rule.access === "Allow" ? "✓" : "✕"}
            </span>
            <span className={styles.nsgDetailProto}>{rule.protocol}</span>
            <span className={styles.nsgDetailPort}>{rule.destinationPortRange}</span>
            <span className={styles.nsgDetailAddr} title={rule.sourceAddressPrefix}>
              {rule.sourceAddressPrefix.length > 18 ? rule.sourceAddressPrefix.slice(0, 16) + "…" : rule.sourceAddressPrefix}
            </span>
            <span className={styles.nsgDetailAddr} title={rule.destinationAddressPrefix}>
              {rule.destinationAddressPrefix.length > 18 ? rule.destinationAddressPrefix.slice(0, 16) + "…" : rule.destinationAddressPrefix}
            </span>
            <span className={styles.nsgDetailPriority}>{rule.priority}</span>
          </div>
        ))}
      </div>

      {/* Rule name legend at bottom */}
      {rules.length > 0 && (
        <div className={styles.nsgRuleNameList}>
          {rules.map((rule) => (
            <div
              key={`${rule.direction}-${rule.priority}-${rule.name}-label`}
              className={styles.nsgRuleNameItem}
            >
              <span className={`${styles.nsgRuleNameDot} ${rule.access === "Allow" ? styles.nsgRuleNameDotAllow : styles.nsgRuleNameDotDeny}`} />
              <span className={styles.nsgRuleNamePri}>{rule.priority}</span>
              <span className={styles.nsgRuleNameText}>{rule.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AKS Plane Detail (접속면 / 실행면 / 노출면) ──

function useAksPlaneDetail(azureResourceId: string | undefined, resourceKind: string | undefined, archRole: string | undefined) {
  // Only fetch for real AKS cluster nodes, not synthetic API Endpoint nodes
  const enabled = resourceKind === "aks" && !!azureResourceId && archRole !== "aks-control-plane";
  const { data, error, loading } = useApiQuery(
    enabled ? `aks-plane:${azureResourceId}` : null,
    (token) => fetchJsonWithBearer<AksPlaneDetail>(apiUrl("/api/live/aks-plane", { resourceId: azureResourceId }), token),
    { tokenOptional: true },
  );
  return { detail: enabled && !loading && !error ? (data ?? null) : null, loading };
}

// ── VMSS Instance list (for AKS nodepool VMSS) ──

function useVmssInstances(azureResourceId: string | undefined, archRole: string | undefined) {
  const enabled = archRole === "aks-vmss" && !!azureResourceId;
  const { data, error, loading } = useApiQuery(
    enabled ? `vmss-instances:${azureResourceId}` : null,
    (token) =>
      fetchJsonWithBearer<{ instances: AksVmssInstance[] }>(apiUrl("/api/live/vmss-instances", { resourceId: azureResourceId }), token),
    { tokenOptional: true },
  );
  return { instances: enabled && !loading && !error ? (data?.instances ?? []) : [], loading };
}

const EXPOSURE_ROLE_ICON: Record<string, string> = {
  lb: "LB",
  "nat-gateway": "NAT",
  firewall: "FW",
  "public-ip": "PIP",
  "app-gateway": "AGW",
  service: "Svc",
  "ingress-controller": "Ing",
};

// ── AKS Essentials (클러스터 정보 — 접속면 포함) ──

function AksEssentialsSection({ detail }: { detail: AksPlaneDetail }) {
  const { t } = useI18n();
  const cp = detail.controlPlane;
  const np = detail.networkProfile;

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>{t("ld.aks.info")}</div>
      <div className={styles.essentialsList}>
        {/* API 서버 주소 */}
        <div className={styles.aksApiServerRow}>
          <span className={styles.essentialsLabel}>{t("ld.aks.apiAddress")}</span>
          <CopyableValue value={cp.apiServerEndpoint} className={styles.aksApiServerFqdn}>
            {cp.apiServerEndpoint}
          </CopyableValue>
        </div>

        {/* 네트워크 구성 */}
        {np && (
          <>
            <div className={styles.essentialsRow}>
              <span className={styles.essentialsLabel}>{t("ld.aks.network")}</span>
              <span className={styles.essentialsValue}>
                {np.networkPlugin === "azure" ? "Azure CNI" : np.networkPlugin}
                {np.networkPolicy ? ` + ${np.networkPolicy}` : ""}
              </span>
            </div>
            {np.podCidr && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>Pod CIDR</span>
                <span className={styles.essentialsValueMono}>{np.podCidr}</span>
              </div>
            )}
            {np.serviceCidr && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.aks.serviceCidr")}</span>
                <span className={styles.essentialsValueMono}>{np.serviceCidr}</span>
              </div>
            )}
            {np.dnsServiceIp && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.aks.dnsIp")}</span>
                <span className={styles.essentialsValueMono}>{np.dnsServiceIp}</span>
              </div>
            )}
            {np.networkPolicy && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.aks.policyEngine")}</span>
                <span className={styles.essentialsValue}>{np.networkPolicy}</span>
              </div>
            )}
            {np.loadBalancerSku && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.aks.lb")}</span>
                <span className={styles.essentialsValue}>{np.loadBalancerSku}</span>
              </div>
            )}
          </>
        )}

        {/* 프라이빗 클러스터 */}
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.aks.private")}</span>
          <span className={styles.essentialsValue}>
            {cp.isPrivateCluster ? (
              <span className={styles.aksAccessBadge} data-private="true">{t("ld.on")}</span>
            ) : (
              t("ld.off")
            )}
          </span>
        </div>

        {/* 권한 있는 IP 범위 */}
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.aks.authorizedIps")}</span>
          <span className={styles.essentialsValue}>
            {cp.authorizedIpRanges && cp.authorizedIpRanges.length > 0
              ? cp.authorizedIpRanges.join(", ")
              : t("ld.off")}
          </span>
        </div>

        {cp.privateFqdn && (
          <div className={styles.essentialsRow}>
            <span className={styles.essentialsLabel}>Private FQDN</span>
            <CopyableValue value={cp.privateFqdn} className={styles.essentialsValueMono}>
              {cp.privateFqdn}
            </CopyableValue>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 실행면 (NODE POOLS) ──

function AksNodePoolSection({ pools }: { pools: AksNodePoolInfo[] }) {
  const { t } = useI18n();
  const [expandedPool, setExpandedPool] = useState<string | null>(null);

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>
        {t("ld.aks.nodePools", { n: pools.length })}
      </div>
      {pools.map((pool) => {
        const isExpanded = expandedPool === pool.name;
        return (
          <div key={pool.name} className={styles.aksNodePoolCard}>
            <button
              type="button"
              className={styles.aksNodePoolHeader}
              onClick={() => setExpandedPool(isExpanded ? null : pool.name)}
            >
              <span className={styles.aksPoolModeBadge} data-mode={pool.mode}>
                {pool.mode}
              </span>
              <span className={styles.aksPoolName}>{pool.name}</span>
              <span
                className={styles.aksPoolPowerDot}
                data-state={pool.powerState.toLowerCase()}
              />
              <span className={styles.toggleChevron}>
                {isExpanded ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {/* Summary: vmSize · OS · version · AZ */}
            <div className={styles.aksPoolSummary}>
              <span>{pool.vmSize}</span>
              <span>{pool.osType}{pool.osSKU ? ` (${pool.osSKU})` : ""}</span>
              {pool.orchestratorVersion && <span>v{pool.orchestratorVersion}</span>}
              {pool.availabilityZones && (
                <span>AZ: {pool.availabilityZones.join(",")}</span>
              )}
            </div>
            {/* Node count + autoscale */}
            <div className={styles.aksPoolSummary}>
              <span>
                {t("hb.node")}: {pool.nodeCount}
                {pool.enableAutoScaling && ` (auto ${pool.minCount ?? 0}–${pool.maxCount ?? 0})`}
              </span>
            </div>
            {/* Expanded: VMSS instances */}
            {isExpanded && pool.vmssInstances && pool.vmssInstances.length > 0 && (
              <VmssInstanceGrid instances={pool.vmssInstances} poolName={pool.name} />
            )}
            {isExpanded && (!pool.vmssInstances || pool.vmssInstances.length === 0) && (
              <div className={styles.detailEmpty}>
                {t("ld.aks.noVmss")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── VMSS Instance Grid (트리 형태 — AKS 노드풀 + VMSS 노드 공유) ──

function VmssInstanceGrid({ instances, poolName }: { instances: AksVmssInstance[]; poolName?: string }) {
  return (
    <div className={styles.aksVmssInstanceList}>
      {poolName && (
        <div className={styles.aksInstanceTreeRoot}>
          {poolName}
        </div>
      )}
      {instances.map((inst, idx) => {
        const isLast = idx === instances.length - 1;
        return (
          <div key={inst.instanceId} className={styles.aksInstanceTreeRow}>
            <span className={styles.aksInstanceTreeBranch}>
              {isLast ? "└" : "├"}
            </span>
            <span className={styles.aksVmssInstanceName}>
              {inst.computerName || `instance-${inst.instanceId}`}
            </span>
            <span className={styles.aksVmssInstanceState} data-state={inst.powerState}>
              {inst.powerState === "running" ? "●" : "○"} {inst.powerState}
            </span>
            <span className={styles.essentialsValueMono}>
              {inst.privateIp ?? "-"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 노출면 (Ingress / Egress) ──

function AksExposureSection({ paths }: { paths: AksExposurePathInfo[] }) {
  const { t } = useI18n();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const ingressPaths = paths.filter((p) => p.direction === "ingress");
  const egressPaths = paths.filter((p) => p.direction === "egress");

  const renderGroup = (groupPaths: AksExposurePathInfo[], dir: "ingress" | "egress") => (
    <div className={styles.aksExposureGroup}>
      <div className={styles.aksExposureGroupLabel}>{dir === "ingress" ? "Ingress" : "Egress"}</div>
      {groupPaths.map((path, idx) => {
        const key = `${dir}-${idx}`;
        const isExp = expandedPath === key;
        return (
          <div key={key} className={styles.aksExposureCard}>
            <button
              type="button"
              className={styles.aksExposureHeader}
              onClick={() => setExpandedPath(isExp ? null : key)}
            >
              <span className={styles.aksExposureDirBadge} data-dir={dir}>
                {dir === "ingress" ? "IN" : "OUT"}
              </span>
              <span className={styles.aksExposureLabel}>{localizeLabel(path.label, t)}</span>
              <span className={styles.toggleChevron}>{isExp ? "\u25B2" : "\u25BC"}</span>
            </button>
            {isExp && (
              <div className={styles.aksExposureResources}>
                {path.resources.map((r, ri) => (
                  <div key={ri} className={styles.aksExposureResRow}>
                    <span className={styles.aksExposureRoleBadge}>
                      {EXPOSURE_ROLE_ICON[r.role] ?? r.role}
                    </span>
                    <span>{r.name}</span>
                    {r.endpoint && <span className={styles.essentialsValueMono}>{r.endpoint}</span>}
                    {r.sku && <span className={styles.aksExposureSku}>{r.sku}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>{t("ld.aks.exposure")}</div>
      {ingressPaths.length > 0 && renderGroup(ingressPaths, "ingress")}
      {egressPaths.length > 0 && renderGroup(egressPaths, "egress")}
      {paths.length === 0 && <div className={styles.detailEmpty}>{t("ld.aks.noPaths")}</div>}
    </div>
  );
}

// ── AKS API Endpoint 노드 (접속면 카드, 캔버스 외부 노드 클릭 시) ──

function AksApiEndpointSection({ nodeSpec }: { nodeSpec: DiagramNodeSpec }) {
  const { t } = useI18n();
  const meta = nodeSpec.metadata ?? {};
  const fqdn = meta.fqdn ?? "";
  const isPrivate = meta.isPrivateCluster === "true";
  const clusterName = meta.aksClusterName ?? "AKS Cluster";

  return (
    <div className={styles.aksPlaneContainer}>
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>{t("ld.aks.controlPlane")}</div>
        <div className={styles.essentialsList}>
          <div className={styles.essentialsRow}>
            <span className={styles.essentialsLabel}>{t("ins.ticket.cluster")}</span>
            <span className={styles.essentialsValue}>{clusterName}</span>
          </div>
          <div className={styles.aksApiServerRow}>
            <span className={styles.essentialsLabel}>{t("ld.aks.apiFqdn")}</span>
            <CopyableValue value={fqdn} className={styles.aksApiServerFqdn}>
              {fqdn}
            </CopyableValue>
          </div>
          <div className={styles.essentialsRow}>
            <span className={styles.essentialsLabel}>{t("ld.aks.accessType")}</span>
            <span className={styles.essentialsValue}>
              <span className={styles.aksAccessBadge} data-private={String(isPrivate)}>
                {isPrivate ? "Private" : "Public"}
              </span>
            </span>
          </div>
          <div className={styles.essentialsRow}>
            <span className={styles.essentialsLabel}>{t("ld.aks.accessPath")}</span>
            <span className={styles.essentialsValue}>
              {isPrivate ? "VNet / Private DNS → API Server" : "Internet → API Server"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── AKS 전체 플레인 섹션 (AKS 노드 클릭 시) ──

function AksPlaneDetailSection({
  detail,
  loading,
}: {
  detail: AksPlaneDetail | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>{t("ld.aks.clusterInfo")}</div>
        <div className={styles.detailEmpty}>{t("common.loading")}</div>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className={styles.aksPlaneContainer}>
      <AksEssentialsSection detail={detail} />
      <AksNodePoolSection pools={detail.nodePools} />
      <AksExposureSection paths={detail.exposurePaths} />
    </div>
  );
}

// ── AKS-VMSS 노드 클릭 시 (nodepool 상세 + 인스턴스 그리드) ──

function AksVmssDetailSection({
  nodeSpec,
  instances,
  loading,
}: {
  nodeSpec: DiagramNodeSpec;
  instances: AksVmssInstance[];
  loading: boolean;
}) {
  const { t } = useI18n();
  const meta = nodeSpec.metadata ?? {};
  const poolName = meta.nodepoolName;
  const poolMode = meta.nodepoolMode;
  const vmSize = meta.nodepoolVmSize;
  const nodeCount = meta.nodepoolCount;
  const autoScale = meta.nodepoolAutoScale;
  const powerState = meta.nodepoolPowerState;

  if (!poolName) return null;

  return (
    <div className={styles.aksPlaneContainer}>
      {/* Nodepool summary */}
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>{t("ld.pool.info")}</div>
        <div className={styles.essentialsList}>
          <div className={styles.essentialsRow}>
            <span className={styles.essentialsLabel}>{t("ld.pool.name")}</span>
            <span className={styles.essentialsValue}>
              {poolMode && (
                <span className={styles.aksPoolModeBadge} data-mode={poolMode}>
                  {poolMode}
                </span>
              )}{" "}
              {poolName}
            </span>
          </div>
          {vmSize && (
            <div className={styles.essentialsRow}>
              <span className={styles.essentialsLabel}>{t("ld.pool.vmSize")}</span>
              <span className={styles.essentialsValue}>{vmSize}</span>
            </div>
          )}
          {nodeCount && (
            <div className={styles.essentialsRow}>
              <span className={styles.essentialsLabel}>{t("ld.pool.nodes")}</span>
              <span className={styles.essentialsValue}>
                {nodeCount}
                {autoScale && ` (auto ${autoScale})`}
              </span>
            </div>
          )}
          {powerState && (
            <div className={styles.essentialsRow}>
              <span className={styles.essentialsLabel}>{t("hb.status")}</span>
              <span className={styles.essentialsValue}>
                <span
                  className={styles.aksPoolPowerDot}
                  data-state={powerState.toLowerCase()}
                  style={{ display: "inline-block", marginRight: 6, verticalAlign: "middle" }}
                />
                {powerState}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* VMSS Instances */}
      <div className={styles.detailSection}>
        <div className={styles.detailSectionTitle}>
          VMSS Instances ({loading ? "..." : instances.length})
        </div>
        {loading ? (
          <div className={styles.detailEmpty}>{t("ld.pool.loading")}</div>
        ) : instances.length > 0 ? (
          <VmssInstanceGrid instances={instances} poolName={poolName} />
        ) : (
          <div className={styles.detailEmpty}>
            {t("ld.pool.noInstances")}
          </div>
        )}
      </div>
    </div>
  );
}

export function ResourceDetailPanel({
  nodeSpec,
  liveNode,
  alerts,
  alertRules,
  connectedEdges,
  onClose,
  vmssInstance,
}: ResourceDetailPanelProps) {
  const { t } = useI18n();
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [alertRulesOpen, setAlertRulesOpen] = useState(true);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const { nsg: nsgDetail, loading: nsgLoading } = useNsgDetail(nodeSpec?.azureResourceId, nodeSpec?.resourceKind);
  const { pools: backendPools, loading: backendPoolLoading } = useBackendPool(nodeSpec?.azureResourceId, nodeSpec?.resourceKind);
  const vmssArchRole = nodeSpec?.metadata?.archRole;
  const { detail: aksPlaneDetail, loading: aksPlaneLoading } = useAksPlaneDetail(nodeSpec?.azureResourceId, nodeSpec?.resourceKind, vmssArchRole);
  const { instances: vmssInstances, loading: vmssInstancesLoading } = useVmssInstances(nodeSpec?.azureResourceId, vmssArchRole);
  const nodeOutboundType = nodeSpec?.metadata?.outboundType;

  // ── VMSS Instance detail (canvas instance node click) ──
  if (!nodeSpec && vmssInstance) {
    const INST_POWER_COLOR: Record<string, string> = {
      running: rgba("ok", 0.85), starting: rgba("accent", 0.85),
      stopping: rgba("warning", 0.85), stopped: rgba("warning", 0.85),
      deallocated: rgba("ink", 0.45), unknown: rgba("ink", 0.35),
    };
    const dotColor = INST_POWER_COLOR[vmssInstance.powerState] ?? INST_POWER_COLOR.unknown;
    // Node pool name: prefer explicit nodePoolName, fall back to parsing parentVmssId
    const poolName = vmssInstance.nodePoolName
      ?? vmssInstance.parentVmssId.split("/").pop()?.replace(/^aks-/, "").replace(/-[0-9a-f]+-vmss$/i, "")
      ?? vmssInstance.parentVmssId;
    const PROV_STATES = ["Succeeded", "Creating", "Updating", "Deleting", "Failed"];
    const provLabel = vmssInstance.provisioningState
      ? (PROV_STATES.includes(vmssInstance.provisioningState) ? t(`ld.prov.${vmssInstance.provisioningState}`) : vmssInstance.provisioningState)
      : t("ld.prov.Succeeded");
    // K8s conditions (from real K8s Node API), or fall back to ARM-derived estimate
    const k8sConditions = vmssInstance.conditions;
    const conditionMap = k8sConditions
      ? Object.fromEntries(k8sConditions.map((c) => [c.type, c]))
      : null;

    return (
      <aside className={styles.detailPanel}>
        <div className={styles.detailHeader}>
          <img src={getAzureIconUrl("vm")} alt="vm" className={styles.detailHeaderIcon} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className={styles.detailHeaderName}>{vmssInstance.computerName}</span>
            <div className={styles.detailHeaderSubtitle}>{t("ld.node.subtitle")}</div>
          </div>
          <div className={styles.detailHealthDot} style={{ background: dotColor }} title={vmssInstance.powerState} />
          <button className={styles.detailCloseBtn} onClick={onClose} type="button" aria-label={t("hb.close")}>&times;</button>
        </div>
        <div className={styles.detailBody}>
          {/* 필수 항목 — Azure portal 개요 기준 */}
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("ld.node.essentials")}</div>
            <div className={styles.essentialsList}>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("hb.status")}</span>
                <div>
                  <span className={styles.powerStateBadgeDetail} data-state={vmssInstance.powerState}>
                    {POWER_STATE_LABEL[vmssInstance.powerState as PowerState] ?? vmssInstance.powerState}
                  </span>
                </div>
              </div>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.node.provisioning")}</span>
                <span className={styles.essentialsValue}>{provLabel}</span>
              </div>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.node.pool")}</span>
                <span className={styles.essentialsValue}>{poolName}</span>
              </div>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.node.internalIp")}</span>
                <span className={styles.essentialsValueMono}>
                  {vmssInstance.privateIp ?? "—"}
                </span>
              </div>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ob.externalIp")}</span>
                <span className={styles.essentialsValue}>{t("ins.heat.none")}</span>
              </div>
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("ld.node.hostname")}</span>
                <span className={styles.essentialsValueMono}>{vmssInstance.computerName}</span>
              </div>
              {vmssInstance.nodeImageVersion && (
                <div className={styles.essentialsRow}>
                  <span className={styles.essentialsLabel}>{t("ld.node.image")}</span>
                  <span className={styles.essentialsValueMono}>{vmssInstance.nodeImageVersion}</span>
                </div>
              )}
              {(() => {
                const outboundType = nodeOutboundType;
                if (!outboundType) return null;
                const OUTBOUND_LABEL: Record<string, { label: string; badge: string }> = {
                  loadBalancer:            { label: "Load Balancer (SNAT)",      badge: "lb" },
                  userDefinedRouting:      { label: t("ld.out.udr"), badge: "udr" },
                  managedNATGateway:       { label: t("ld.out.managedNat"), badge: "nat" },
                  userAssignedNATGateway:  { label: t("ld.out.userNat"), badge: "nat" },
                };
                const info = OUTBOUND_LABEL[outboundType];
                return (
                  <div className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{t("ld.out.label")}</span>
                    <span
                      className={styles.outboundTypeBadge}
                      data-outbound={info?.badge ?? "other"}
                      title={`AKS outboundType: ${outboundType}`}
                    >
                      {info?.label ?? outboundType}
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
          {/* 조건 — K8s Node API 기반 (없으면 ARM 추정) */}
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("ld.node.conditions")}</div>
            <div className={styles.essentialsList}>
              {(["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"] as const).map((type) => {
                const CONDITION_LABEL: Record<string, string> = Object.fromEntries(
                  ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"].map((c) => [c, t(`ld.cond.${c}`)]),
                );
                if (conditionMap) {
                  const c = conditionMap[type];
                  // Ready=True is good; pressure/unavailable=False is good
                  const isNormal = type === "Ready" ? c?.status === "True" : c?.status === "False";
                  const condAttr = !c ? "unknown" : isNormal ? "true" : "false";
                  const label = !c ? t("ld.cond.unknown") : isNormal ? t("ld.cond.normal") : t("ld.cond.abnormal");
                  return (
                    <div key={type} className={styles.essentialsRow}>
                      <span className={styles.essentialsLabel}>{CONDITION_LABEL[type]}</span>
                      <div>
                        <span className={styles.nodeConditionBadge} data-condition={condAttr} title={c?.message}>
                          {label}
                        </span>
                      </div>
                    </div>
                  );
                }
                // Fallback: ARM-derived estimate (no K8s data)
                // Running+Succeeded node = all standard conditions assumed normal
                const armReady = vmssInstance.powerState === "running" && vmssInstance.provisioningState === "Succeeded";
                const condAttr = armReady ? "true" : (type === "Ready" ? "false" : "unknown");
                const label = armReady ? t("ld.cond.normal") : (type === "Ready" ? t("ld.cond.abnormal") : t("ld.cond.unknown"));
                return (
                  <div key={type} className={styles.essentialsRow}>
                    <span className={styles.essentialsLabel}>{CONDITION_LABEL[type]}</span>
                    <div>
                      <span className={styles.nodeConditionBadge} data-condition={condAttr}>
                        {label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>
    );
  }

  if (!nodeSpec) return null;

  const health: HealthStatus = liveNode?.health ?? "unknown";
  const powerState: PowerState | undefined = liveNode?.powerState;
  const colors = nodeColor(health);
  const metrics = liveNode?.metrics ?? {};
  const sparklines = liveNode?.sparklines;

  const metricEntries = Object.entries(metrics).filter(
    ([, v]) => v != null,
  );

  const sparklineEntries: [string, SparklineData][] = sparklines
    ? Object.entries(sparklines).filter(([, s]) => s.values.length >= 2)
    : [];

  const tags = nodeSpec.tags;
  const tagEntries = tags ? Object.entries(tags) : [];

  const kindDisplay = nodeSpec.resourceKind
    ? RESOURCE_KIND_DISPLAY[nodeSpec.resourceKind] ?? nodeSpec.resourceKind
    : undefined;

  return (
    <aside className={styles.detailPanel}>
      {/* Header */}
      <div className={styles.detailHeader}>
        <img
          src={getAzureIconUrl(nodeSpec.icon)}
          alt={nodeSpec.icon}
          className={styles.detailHeaderIcon}
        />
        <span className={styles.detailHeaderName}>{nodeSpec.label}</span>
        <div
          className={styles.detailHealthDot}
          style={{ background: colors.ringStroke }}
          title={healthLabel[health]}
        />
        <button
          className={styles.detailCloseBtn}
          onClick={onClose}
          type="button"
          aria-label={t("hb.close")}
        >
          &times;
        </button>
      </div>

      {/* Body */}
      <div className={styles.detailBody}>
        {/* ── Essentials (Azure Portal style) ── */}
        {/* For AKS nodes: minimal essentials (kind, location, RG, azureId) — real info comes from AksPlaneDetail */}
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>{t("detail.essentials")}</div>
          <div className={styles.essentialsList}>
            {kindDisplay && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.kind")}</span>
                <CopyableValue value={kindDisplay} className={styles.essentialsValue}>
                  {kindDisplay}
                </CopyableValue>
              </div>
            )}
            {/* AKS/VMSS: skip generic status — shown in plane detail */}
            {!HIDE_STATUS_KINDS.has(nodeSpec.resourceKind ?? "") && nodeSpec.resourceKind !== "aks" && vmssArchRole !== "aks-vmss" && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.status")}</span>
                <span className={styles.essentialsValue}>
                  {powerState && powerState !== "unknown" ? (
                    <span className={styles.powerStateBadgeDetail} data-state={powerState}>
                      {POWER_STATE_LABEL[powerState]}
                    </span>
                  ) : (
                    <span style={{ color: colors.ringStroke }}>
                      {healthLabel[health]}
                      {liveNode ? ` (${(liveNode.healthScore * 100).toFixed(0)}%)` : ""}
                    </span>
                  )}
                </span>
              </div>
            )}
            {nodeSpec.location && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.location")}</span>
                <CopyableValue value={nodeSpec.location} className={styles.essentialsValue}>
                  {nodeSpec.location}
                </CopyableValue>
              </div>
            )}
            {nodeSpec.resourceGroup && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.resourceGroup")}</span>
                <CopyableValue value={nodeSpec.resourceGroup} className={styles.essentialsValue}>
                  {nodeSpec.resourceGroup}
                </CopyableValue>
              </div>
            )}
            {/* AKS: skip generic endpoint — shown better in AksEssentials */}
            {nodeSpec.endpoint && nodeSpec.resourceKind !== "aks" && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.endpoint")}</span>
                <CopyableValue value={nodeSpec.endpoint} className={styles.essentialsValueMono}>
                  {nodeSpec.endpoint}
                </CopyableValue>
              </div>
            )}
            {nodeSpec.azureResourceId && (
              <div className={styles.essentialsRow}>
                <span className={styles.essentialsLabel}>{t("detail.azureId")}</span>
                <CopyableValue
                  value={nodeSpec.azureResourceId}
                  className={styles.essentialsValueMono}
                  title={nodeSpec.azureResourceId}
                >
                  {truncateId(nodeSpec.azureResourceId)}
                </CopyableValue>
              </div>
            )}
          </div>
        </div>

        {/* Sub-Resources (NICs in VM, Frontend IPs in AppGW) */}
        {nodeSpec.subResources && nodeSpec.subResources.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("ld.subResources")}</div>
            {nodeSpec.subResources.map((sr: SubResource) => (
              <div key={sr.id} className={styles.subResourceDetailCard}>
                <img
                  src={getAzureIconUrl(sr.kind === "nic" ? "nic" : sr.kind === "publicIP" ? "publicIP" : "appGateway")}
                  alt={sr.kind}
                  width={16}
                  height={16}
                  style={{ opacity: 0.7, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <CopyableValue value={sr.label} className={styles.essentialsValue}>
                    {sr.label}
                  </CopyableValue>
                  <div className={styles.essentialsValueMono} style={{ fontSize: 11 }}>
                    {RESOURCE_KIND_DISPLAY[sr.kind] ?? sr.kind}
                  </div>
                  {sr.endpoint && (
                    <CopyableValue value={sr.endpoint} className={styles.essentialsValueMono}>
                      {sr.endpoint}
                    </CopyableValue>
                  )}
                  {sr.azureResourceId && (
                    <CopyableValue
                      value={sr.azureResourceId}
                      className={styles.essentialsValueMono}
                      title={sr.azureResourceId}
                      style={{ fontSize: 10 }}
                    >
                      {truncateId(sr.azureResourceId, 50)}
                    </CopyableValue>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* NSG Security Rules (shown for NSG nodes) */}
        {nodeSpec.resourceKind === "nsg" && (
          <NsgRulesSection nsg={nsgDetail} loading={nsgLoading} />
        )}

        {/* Backend Pool (shown for LB / Application Gateway nodes) */}
        {(nodeSpec.resourceKind === "lb" || nodeSpec.resourceKind === "appGateway") && (
          <BackendPoolSection pools={backendPools} loading={backendPoolLoading} />
        )}

        {/* AKS API Endpoint (접속면 외부 노드) */}
        {nodeSpec.resourceKind === "aks" && vmssArchRole === "aks-control-plane" && (
          <AksApiEndpointSection nodeSpec={nodeSpec} />
        )}

        {/* AKS 3-Plane Detail (접속면 / 실행면 / 노출면) — only for real AKS cluster nodes */}
        {nodeSpec.resourceKind === "aks" && vmssArchRole !== "aks-control-plane" && (
          <AksPlaneDetailSection detail={aksPlaneDetail} loading={aksPlaneLoading} />
        )}

        {/* AKS-owned VMSS — Nodepool detail + Instance grid */}
        {vmssArchRole === "aks-vmss" && nodeSpec.resourceKind === "vmss" && (
          <AksVmssDetailSection
            nodeSpec={nodeSpec}
            instances={vmssInstances}
            loading={vmssInstancesLoading}
          />
        )}

        {/* Tags */}
        {tagEntries.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("detail.tags")}</div>
            <div className={styles.detailTags}>
              {tagEntries.map(([k, v]) => (
                <span key={k} className={styles.detailTag}>
                  {k}: {v}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Metrics */}
        {metricEntries.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>{t("detail.metrics")}</div>
            <div className={styles.detailMetricGrid}>
              {metricEntries.map(([key, val]) => (
                <div key={key} className={styles.detailMetricCard}>
                  <span className={styles.detailMetricKey}>{key}</span>
                  <span className={styles.detailMetricVal}>{fmtMetric(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sparklines */}
        {sparklineEntries.length > 0 && (
          <div className={styles.detailSection}>
            {sparklineEntries.map(([key, data]) => (
              <div key={key}>
                <span className={styles.detailMetricKey}>{data.metric || key}</span>
                <div className={styles.detailSparklineWrap}>
                  <D3Sparkline
                    values={data.values}
                    width={280}
                    height={36}
                    color={colors.ringStroke}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Alerts (collapsible) */}
        <div className={styles.detailSection}>
          <button
            className={styles.detailSectionToggle}
            onClick={() => setAlertsOpen((prev) => !prev)}
            type="button"
          >
            <span>
              {t("detail.alerts")} ({alerts.length})
            </span>
            <span className={styles.toggleChevron}>
              {alertsOpen ? "\u25B2" : "\u25BC"}
            </span>
          </button>
          {alertsOpen && (
            alerts.length === 0 ? (
              <div className={styles.detailEmpty}>{t("detail.noAlerts")}</div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className={styles.detailAlertCard}>
                  <div className={styles.detailAlertHeader}>
                    <div
                      className={styles.detailHealthDot}
                      style={{ background: defaultTokens.colors.alert[alert.severity] }}
                    />
                    <span className={styles.detailAlertSeverity}>{alert.severity}</span>
                    <span className={styles.detailAlertTime}>
                      {fmtRelativeTime(alert.firedAt)}
                    </span>
                  </div>
                  <div className={styles.detailAlertTitle}>{alert.title}</div>
                  <div className={styles.detailAlertSummary}>{alert.summary}</div>
                  {alert.rootCauseCandidates && alert.rootCauseCandidates.length > 0 && (
                    <div className={styles.detailAlertCauses}>
                      <div className={styles.detailAlertCausesTitle}>{t("detail.alertCauses")}</div>
                      {alert.rootCauseCandidates.map((cause, i) => (
                        <div key={i} className={styles.detailAlertCause}>{cause}</div>
                      ))}
                    </div>
                  )}
                  {(alert.affectedNodeIds.length > 0 || alert.affectedEdgeIds.length > 0) && (
                    <div className={styles.detailAlertAffects}>
                      {t("detail.alertAffects")}:{" "}
                      {alert.affectedNodeIds.length > 0 && `${alert.affectedNodeIds.length} ${t("detail.alertNodes")}`}
                      {alert.affectedNodeIds.length > 0 && alert.affectedEdgeIds.length > 0 && " · "}
                      {alert.affectedEdgeIds.length > 0 && `${alert.affectedEdgeIds.length} ${t("detail.alertEdges")}`}
                    </div>
                  )}
                </div>
              ))
            )
          )}
        </div>

        {/* Alert Rules (collapsible) */}
        {alertRules.length > 0 && (
          <div className={styles.detailSection}>
            <button
              className={styles.detailSectionToggle}
              onClick={() => setAlertRulesOpen((prev) => !prev)}
              type="button"
            >
              <span>
                {t("detail.alertRules")} ({alertRules.length})
              </span>
              <span className={styles.toggleChevron}>
                {alertRulesOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {alertRulesOpen &&
              alertRules.map((rule) => (
                <div key={rule.id} className={styles.detailAlertRuleCard}>
                  <div className={styles.detailAlertRuleHeader}>
                    <div
                      className={styles.detailHealthDot}
                      style={{ background: SEVERITY_COLORS[rule.severity] ?? rgba("ink", 0.45) }}
                    />
                    <span className={styles.detailAlertRuleSeverity}>
                      {SEVERITY_LABELS[rule.severity] ?? `Sev${rule.severity}`}
                    </span>
                    <span className={styles.detailAlertRuleSignal}>{rule.signalType}</span>
                    {!rule.enabled && (
                      <span className={styles.detailAlertRuleDisabled}>{t("detail.disabled")}</span>
                    )}
                  </div>
                  <div className={styles.detailAlertRuleName}>{rule.name}</div>
                  {rule.condition && (
                    <div className={styles.detailAlertRuleCondition}>{rule.condition}</div>
                  )}
                  {rule.targetResourceType && (
                    <div className={styles.detailAlertRuleTarget}>
                      {rule.targetResourceType.split("/").pop()}
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* Connections (collapsible) */}
        {connectedEdges.length > 0 && (
          <div className={styles.detailSection}>
            <button
              className={styles.detailSectionToggle}
              onClick={() => setConnectionsOpen((prev) => !prev)}
              type="button"
            >
              <span>
                {t("detail.connections")} ({connectedEdges.length})
              </span>
              <span className={styles.toggleChevron}>
                {connectionsOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {connectionsOpen &&
              connectedEdges.map((ce) => {
                const m = ce.liveEdge?.metrics;
                const metricStr = m?.latencyMs != null
                  ? `${m.latencyMs.toFixed(0)}ms`
                  : m?.throughputBps != null
                    ? fmtThroughput(m.throughputBps)
                    : "";
                return (
                  <div key={ce.edgeSpec.id} className={styles.detailEdgeItem}>
                    <span className={styles.detailEdgeDir}>
                      {ce.direction === "inbound" ? t("detail.inbound") : t("detail.outbound")}
                    </span>
                    <span className={styles.detailEdgePeer}>{ce.peerLabel}</span>
                    {metricStr && (
                      <span className={styles.detailEdgeMetric}>{metricStr}</span>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </aside>
  );
}

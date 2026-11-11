// AKS 클러스터 › 클러스터 구성 — what Azure says the cluster is set to: version and the versions it can move to,
// upgrade channels, node pools, network, sign-in, add-ons, planned-maintenance windows.
//
// ARM only (managedClusters GET + upgradeProfiles/default + maintenanceConfigurations), read with the cluster's
// connection — no Kubernetes call, so a private cluster the platform cannot reach still answers. Rules:
// - a property absent from the answer is null (shown '—'), never a guessed default;
// - the two side reads (upgrades, windows) fail on their own: the part is null and named in `gaps`;
// - nothing identifying leaves: no FQDN, no authorized IP ranges (their count only), no OIDC issuer URL, no IDs.
import type { Env } from "../env.js";
import type { AksClusterConfigResponse, AksConfigPool } from "@aud/types";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { getArmFetcherAuto } from "../infra/azureClientFactory.js";
import { HttpError } from "../infra/requestParams.js";
import { parseWindows, type RawMaintConfig } from "./nodeMaintenance.js";

const ARM = "https://management.azure.com";
const AKS_API = "2025-05-01";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => obj(x)[k], o);

export type RawUpgradeProfile = { properties?: { controlPlaneProfile?: { upgrades?: { kubernetesVersion?: string; isPreview?: boolean }[] | null } } };

/** Pure: numeric compare of dotted versions (1.31.10 > 1.31.9) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Add-on profile keys differ in case across API versions (omsagent / omsAgent, azurepolicy / azurePolicy) */
const addonOn = (profiles: Obj, name: string): boolean | null => {
  const key = Object.keys(profiles).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? bool(obj(profiles[key]).enabled) : null;
};

/** Pure: the ARM cluster (+ the side reads; null = not read) → the configuration shown */
export function clusterConfigOf(
  clusterId: string, cluster: Obj, upgrades: RawUpgradeProfile | null, windows: RawMaintConfig[] | null, now = Date.now(),
): AksClusterConfigResponse {
  const p = obj(cluster.properties);
  const addonProfiles = obj(p.addonProfiles);
  const pools: AksConfigPool[] = (Array.isArray(p.agentPoolProfiles) ? (p.agentPoolProfiles as unknown[]) : []).map((x) => {
    const a = obj(x);
    const min = num(a.minCount), max = num(a.maxCount);
    return {
      name: str(a.name) ?? "", mode: str(a.mode), vmSize: str(a.vmSize), count: num(a.count),
      autoscale: a.enableAutoScaling === true && min !== null && max !== null ? { min, max } : null,
      osType: str(a.osType), osSku: str(a.osSKU),
      zones: Array.isArray(a.availabilityZones) ? (a.availabilityZones as unknown[]).filter((z): z is string => typeof z === "string") : [],
      version: str(a.currentOrchestratorVersion) ?? str(a.orchestratorVersion), nodeImageVersion: str(a.nodeImageVersion),
      powerState: str(at(a, "powerState.code")), spot: a.scaleSetPriority === "Spot",
    };
  }).sort((a, b) => (a.mode === b.mode ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.mode === "System" ? -1 : b.mode === "System" ? 1 : 0));
  const ranges = at(p, "apiServerAccessProfile.authorizedIPRanges");
  const disableLocal = bool(p.disableLocalAccounts);
  const gaps: AksClusterConfigResponse["gaps"] = [];
  if (!upgrades) gaps.push("upgrades");
  if (!windows) gaps.push("windows");
  return {
    clusterId: clusterId.toLowerCase(), generatedAt: new Date(now).toISOString(),
    name: str(cluster.name) ?? clusterId.split("/").pop() ?? "", location: str(cluster.location),
    powerState: str(at(p, "powerState.code")), provisioningState: str(p.provisioningState),
    version: {
      current: str(p.currentKubernetesVersion) ?? str(p.kubernetesVersion),
      upgrades: upgrades
        ? (upgrades.properties?.controlPlaneProfile?.upgrades ?? [])
            .filter((u): u is { kubernetesVersion: string; isPreview?: boolean } => typeof u?.kubernetesVersion === "string")
            .map((u) => ({ version: u.kubernetesVersion, preview: u.isPreview === true }))
            .sort((a, b) => compareVersions(a.version, b.version))
        : null,
      upgradeChannel: str(at(p, "autoUpgradeProfile.upgradeChannel")), nodeOsChannel: str(at(p, "autoUpgradeProfile.nodeOSUpgradeChannel")),
      tier: str(at(cluster, "sku.tier")), supportPlan: str(p.supportPlan),
    },
    pools,
    network: {
      plugin: str(at(p, "networkProfile.networkPlugin")), pluginMode: str(at(p, "networkProfile.networkPluginMode")),
      dataplane: str(at(p, "networkProfile.networkDataplane")), policy: str(at(p, "networkProfile.networkPolicy")),
      podCidr: str(at(p, "networkProfile.podCidr")), serviceCidr: str(at(p, "networkProfile.serviceCidr")),
      outboundType: str(at(p, "networkProfile.outboundType")), loadBalancerSku: str(at(p, "networkProfile.loadBalancerSku")),
      privateCluster: bool(at(p, "apiServerAccessProfile.enablePrivateCluster")),
      authorizedIpRanges: Array.isArray(ranges) ? ranges.length : null,
    },
    identity: {
      // ARM omits aadProfile on a cluster without Entra integration — absence here is the fact "off", not a guess
      entra: p.aadProfile === undefined ? false : at(p, "aadProfile.managed") === true,
      azureRbac: bool(at(p, "aadProfile.enableAzureRBAC")),
      localAccounts: disableLocal === null ? null : !disableLocal,
      oidcIssuer: bool(at(p, "oidcIssuerProfile.enabled")),
      workloadIdentity: bool(at(p, "securityProfile.workloadIdentity.enabled")),
    },
    addons: [
      { id: "monitoring", on: addonOn(addonProfiles, "omsagent") },
      { id: "managedPrometheus", on: bool(at(p, "azureMonitorProfile.metrics.enabled")) },
      { id: "defender", on: bool(at(p, "securityProfile.defender.securityMonitoring.enabled")) },
      { id: "azurePolicy", on: addonOn(addonProfiles, "azurepolicy") },
      { id: "keyVaultCsi", on: addonOn(addonProfiles, "azureKeyvaultSecretsProvider") },
      { id: "acns", on: bool(at(p, "networkProfile.advancedNetworking.enabled")) },
      { id: "keda", on: bool(at(p, "workloadAutoScalerProfile.keda.enabled")) },
      { id: "vpa", on: bool(at(p, "workloadAutoScalerProfile.verticalPodAutoscaler.enabled")) },
      { id: "imageCleaner", on: bool(at(p, "securityProfile.imageCleaner.enabled")) },
      { id: "appRouting", on: bool(at(p, "ingressProfile.webAppRouting.enabled")) },
    ],
    windows: windows ? parseWindows(windows, now).map(({ startDate: _s, ...w }) => w) : null,
    gaps,
  };
}

const cache = new CacheManager<AksClusterConfigResponse>(30, 2 * 60_000);
const inflight = new Map<string, Promise<AksClusterConfigResponse>>();

export async function getAksClusterConfig(env: Env, bearerToken: string | undefined, clusterId: string): Promise<AksClusterConfigResponse> {
  const key = `${cachePrefix(bearerToken)}:aks-config:${clusterId.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const arm = await getArmFetcherAuto(env, bearerToken); // anonymous without the dev switch → signin_required
    const cluster = await arm.fetchJson<Obj>(`${ARM}${clusterId}?api-version=${AKS_API}`);
    const side = async <T>(path: string): Promise<T | null> => {
      try { return await arm.fetchJson<T>(`${ARM}${clusterId}/${path}?api-version=${AKS_API}`); } catch (e) {
        if (e instanceof HttpError && e.code === "signin_required") throw e;
        return null;
      }
    };
    const [upgrades, windows] = await Promise.all([
      side<RawUpgradeProfile>("upgradeProfiles/default"),
      side<{ value?: RawMaintConfig[] }>("maintenanceConfigurations"),
    ]);
    const r = clusterConfigOf(clusterId, cluster, upgrades, windows ? windows.value ?? [] : null);
    cache.set(key, r, r.gaps.length ? 20_000 : undefined); // a partial answer is asked again soon
    return r;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** The sample cluster's configuration (anonymous visitors) */
export function mockClusterConfig(clusterId: string, name: string): AksClusterConfigResponse {
  const cluster = {
    name, location: "koreacentral", sku: { tier: "Standard" },
    properties: {
      provisioningState: "Succeeded", powerState: { code: "Running" }, kubernetesVersion: "1.32.6", supportPlan: "KubernetesOfficial",
      autoUpgradeProfile: { upgradeChannel: "patch", nodeOSUpgradeChannel: "NodeImage" },
      agentPoolProfiles: [
        { name: "system", mode: "System", vmSize: "Standard_D4ds_v5", count: 3, enableAutoScaling: false, osType: "Linux", osSKU: "AzureLinux", availabilityZones: ["1", "2", "3"], orchestratorVersion: "1.32.6", powerState: { code: "Running" } },
        { name: "apps", mode: "User", vmSize: "Standard_D8ds_v5", count: 4, enableAutoScaling: true, minCount: 3, maxCount: 8, osType: "Linux", osSKU: "AzureLinux", availabilityZones: ["1", "2", "3"], orchestratorVersion: "1.32.6", powerState: { code: "Running" } },
      ],
      networkProfile: { networkPlugin: "azure", networkPluginMode: "overlay", networkDataplane: "cilium", networkPolicy: "cilium", podCidr: "10.244.0.0/16", serviceCidr: "10.0.0.0/16", outboundType: "userAssignedNATGateway", loadBalancerSku: "standard", advancedNetworking: { enabled: true } },
      apiServerAccessProfile: { enablePrivateCluster: true },
      aadProfile: { managed: true, enableAzureRBAC: true }, disableLocalAccounts: true,
      oidcIssuerProfile: { enabled: true }, securityProfile: { workloadIdentity: { enabled: true }, defender: { securityMonitoring: { enabled: true } } },
      azureMonitorProfile: { metrics: { enabled: true } }, addonProfiles: { azurepolicy: { enabled: true }, omsagent: { enabled: false } },
    },
  };
  const upgrades: RawUpgradeProfile = { properties: { controlPlaneProfile: { upgrades: [{ kubernetesVersion: "1.32.7" }, { kubernetesVersion: "1.33.2" }] } } };
  const windows: RawMaintConfig[] = [{ name: "aksManagedAutoUpgradeSchedule", properties: { maintenanceWindow: { schedule: { weekly: { intervalWeeks: 1, dayOfWeek: "Saturday" } }, durationHours: 4, utcOffset: "+09:00", startTime: "02:00" } } }];
  return { ...clusterConfigOf(clusterId, cluster, upgrades, windows), source: "mock" };
}

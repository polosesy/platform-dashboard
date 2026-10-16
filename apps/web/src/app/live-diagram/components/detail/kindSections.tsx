"use client";

import { useState } from "react";
import type { AksExposurePathInfo, AksNodePoolInfo, AksPlaneDetail, AksVmssInstance, BackendPoolInfo, DiagramNodeSpec, NsgInfo } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { Notice, Segmented } from "@/components/ui";
import { localizeLabel } from "../../utils/localizeLabel";
import { CopyButton, Group, KV, Section, TwoLine } from "./primitives";
import styles from "../../styles.module.css";

// ── Data hooks: error is reported (a failed lookup is not "none") ──

export function useBackendPool(armId: string | undefined, kind: string | undefined) {
  const enabled = !!armId && (kind === "lb" || kind === "appGateway");
  const { data, error, loading } = useApiQuery(
    enabled ? `backend-pool:${kind}:${armId}` : null,
    (token) => fetchJsonWithBearer<{ pools: BackendPoolInfo[] }>(apiUrl("/api/live/backend-pool", { resourceId: armId, resourceKind: kind }), token),
    { tokenOptional: true },
  );
  return { pools: data?.pools ?? [], loading: enabled && loading, failed: enabled && !!error };
}

export function useNsgDetail(armId: string | undefined, kind: string | undefined) {
  const enabled = kind === "nsg" && !!armId;
  const { data, error, loading } = useApiQuery(
    enabled ? `nsg-detail:${armId}` : null,
    (token) => fetchJsonWithBearer<NsgInfo>(apiUrl("/api/live/nsg-detail", { resourceId: armId }), token),
    { tokenOptional: true },
  );
  return { nsg: data ?? null, loading: enabled && loading, failed: enabled && !!error };
}

export function useAksPlane(armId: string | undefined, kind: string | undefined, archRole: string | undefined) {
  const enabled = kind === "aks" && !!armId && archRole !== "aks-control-plane";
  const { data, error, loading } = useApiQuery(
    enabled ? `aks-plane:${armId}` : null,
    (token) => fetchJsonWithBearer<AksPlaneDetail>(apiUrl("/api/live/aks-plane", { resourceId: armId }), token),
    { tokenOptional: true },
  );
  return { detail: data ?? null, loading: enabled && loading, failed: enabled && !!error };
}

export function useVmssInstances(armId: string | undefined, archRole: string | undefined) {
  const enabled = archRole === "aks-vmss" && !!armId;
  const { data, error, loading } = useApiQuery(
    enabled ? `vmss-instances:${armId}` : null,
    (token) => fetchJsonWithBearer<{ instances: AksVmssInstance[] }>(apiUrl("/api/live/vmss-instances", { resourceId: armId }), token),
    { tokenOptional: true },
  );
  return { instances: data?.instances ?? [], loading: enabled && loading, failed: enabled && !!error };
}

export function FetchFailed({ what }: { what: string }) {
  const { t } = useI18n();
  return <Notice tone="warning">{t("ld.panel.fetchFailed", { what })}</Notice>;
}

const memberKey = (s?: string) => (s === "Healthy" ? "healthy" : s === "Unhealthy" ? "unhealthy" : "unknown");

// ── LB / Application Gateway ──

export function BackendPools({ pools, loading, failed }: { pools: BackendPoolInfo[]; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  if (failed) return <FetchFailed what={t("detail.backendPool")} />;
  if (loading) return <div className={styles.dpMuted}>{t("live.loading")}</div>;
  if (!pools.length) return <div className={styles.dpMuted}>{t("ld.panel.noPools")}</div>;
  return (
    <>
      {pools.map((pool) => (
        <Group key={pool.name} title={t("ld.panel.poolTitle", { name: pool.name, n: pool.members.length })}>
          {pool.loadBalancingRules?.length ? <KV label={t("detail.backendPool.rules")}>{pool.loadBalancingRules.join(", ")}</KV> : null}
          {pool.probe ? (
            <KV label={t("detail.backendPool.probe")}>
              {t("ld.panel.probe", { proto: `${pool.probe.protocol}/${pool.probe.port}${pool.probe.path ? ` ${pool.probe.path}` : ""}`, sec: pool.probe.intervalSec, n: pool.probe.unhealthyThreshold })}
            </KV>
          ) : null}
          {pool.members.map((m, i) => (
            <div key={`${m.name}-${i}`} className={styles.dpTwoLine}>
              <span className={styles.dpTwoLineMain}>{m.name}</span>
              <span className={styles.dpTwoLineSub}>
                <span data-mono="true">{m.ipAddress ?? m.fqdn ?? ""}{m.port ? `:${m.port}` : ""}</span>
                {" · "}
                <span className={styles.dpState} data-state={memberKey(m.state)}>{t(`ld.member.${memberKey(m.state)}`)}</span>
                {m.kind === "fqdn" ? <span className={styles.dpTag}>{t("ld.panel.outsideGraph")}</span> : null}
              </span>
            </div>
          ))}
        </Group>
      ))}
    </>
  );
}

// ── NSG ──

export function NsgRules({ nsg, loading, failed }: { nsg: NsgInfo | null; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  const [dir, setDir] = useState<"Inbound" | "Outbound">("Inbound");
  if (failed) return <FetchFailed what={t("detail.nsgRules")} />;
  if (loading) return <div className={styles.dpMuted}>{t("live.loading")}</div>;
  if (!nsg) return null;
  const rules = nsg.effectiveRules.filter((r) => r.direction === dir).sort((a, b) => a.priority - b.priority);
  const count = (d: string) => nsg.effectiveRules.filter((r) => r.direction === d).length;
  return (
    <Section id="nsg" title={t("detail.nsgRules")} count={nsg.effectiveRules.length}>
      <Segmented
        label={t("detail.nsgRules")}
        value={dir}
        onChange={setDir}
        items={[{ id: "Inbound", label: `${t("ld.nsg.inbound")} ${count("Inbound")}` }, { id: "Outbound", label: `${t("ld.nsg.outbound")} ${count("Outbound")}` }]}
      />
      {rules.map((r) => (
        <div key={`${r.direction}-${r.priority}-${r.name}`} className={styles.dpTwoLine}>
          <span className={styles.dpTwoLineMain}>
            <span data-mono="true">{r.priority}</span>{"  "}
            <span className={styles.dpState} data-state={r.access === "Allow" ? "allow" : "deny"}>{t(r.access === "Allow" ? "ld.nsg.allow" : "ld.nsg.deny")}</span>{"  "}
            <span data-mono="true">{r.protocol} {r.destinationPortRange}</span>{"  "}{r.name}
          </span>
          <span className={styles.dpTwoLineSub} data-mono="true">{r.sourceAddressPrefix} → {r.destinationAddressPrefix}</span>
        </div>
      ))}
    </Section>
  );
}

// ── AKS ──

const PROV = ["Succeeded", "Creating", "Updating", "Deleting", "Failed"];
const powerKey = (s: string | undefined) => {
  const k = (s ?? "").toLowerCase();
  return ["running", "stopped", "deallocated", "starting", "stopping"].includes(k) ? `ld.power.${k}` : "ld.power.unknown";
};
const modeKey = (m: string | undefined) => (m?.toLowerCase() === "system" ? "ld.aks.mode.system" : m?.toLowerCase() === "user" ? "ld.aks.mode.user" : null);

function InstanceList({ instances }: { instances: AksVmssInstance[] }) {
  const { t } = useI18n();
  const shown = instances.slice(0, 12);
  return (
    <>
      {shown.map((inst) => (
        <div key={inst.instanceId} className={styles.dpTwoLine}>
          <span className={styles.dpTwoLineMain}>{inst.computerName || `instance-${inst.instanceId}`}</span>
          <span className={styles.dpTwoLineSub}>
            <span data-mono="true">{inst.privateIp ?? t("ld.panel.unknownValue")}</span>
            {" · "}{t(powerKey(inst.powerState))}
            {inst.provisioningState ? ` · ${PROV.includes(inst.provisioningState) ? t(`ld.prov.${inst.provisioningState}`) : inst.provisioningState}` : ""}
          </span>
        </div>
      ))}
      {instances.length > shown.length ? <div className={styles.dpMuted}>{t("ld.panel.more", { n: instances.length - shown.length })}</div> : null}
    </>
  );
}

function NodePools({ pools }: { pools: AksNodePoolInfo[] }) {
  const { t } = useI18n();
  return (
    <Section id="aks-pools" title={t("ld.aks.nodePools", { n: pools.length })} defaultOpen={false}>
      {pools.map((p) => (
        <Group key={p.name} title={<>{p.name}{modeKey(p.mode) ? ` · ${t(modeKey(p.mode)!)}` : ""} · {t(powerKey(p.powerState))}</>}>
          <KV label={t("ld.pool.vmSize")}>{p.vmSize} · {p.osType}{p.osSKU ? ` (${p.osSKU})` : ""}{p.orchestratorVersion ? ` · v${p.orchestratorVersion}` : ""}</KV>
          <KV label={t("ld.pool.nodes")}>{p.nodeCount}{p.enableAutoScaling ? ` ${t("ld.vmss.auto", { min: p.minCount ?? 0, max: p.maxCount ?? 0 })}` : ""}</KV>
          {p.availabilityZones?.length ? <KV label={t("ld.panel.zones")}>{p.availabilityZones.join(", ")}</KV> : null}
          {p.vmssInstances?.length ? <InstanceList instances={p.vmssInstances} /> : null}
        </Group>
      ))}
    </Section>
  );
}

function Exposure({ paths }: { paths: AksExposurePathInfo[] }) {
  const { t } = useI18n();
  return (
    <Section id="aks-exposure" title={t("ld.aks.exposure")} count={paths.length}>
      {!paths.length && <div className={styles.dpMuted}>{t("ld.aks.noPaths")}</div>}
      {(["ingress", "egress"] as const).map((dir) => {
        const list = paths.filter((p) => p.direction === dir);
        if (!list.length) return null;
        return (
          <Group key={dir} title={t(dir === "ingress" ? "ld.dir.in" : "ld.dir.out")}>
            {list.map((p, i) => (
              <div key={i} className={styles.dpTwoLine}>
                <span className={styles.dpTwoLineMain}>{localizeLabel(p.label, t)}</span>
                <span className={styles.dpTwoLineSub}>
                  {p.resources.map((r) => [r.name, r.endpoint, r.sku].filter(Boolean).join(" ")).join(" → ")}
                </span>
              </div>
            ))}
          </Group>
        );
      })}
    </Section>
  );
}

export function AksCluster({ detail, loading, failed }: { detail: AksPlaneDetail | null; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  if (failed) return <FetchFailed what={t("ld.aks.clusterInfo")} />;
  if (loading) return <div className={styles.dpMuted}>{t("common.loading")}</div>;
  if (!detail) return null;
  const cp = detail.controlPlane;
  const np = detail.networkProfile;
  return (
    <>
      <Exposure paths={detail.exposurePaths} />
      <Section id="aks-cluster" title={t("ld.aks.info")}>
        <KV label={t("ld.aks.apiAddress")} mono copy={cp.apiServerEndpoint}>{cp.apiServerEndpoint}</KV>
        <KV label={t("ld.aks.private")}>{t(cp.isPrivateCluster ? "ld.on" : "ld.off")}</KV>
        <KV label={t("ld.aks.authorizedIps")}>{cp.authorizedIpRanges?.length ? cp.authorizedIpRanges.join(", ") : t("ld.off")}</KV>
        {cp.privateFqdn ? <KV label="Private FQDN" mono copy={cp.privateFqdn}>{cp.privateFqdn}</KV> : null}
        {np ? (
          <>
            <KV label={t("ld.aks.network")}>{np.networkPlugin === "azure" ? "Azure CNI" : np.networkPlugin}{np.networkPolicy ? ` + ${np.networkPolicy}` : ""}</KV>
            {np.podCidr ? <KV label="Pod CIDR" mono>{np.podCidr}</KV> : null}
            {np.serviceCidr ? <KV label={t("ld.aks.serviceCidr")} mono>{np.serviceCidr}</KV> : null}
            {np.dnsServiceIp ? <KV label={t("ld.aks.dnsIp")} mono>{np.dnsServiceIp}</KV> : null}
            {np.loadBalancerSku ? <KV label={t("ld.aks.lb")}>{np.loadBalancerSku}</KV> : null}
          </>
        ) : null}
      </Section>
      <NodePools pools={detail.nodePools} />
    </>
  );
}

export function AksApiEndpoint({ node }: { node: DiagramNodeSpec }) {
  const { t } = useI18n();
  const meta = node.metadata ?? {};
  const isPrivate = meta.isPrivateCluster === "true";
  return (
    <Section id="aks-api" title={t("ld.aks.controlPlane")}>
      {meta.aksClusterName ? <KV label={t("ins.ticket.cluster")}>{meta.aksClusterName}</KV> : null}
      {meta.fqdn ? <KV label={t("ld.aks.apiFqdn")} mono copy={meta.fqdn}>{meta.fqdn}</KV> : null}
      <KV label={t("ld.aks.accessType")}>{t(isPrivate ? "ld.aks.access.private" : "ld.aks.access.public")}</KV>
      <KV label={t("ld.aks.accessPath")}>{t(isPrivate ? "ld.aks.path.private" : "ld.aks.path.public")}</KV>
    </Section>
  );
}

export function AksNodePool({ node, instances, loading, failed }: { node: DiagramNodeSpec; instances: AksVmssInstance[]; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  const m = node.metadata ?? {};
  return (
    <Section id="aks-vmss" title={t("ld.pool.info")}>
      {m.nodepoolName ? <KV label={t("ld.pool.name")}>{m.nodepoolName}{modeKey(m.nodepoolMode) ? ` · ${t(modeKey(m.nodepoolMode)!)}` : ""}</KV> : null}
      {m.nodepoolVmSize ? <KV label={t("ld.pool.vmSize")}>{m.nodepoolVmSize}</KV> : null}
      {m.nodepoolCount ? <KV label={t("ld.pool.nodes")}>{m.nodepoolCount}{m.nodepoolAutoScale ? ` ${t("ld.vmss.auto", { min: m.nodepoolAutoScale.split("-")[0] ?? "", max: m.nodepoolAutoScale.split("-")[1] ?? "" })}` : ""}</KV> : null}
      {m.nodepoolPowerState ? <KV label={t("hb.status")}>{t(powerKey(m.nodepoolPowerState))}</KV> : null}
      <Group title={t("ld.vmss.instances", { n: loading ? "…" : instances.length })}>
        {failed ? <FetchFailed what={t("ld.vmss.instances", { n: "" }).trim()} /> : loading ? <div className={styles.dpMuted}>{t("ld.pool.loading")}</div> : instances.length ? <InstanceList instances={instances} /> : <div className={styles.dpMuted}>{t("ld.pool.noInstances")}</div>}
      </Group>
    </Section>
  );
}

export { CopyButton };

const groupBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return m;
};

const parseArr = <T,>(v: string | undefined): T[] => {
  if (!v) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? (x as T[]) : []; } catch { return []; }
};

/** Application Gateway for Containers (catalog AGC-01..05): frontends, the delegated subnet association, the cluster */
export function AgcFacts({ node }: { node: DiagramNodeSpec }) {
  const { t } = useI18n();
  const m = node.metadata ?? {};
  const frontends = parseArr<{ name: string; fqdn?: string; public: boolean; state?: string }>(m.agcFrontends);
  const assoc = parseArr<{ name: string; subnetId?: string; state?: string }>(m.agcAssociations);
  return (
    <Section id="agc" title={t("ld.agc.title")}>
      <Group title={t("ld.agc.frontends", { n: frontends.length })}>
        {frontends.length ? frontends.map((f) => (
          <TwoLine key={f.name} main={f.fqdn ?? f.name} mono copy={f.fqdn}
            sub={[f.name, t(f.public ? "ld.agc.public" : "ld.agc.private"), f.state && f.state !== "Succeeded" ? f.state : null].filter(Boolean).join(" · ")} />
        )) : <div className={styles.dpMuted}>{t("ld.agc.noFrontend")}</div>}
      </Group>
      <Group title={t("ld.agc.association")}>
        {assoc.length ? assoc.map((a) => (
          <TwoLine key={a.name} main={a.subnetId?.split("/").pop() ?? a.name} sub={[a.name, a.state].filter(Boolean).join(" · ")} />
        )) : <div className={styles.dpMuted}>{t("ld.agc.noAssociation")}</div>}
      </Group>
      {m.clusterCandidates != null ? <div className={styles.dpMuted}>{t(m.clusterCandidates === "0" ? "ld.agc.noCluster" : "ld.agc.candidates", { n: m.clusterCandidates })}</div> : null}
      {m.waf === "true" ? <KV label="WAF">{t("ld.agc.waf")}</KV> : null}
    </Section>
  );
}

/** Front Door Standard/Premium (EDGE-04..07): routes and origins read from ARM; origins matched only when exactly one */
export function FrontDoorFacts({ node }: { node: DiagramNodeSpec }) {
  const { t } = useI18n();
  const m = node.metadata ?? {};
  const hosts = parseArr<string>(m.endpointHosts);
  const origins = parseArr<{ name: string; group: string; host: string; state: "linked" | "external" | "unrouted" | "disabled"; target?: string }>(m.originList);
  return (
    <Section id="afd" title={t("ld.afd.title")}>
      {m.classic === "true" ? <Notice tone="warning">{t("ld.afd.classic")}</Notice> : null}
      {m.tier ? <KV label={t("ld.afd.tier")}>{m.tier.replace(/_AzureFrontDoor$/, "")}</KV> : null}
      {m.configUnreadable === "true" ? <FetchFailed what={t("ld.afd.config")} /> : null}
      {m.endpoints ? <KV label={t("ld.afd.endpoints")}>{m.endpoints}</KV> : null}
      {hosts.map((h) => <KV key={h} label="" mono copy={h}>{h}</KV>)}
      {m.activeRoutes ? <KV label={t("ld.afd.routes")}>{m.activeRoutes}</KV> : null}
      {origins.length ? (
        <KV label={t("ld.afd.origins")}>
          {t("ld.afd.originCounts", {
            n: origins.length,
            linked: origins.filter((o) => o.state === "linked").length,
            ext: origins.filter((o) => o.state === "external").length,
            unrouted: origins.filter((o) => o.state === "unrouted" || o.state === "disabled").length,
          })}
          {m.ambiguousOrigins && m.ambiguousOrigins !== "0" ? ` · ${t("ld.afd.ambiguous", { n: m.ambiguousOrigins })}` : ""}
        </KV>
      ) : m.origins ? <KV label={t("ld.afd.origins")}>{t("ld.afd.originSplit", { n: m.origins, ext: m.externalOrigins ?? "0", amb: m.ambiguousOrigins ?? "0" })}</KV> : null}
      {[...groupBy(origins, (o) => o.group)].map(([group, list]) => (
        <Group key={group} title={t("ld.afd.group", { name: group, n: list.length })}>
          {list.map((o) => (
            <TwoLine key={`${o.group}/${o.name}`} main={o.host} mono copy={o.host}
              sub={[o.name, o.target ? `→ ${o.target}` : null, t(`ld.afd.origin.${o.state}`)].filter(Boolean).join(" · ")} />
          ))}
        </Group>
      ))}
    </Section>
  );
}

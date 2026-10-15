"use client";

import { useState, type ReactNode } from "react";
import type { DiagramNodeSpec, PlSourceStatus, PrivateLinkUsage, PrivateLinkUsageResponse } from "@aud/types";
import { groupUnresolved, unresolvedCount, type UnresolvedGroup } from "@/lib/plUsage";
import { useI18n } from "@/lib/i18n";
import { formatMetric } from "@/lib/liveMetricFormat";
import { Notice } from "@/components/ui";
import { CopyButton, Group, Section, useRelativeTime } from "./primitives";
import styles from "../../styles.module.css";

const kindOf = (n: DiagramNodeSpec | undefined) => n?.resourceKind ?? n?.icon ?? "";
const COMPUTE = new Set(["vm", "vmss", "aks", "appService", "functionApp", "containerApp"]);

/** The az command that turns a source on — shown and copied, never run by the dashboard */
function enableCommand(s: PlSourceStatus, target: DiagramNodeSpec | undefined, vnet: DiagramNodeSpec | undefined): string | null {
  const ws = "<workspace-resource-id>";
  if (s.source === "vnetFlow") {
    return `az network watcher flow-log create --location ${vnet?.location ?? "<location>"} --name ${vnet?.label ?? "vnet"}-fl --vnet ${vnet?.azureResourceId ?? "<vnet-id>"} --storage-account <storage-account-id> --traffic-analytics true --workspace ${ws} --interval 10`;
  }
  const id = target?.azureResourceId;
  if (!id || s.reason === "noAccess") return null;
  if (s.source === "kvAudit") return `az monitor diagnostic-settings create --name aud-access --resource ${id} --workspace ${ws} --logs '[{"category":"AuditEvent","enabled":true}]' --export-to-resource-specific true`;
  if (s.source === "storageLogs") return `az monitor diagnostic-settings create --name aud-access --resource ${id}/blobServices/default --workspace ${ws} --logs '[{"category":"StorageRead","enabled":true},{"category":"StorageWrite","enabled":true}]'`;
  return `az monitor diagnostic-settings create --name aud-access --resource ${id} --workspace ${ws} --logs '[{"category":"ConnectedClientList","enabled":true}]'`;
}

/**
 * Detail panel: who uses this Private Endpoint / PaaS resource (or, on a workload, which private services it
 * uses) — from access and flow logs only. With the logs off it says so and shows how to turn them on.
 */
export function PrivateLinkUsageSection({ node, spec, usage, loading, nameOf, onSelectNode }: {
  node: DiagramNodeSpec;
  spec: { nodes: DiagramNodeSpec[] };
  usage: PrivateLinkUsageResponse | null | undefined;
  loading?: boolean;
  nameOf: (id: string) => string;
  onSelectNode?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [showAllGroups, setShowAllGroups] = useState(false);
  const ago = useRelativeTime();
  const kind = kindOf(node);
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const asPe = usage?.endpoints.find((e) => e.peNodeId === node.id);
  const asTarget = usage?.endpoints.some((e) => e.targetNodeId === node.id);
  const reverse = COMPUTE.has(kind);
  const relevant = kind === "privateEndpoint" || asTarget || reverse;
  if (!relevant) return null;
  if (!usage) {
    if (kind !== "privateEndpoint") return null;
    return (
      <Section id="plu" title={t("ld.plu.title")}>
        <div className={styles.dpMuted}>{loading ? t("live.loading") : t("ld.plu.needOneVnet")}</div>
      </Section>
    );
  }

  const targetId = asPe?.targetNodeId ?? (asTarget ? node.id : undefined);
  const evidenceText = (u: PrivateLinkUsage) => {
    const parts: string[] = [t(`ld.plu.attr.${u.attribution}`)];
    for (const ev of u.evidence) {
      if (ev.requests != null) parts.push(t("ld.plu.requests", { count: ev.requests, failed: ev.failed ?? 0 }));
      else if (ev.clients != null) parts.push(t("ld.plu.clients", { count: ev.clients }));
      else if (ev.bytes != null) { const f = formatMetric("bytesIn", ev.bytes); parts.push(`${f.value}${f.unit}`); }
      if (ev.operations?.length) parts.push(ev.operations.slice(0, 3).join(", "));
      if (ev.ports?.length) parts.push(`:${ev.ports.join(",")}`);
    }
    if (u.lastSeen) parts.push(ago(u.lastSeen));
    return parts.join(" · ");
  };
  const row = (u: PrivateLinkUsage, peer: string, via?: string) => (
    <button key={u.id} type="button" className={styles.dpTwoLine} data-plu="true" onClick={() => onSelectNode?.(peer)}>
      <span className={styles.dpTwoLineMain}>
        {nameOf(peer)}{via ? <span className={styles.dpMuted}> › {nameOf(via)}</span> : null}
        <span className={styles.dpTag} data-grade={u.grade}>{t(`ld.plu.grade.${u.grade}`)}</span>
      </span>
      <span className={styles.dpTwoLineSub}>
        {evidenceText(u)}
        {u.evidence.some((e) => e.grade === "flow") ? ` · ${t("ld.plu.delay")}` : ""}
        {u.identityName && u.attribution !== "identity" ? ` · ${t("ld.plu.identity", { name: u.identityName })}` : ""}
      </span>
    </button>
  );
  // One line per reason (grouped), what it means, and how it gets resolved
  const groupHead = (g: UnresolvedGroup): ReactNode => {
    switch (g.reason) {
      case "nicNoVm": return t("ld.plu.nicNoVm", { name: g.nicName ?? "" });
      case "ambiguous": return (
        <>
          {t(g.basis === "identity" ? "ld.plu.group.ambiguousIdentity" : "ld.plu.group.ambiguousSubnet", { count: g.candidates.length })}{" "}
          {g.candidates.slice(0, 4).map((c, i) => (
            <span key={c}>{i ? " · " : ""}<button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(c)}>{nameOf(c)}</button></span>
          ))}
          {g.candidates.length > 4 ? ` +${g.candidates.length - 4}` : ""}
        </>
      );
      case "notInDiagram": {
        const p = g.place;
        if (p?.kind === "otherVnet") return t("ld.plu.place.otherVnet", { vnet: nameOf(p.vnetNodeId), subnet: nameOf(p.subnetNodeId), owner: p.ownerNodeId ? ` (${nameOf(p.ownerNodeId)})` : "" });
        if (p?.kind === "overlap") return t("ld.plu.place.overlap", { count: p.matches });
        if (p?.kind === "onPremSite") return (
          <>
            {t("ld.plu.place.onPremSite", { prefix: p.prefix })}{" "}
            <button type="button" className={styles.dpLink} onClick={() => onSelectNode?.(p.siteNodeId)}>{nameOf(p.siteNodeId)}</button>
          </>
        );
        if (p?.kind === "private") return t("ld.plu.place.private");
        if (p?.kind === "cgnat") return t("ld.plu.place.cgnat");
        return t("ld.plu.place.unknown");
      }
      case "peUnconfirmed": return t("ld.plu.peUnconfirmed");
      case "denied": return t("ld.plu.denied", { count: g.deniedFlows });
      default: return t("ld.plu.noIp");
    }
  };
  const fixKey = (g: UnresolvedGroup) =>
    g.reason === "ambiguous" ? (g.basis === "identity" ? "ld.plu.fix.identity" : "ld.plu.fix.subnet")
      : g.reason === "notInDiagram" ? (g.place?.kind === "otherVnet" ? "ld.plu.fix.otherVnet" : g.place?.kind === "onPremSite" ? "ld.plu.fix.onPremSite" : g.place?.kind === "private" ? "ld.plu.fix.private" : "ld.plu.fix.unknown")
        : g.reason === "peUnconfirmed" ? "ld.plu.fix.peUnconfirmed" : g.reason === "nicNoVm" ? "ld.plu.fix.nicNoVm" : null;
  const groupRow = (g: UnresolvedGroup) => (
    <div key={g.key} className={styles.dpTwoLine} data-plu-group={g.reason}>
      <span className={styles.dpTwoLineMain}>{groupHead(g)}</span>
      <span className={styles.dpTwoLineSub}>
        {t("ld.plu.group.stats", { ips: g.ips, requests: g.requests })}{g.lastSeen ? ` · ${ago(g.lastSeen)}` : ""}
        {fixKey(g) ? ` — ${t(fixKey(g)!)}` : ""}
      </span>
      {g.allIps.length ? (
        <details className={styles.dpDetails}>
          <summary>{g.sample.join(", ")}{g.allIps.length > g.sample.length ? ` ${t("ld.plu.group.more", { count: g.allIps.length - g.sample.length })}` : ""}</summary>
          <span className={styles.dpMono}>{g.allIps.join(", ")}</span> <CopyButton value={g.allIps.join("\n")} />
        </details>
      ) : null}
    </div>
  );
  const sourceLine = (s: PlSourceStatus) => {
    const target = s.targetNodeId ? byId.get(s.targetNodeId) : undefined;
    const vnet = spec.nodes.find((n) => n.icon === "vnet" && n.nodeType === "group" && !n.metadata?.ghostOf);
    const state = s.state === "ok" ? t("ld.plu.state.ok") : s.state === "empty" ? t("ld.plu.state.empty", { hours: usage.windowHours })
      : s.state === "signin" ? t("ld.plu.state.signin") : s.state === "failed" ? t("ld.plu.state.failed")
      : s.reason ? t(`ld.plu.reason.${s.reason}`, { service: s.service ?? "", category: s.category ?? "" }) : t("ld.plu.state.off");
    const cmd = s.state === "disabled" ? enableCommand(s, target, vnet) : null;
    return (
      <div key={`${s.source}:${s.targetNodeId ?? ""}`} className={styles.dpTwoLine} data-source-state={s.state}>
        <span className={styles.dpTwoLineMain}>
          {t(`ld.plu.src.${s.source}`)}{target && s.source !== "vnetFlow" ? <span className={styles.dpMuted}> · {nameOf(target.id)}</span> : null}
          {cmd ? <CopyButton value={cmd} label={t("ld.plu.copyCmd")} /> : null}
        </span>
        <span className={styles.dpTwoLineSub}>
          {state}
          {s.source === "vnetFlow" && s.state === "disabled" ? ` — ${t("ld.plu.howto.flow")}` : ""}
          {s.workspaceName ? ` · ${s.workspaceName}` : ""}
          {s.intervalMin ? ` · ${t("ld.plu.interval", { min: s.intervalMin })}` : ""}
        </span>
      </div>
    );
  };

  // ── a workload: the private services it uses ──
  if (reverse && !targetId) {
    const mine = usage.usages.filter((u) => u.callerNodeId === node.id);
    if (!mine.length) return null;
    return (
      <Section id="plu-reverse" title={t("ld.plu.reverseTitle")} count={mine.length}>
        {mine.map((u) => row(u, u.targetNodeId, u.peNodeId))}
        {kind === "aks" ? <div className={styles.dpMuted}>{t("ld.plu.nodeIp")}</div> : null}
      </Section>
    );
  }

  // ── a Private Endpoint or the PaaS behind it: who uses it ──
  const users = usage.usages.filter((u) => (asPe ? u.peNodeId === node.id : u.targetNodeId === node.id));
  const unresolved = usage.unresolved.filter((x) => x.targetNodeId === targetId && (!asPe || !x.peNodeId || x.peNodeId === node.id));
  const unresolvedGroups = groupUnresolved(unresolved);
  const pub = usage.publicAccess.find((p) => p.targetNodeId === targetId);
  const sources = usage.sources.filter((s) => s.targetNodeId === targetId || s.source === "vnetFlow");
  const looked = sources.some((s) => s.state === "ok" || s.state === "empty");
  const hasCompute = spec.nodes.some((n) => COMPUTE.has(kindOf(n)) && !n.metadata?.ghostOf);
  return (
    <Section id="plu" title={t("ld.plu.title")} count={users.length}>
      {asPe?.connectionState && asPe.connectionState !== "Approved" ? (
        <div className={styles.dpMuted} data-testid="pe-disconnected">{t("ld.plu.connState", { state: t(`ld.plu.conn.${asPe.connectionState}`) })}</div>
      ) : null}
      {users.map((u) => row(u, u.callerNodeId, asPe ? undefined : u.peNodeId))}
      {!users.length ? (
        <div className={styles.dpMuted} data-testid="plu-empty">
          {looked ? t("ld.plu.empty.none", { hours: usage.windowHours }) : t("ld.plu.empty.allOff")}
          {!hasCompute ? ` ${t("ld.plu.empty.noConsumer")}` : ""}
        </div>
      ) : null}
      {unresolvedGroups.length ? (
        <Group title={t("ld.plu.unresolvedTitle", { count: unresolvedCount(unresolved) })}>
          {unresolvedGroups.slice(0, showAllGroups ? undefined : 5).map(groupRow)}
          {unresolvedGroups.length > 5 && !showAllGroups ? (
            <button type="button" className={styles.dpLink} onClick={() => setShowAllGroups(true)}>{t("ld.plu.group.moreGroups", { count: unresolvedGroups.length - 5 })}</button>
          ) : null}
        </Group>
      ) : null}
      {pub ? <Notice tone="warning">{t("ld.plu.publicPath", { count: pub.requests, ips: pub.distinctIps })}</Notice> : null}
      <Group title={t("ld.plu.sources")}>
        {sources.map(sourceLine)}
      </Group>
    </Section>
  );
}

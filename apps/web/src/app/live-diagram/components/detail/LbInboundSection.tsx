"use client";

import type { DiagramEdgeSpec, DiagramNodeSpec, PlUnresolved, PrivateLinkUsageResponse } from "@aud/types";
import { formatBytes, lbInboundFacts } from "@/lib/lbInbound";
import { groupUnresolved, unresolvedCount, type UnresolvedGroup } from "@/lib/plUsage";
import { useI18n } from "@/lib/i18n";
import { Group, Section, TwoLine, useRelativeTime } from "./primitives";
import styles from "../../styles.module.css";

/**
 * An internal load balancer's inbound side (lib/lbInbound): its private frontends and what arrived on them in the
 * last hour, the configured callers (lines already drawn), the callers VNet flow logs saw, and what could not be
 * pinned. Facts only — 0 measured is "nothing came in the hour", no value is "not measured", and neither ever says
 * "nobody calls it" (traffic through a UDR is not counted; flow logs cover only VNets that have them).
 */
export function LbInboundSection({ node, spec, metrics, measured, usage, loading, nameOf, onSelectNode }: {
  node: DiagramNodeSpec;
  spec: { nodes: DiagramNodeSpec[]; edges: DiagramEdgeSpec[] };
  metrics: Record<string, number | null>;
  measured: boolean;
  usage: PrivateLinkUsageResponse | null | undefined;
  loading?: boolean;
  nameOf: (id: string) => string;
  onSelectNode?: (id: string) => void;
}) {
  const { t } = useI18n();
  const ago = useRelativeTime();
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const f = lbInboundFacts(node, spec.edges, byId, metrics, usage);
  if (!f) return null;

  const feLine = (fe: (typeof f.frontends)[number]) => (
    <TwoLine
      key={fe.ip}
      mono
      copy={fe.ip}
      main={fe.ip}
      sub={[
        fe.bytes == null
          ? t(measured ? "ld.lbin.fe.notMeasured" : "ld.lbin.fe.metricsOff")
          : fe.bytes === 0
            ? t("ld.lbin.fe.zero")
            : t("ld.lbin.fe.bytes", { bytes: formatBytes(fe.bytes), syn: fe.syn ?? "—" }),
        fe.ruleBound === false ? t("ld.lbin.fe.noRule") : null,
      ].filter(Boolean).join(" · ")}
    />
  );
  const reasonText = (g: UnresolvedGroup): string => {
    switch (g.reason) {
      case "nicNoVm": return t("ld.plu.nicNoVm", { name: g.nicName ?? "" });
      case "ambiguous": return t(g.basis === "identity" ? "ld.plu.group.ambiguousIdentity" : "ld.plu.group.ambiguousSubnet", { count: g.candidates.length });
      case "denied": return t("ld.plu.denied", { count: g.deniedFlows });
      case "notInDiagram": {
        const p = g.place;
        if (p?.kind === "otherVnet") return t("ld.plu.place.otherVnet", { vnet: nameOf(p.vnetNodeId), subnet: nameOf(p.subnetNodeId), owner: p.ownerNodeId ? ` (${nameOf(p.ownerNodeId)})` : "" });
        if (p?.kind === "onPremSite") return `${t("ld.plu.place.onPremSite", { prefix: p.prefix })} ${nameOf(p.siteNodeId)}`;
        if (p?.kind === "overlap") return t("ld.plu.place.overlap", { count: p.matches });
        if (p?.kind === "private") return t("ld.plu.place.private");
        if (p?.kind === "cgnat") return t("ld.plu.place.cgnat");
        return t("ld.plu.place.unknown");
      }
      default: return t("ld.plu.noIp");
    }
  };
  const flowLine = () => {
    if (!usage) return t(loading ? "live.loading" : "ld.plu.needOneVnet");
    switch (f.flowState) {
      case "ok": return t("ld.plu.state.ok");
      case "empty": return t("ld.lbin.flow.empty", { hours: usage.windowHours });
      case "signin": return t("ld.plu.state.signin");
      case "failed": return t("ld.plu.state.failed");
      default: return f.flowReason ? t(`ld.plu.reason.${f.flowReason}`, { service: "", category: "" }) : t("ld.plu.state.off");
    }
  };
  const unresolved: PlUnresolved[] = f.unresolved;
  const groups = groupUnresolved(unresolved);

  return (
    <Section id="lbin" title={t("ld.lbin.title")} count={f.configured.length + f.observed.length}>
      <Group title={t("ld.lbin.frontends")}>
        {f.frontends.map(feLine)}
        <div className={styles.dpMuted}>{t("ld.lbin.metricNote")}</div>
        <div className={styles.dpMuted}>{t("ld.lbin.probeNote")}</div>
      </Group>
      {/* UDR next hop (configuration): traffic sent this way is real but invisible to the LB byte / SYN metrics */}
      <Group title={t("ld.lbin.udr")}>
        {f.udr?.state === "unreadable" ? <div className={styles.dpMuted}>{t("ld.lbin.udr.unreadable")}</div>
          : f.udr && f.udr.entries.length ? (
            <>
              {f.udr.entries.slice(0, 10).map((e) => (
                <TwoLine key={`${e.vnet}/${e.subnet}/${e.frontendIp}`} main={`${e.subnet} (${e.vnet})`} sub={`${e.routeTable} · ${e.prefixes.join(", ")} → ${e.frontendIp}`} />
              ))}
              {f.udr.subnets > 10 ? <div className={styles.dpMuted}>{t("ld.lbin.udr.more", { count: f.udr.subnets - 10 })}</div> : null}
              <div className={styles.dpMuted}>{t("ld.lbin.udr.note")}</div>
            </>
          ) : <div className={styles.dpMuted}>{t("ld.lbin.udr.none")}</div>}
      </Group>
      <Group title={t("ld.lbin.configured")}>
        {f.configured.length ? f.configured.map((c) => (
          <TwoLine key={c.nodeId} main={nameOf(c.nodeId)} sub={t("ld.lbin.configuredWhy")} onClick={() => onSelectNode?.(c.nodeId)} />
        )) : <div className={styles.dpMuted}>{t("ld.lbin.configuredNone")}</div>}
      </Group>
      <Group title={t("ld.lbin.observed")}>
        {f.observed.map((c) => {
          const bytes = c.evidence.reduce((s, e) => s + (e.bytes ?? 0), 0);
          const ports = [...new Set(c.evidence.flatMap((e) => e.ports ?? []))].sort((a, b) => a - b);
          return (
            <TwoLine
              key={c.id}
              main={nameOf(c.callerNodeId)}
              sub={[t(`ld.plu.attr.${c.attribution}`), c.frontendIps.join(", "), bytes ? formatBytes(bytes) : null, ports.length ? `:${ports.join(",")}` : null, c.lastSeen ? ago(c.lastSeen) : null, t("ld.plu.delay")].filter(Boolean).join(" · ")}
              onClick={() => onSelectNode?.(c.callerNodeId)}
            />
          );
        })}
        {!f.observed.length ? <div className={styles.dpMuted}>{flowLine()}</div> : null}
        {groups.length ? (
          <>
            <div className={styles.dpMuted}>{t("ld.plu.unresolvedTitle", { count: unresolvedCount(unresolved) })}</div>
            {groups.slice(0, 5).map((g) => (
              <TwoLine key={g.key} main={reasonText(g)} sub={[g.sample.join(", "), g.lastSeen ? ago(g.lastSeen) : null].filter(Boolean).join(" · ")} />
            ))}
          </>
        ) : null}
      </Group>
      <div className={styles.dpMuted}>{t("ld.lbin.notCallers")}</div>
    </Section>
  );
}

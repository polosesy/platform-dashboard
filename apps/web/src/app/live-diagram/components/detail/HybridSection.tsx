"use client";

import type { DiagramNodeSpec, DiagramSpec } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { CopyButton, Group, KV, Section, TwoLine } from "./primitives";
import styles from "../../styles.module.css";

type Lng = { name: string; prefixes: string[]; peerIp: string | null; fqdn: string | null };
type Tunnel = { tunnel: string; status: string; lastConnected?: string };
const parse = <T,>(v: string | undefined, fallback: T): T => { try { return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const bytes = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let x = n, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x < 10 && i ? 1 : 0)} ${u[i]}`;
};

/**
 * S2S (catalog EDGE-08 / EDGE-09). On a VPN gateway: its connections (one row per on-premises site). On a site:
 * the connection, the local network gateway's address space and peer, tunnels and cumulative bytes — all read with
 * the topology ("at read time"), so they never colour the card; the live state is Resource Health and the metric.
 */
export function HybridSection({ node, spec, onSelectNode }: {
  node: DiagramNodeSpec;
  spec: DiagramSpec;
  onSelectNode?: (id: string) => void;
}) {
  const { t } = useI18n();
  const kind = node.resourceKind ?? node.icon;
  const m = node.metadata ?? {};

  if (kind === "vnetGateway") {
    const sites = spec.nodes.filter((n) => (n.resourceKind ?? n.icon) === "onPremSite" && n.metadata?.gatewayNodeId === node.id);
    return (
      <Section id="hybrid" title={t("ld.hybrid.gatewayTitle")} count={sites.length}>
        <KV label={t("ld.hybrid.sku")}>{[m.sku, m.activeActive === "true" ? t("ld.hybrid.activeActive") : null, m.enableBgp === "true" ? "BGP" : t("ld.hybrid.static")].filter(Boolean).join(" · ") || t("ld.peering.unknownValue")}</KV>
        {sites.length ? sites.map((s) => (
          <button key={s.id} type="button" className={styles.dpConn} onClick={() => onSelectNode?.(s.id)}>
            <span className={styles.dpConnArrow}>⇢</span>
            <span className={styles.dpConnRel}>{s.metadata?.protocol ?? "S2S"}</span>
            <span className={styles.dpConnPeer}>
              <span className={styles.dpConnName}><span className={styles.dpConnText} title={s.label}>{s.label}</span></span>
              <span className={styles.dpConnWhere}>{t(`ld.hybrid.status.${s.metadata?.connectionStatus ?? "Unknown"}`)} · {t("ld.hybrid.prefixes", { n: parse<Lng | null>(s.metadata?.lng, null)?.prefixes.length ?? 0 })}</span>
            </span>
          </button>
        )) : <div className={styles.dpMuted}>{t("ld.hybrid.noConnections")}</div>}
      </Section>
    );
  }

  if (kind !== "onPremSite") return null;
  const lng = parse<Lng | null>(m.lng, null);
  const tunnels = parse<Tunnel[] | null>(m.tunnels, null);
  const gw = m.gatewayNodeId ? spec.nodes.find((n) => n.id === m.gatewayNodeId) : undefined;
  return (
    <Section id="hybrid" title={t("ld.hybrid.siteTitle")}>
      <div className={styles.dpMuted}>{t("ld.hybrid.readTime")}</div>
      <KV label={t("ld.hybrid.connection")}>{[m.connectionName, m.protocol, m.bgp === "true" ? "BGP" : t("ld.hybrid.static"), m.policyBased === "true" ? t("ld.hybrid.policyBased") : null, m.nat === "true" ? "NAT" : null].filter(Boolean).join(" · ")}</KV>
      <KV label={t("ld.hybrid.statusLabel")}>{t(`ld.hybrid.status.${m.connectionStatus ?? "Unknown"}`)}</KV>
      {tunnels?.length ? (
        <Group title={t("ld.hybrid.tunnels", { up: tunnels.filter((x) => x.status === "Connected").length, n: tunnels.length })}>
          {tunnels.map((x) => <TwoLine key={x.tunnel} main={x.tunnel} mono sub={t(`ld.hybrid.status.${x.status}`)} />)}
        </Group>
      ) : null}
      {m.ingressBytes || m.egressBytes ? <KV label={t("ld.hybrid.cumulative")}>↓ {bytes(m.ingressBytes) ?? "—"} · ↑ {bytes(m.egressBytes) ?? "—"}</KV> : null}
      {lng ? (
        <Group title={t("ld.hybrid.lng", { name: lng.name })}>
          <KV label={t("ld.hybrid.space")}>{lng.prefixes.length ? lng.prefixes.join(", ") : t("ld.peering.unknownValue")}</KV>
          {lng.peerIp ? <KV label={t("ld.hybrid.peerIp")} mono copy={lng.peerIp}>{lng.peerIp}</KV> : null}
          {lng.fqdn ? <KV label="FQDN" mono>{lng.fqdn}</KV> : null}
        </Group>
      ) : null}
      {gw ? (
        <button type="button" className={styles.dpConn} onClick={() => onSelectNode?.(gw.id)}>
          <span className={styles.dpConnArrow}>⇠</span>
          <span className={styles.dpConnRel}>{t("ld.hybrid.via")}</span>
          <span className={styles.dpConnPeer}><span className={styles.dpConnName}><span className={styles.dpConnText}>{gw.label}</span></span></span>
        </button>
      ) : null}
      {node.azureResourceId ? <div className={styles.dpActions}><CopyButton value={node.azureResourceId} /></div> : null}
    </Section>
  );
}

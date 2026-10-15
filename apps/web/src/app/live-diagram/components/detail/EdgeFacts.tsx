"use client";

import type { DiagramNodeSpec, LiveEdge, LivePeering } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { formatBitsPerSec } from "@/lib/format";
import { peeringIssue } from "@/lib/livePeering";
import styles from "../../styles.module.css";

/** Each VNet's own side of one peering; a side is null when that VNet is not on the diagram or has no matching link */
export type PeeringPair = {
  a: { label: string; peering: LivePeering | null };
  b: { label: string; peering: LivePeering | null };
};

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <div className={styles.peerCmpRow}>
      <span className={styles.essentialsLabel}>{label}</span>
      <span className={styles.peerCmpCell}>{a}</span>
      <span className={styles.peerCmpCell}>{b}</span>
    </div>
  );
}

/**
 * A peering line (catalog EDGE-02): both VNets' sides next to each other — state, sync, the four flags, gateway
 * transit. Configuration only; Azure has no per-peering traffic metric, so traffic stays "미측정".
 */
export function PeeringEdgeFacts({ pair }: { pair: PeeringPair }) {
  const { t } = useI18n();
  const none = t("ld.peering.otherUnknown");
  const yesNo = (v: boolean | null | undefined) => (v == null ? t("ld.peering.unknownValue") : v ? t("ld.peering.yes") : t("ld.peering.no"));
  const side = (p: LivePeering | null, f: (p: LivePeering) => string) => (p ? f(p) : none);
  const { a, b } = pair;
  const reasons = [...new Set([a.peering, b.peering].flatMap((p) => (p ? peeringIssue(p).reasons : [])))];
  const transit = a.peering?.transit ?? b.peering?.transit ?? null;
  return (
    <div className={styles.essentialsList} data-testid="edge-peering">
      <div className={styles.peerCmpRow}>
        <span />
        <span className={styles.peerCmpHead} title={a.label}>{a.label}</span>
        <span className={styles.peerCmpHead} title={b.label}>{b.label}</span>
      </div>
      <Row label={t("ld.peering.col.state")} a={side(a.peering, (p) => t(`ld.peering.state.${p.state}`))} b={side(b.peering, (p) => t(`ld.peering.state.${p.state}`))} />
      <Row label={t("ld.peering.col.sync")} a={side(a.peering, (p) => (p.sync ? t(`ld.peering.sync.${p.sync}`) : t("ld.peering.unknownValue")))} b={side(b.peering, (p) => (p.sync ? t(`ld.peering.sync.${p.sync}`) : t("ld.peering.unknownValue")))} />
      {(["access", "forwarded", "gatewayTransit", "useRemoteGateways"] as const).map((f) => (
        <Row key={f} label={t(`ld.peering.flag.${f}`)} a={side(a.peering, (p) => yesNo(p[f]))} b={side(b.peering, (p) => yesNo(p[f]))} />
      ))}
      <div className={styles.essentialsRow}>
        <span className={styles.essentialsLabel}>{t("ld.peering.transitLabel")}</span>
        <span className={styles.essentialsValue}>
          {transit === "uses" ? t("ld.peering.transitPair", { user: a.label, gateway: b.label })
            : transit === "provides" ? t("ld.peering.transitPair", { user: b.label, gateway: a.label })
            : t("ld.peering.transitNone")}
        </span>
      </div>
      {reasons.length ? (
        <div className={styles.essentialsRow}>
          <span className={styles.essentialsLabel}>{t("ld.peering.attention")}</span>
          <span className={styles.essentialsValue}>{reasons.map((r) => t(r)).join(" · ")}</span>
        </div>
      ) : null}
      <div className={styles.essentialsRow}>
        <span className={styles.essentialsLabel}>{t("ld.coverage.traffic")}</span>
        <span className={styles.essentialsValue}>{t("ld.peering.noTraffic")}</span>
      </div>
    </div>
  );
}

/**
 * VPN gateway → on-premises site (catalog EDGE-09): the connection as read with the topology, and the measured
 * BitsIn/BitsOut of the connection resource when Azure Monitor reported them.
 */
export function SiteEdgeFacts({ site, metrics }: { site: DiagramNodeSpec; metrics?: LiveEdge["metrics"] }) {
  const { t } = useI18n();
  const m = site.metadata ?? {};
  let prefixes: string[] = [];
  try { prefixes = (JSON.parse(m.lng ?? "null") as { prefixes?: string[] } | null)?.prefixes ?? []; } catch { /* none */ }
  const row = (label: string, value: string) => (
    <div className={styles.essentialsRow}>
      <span className={styles.essentialsLabel}>{label}</span>
      <span className={styles.essentialsValue}>{value}</span>
    </div>
  );
  return (
    <div className={styles.essentialsList} data-testid="edge-s2s">
      {row(t("ld.hybrid.connection"), [m.connectionName, m.protocol, m.bgp === "true" ? "BGP" : t("ld.hybrid.static")].filter(Boolean).join(" · "))}
      {row(t("ld.hybrid.statusLabel"), `${t(`ld.hybrid.status.${m.connectionStatus ?? "Unknown"}`)} (${t("ld.hybrid.readTimeShort")})`)}
      {row(t("ld.hybrid.space"), prefixes.length ? prefixes.join(", ") : t("ld.peering.unknownValue"))}
      {metrics?.siteInBps != null || metrics?.siteOutBps != null
        ? row(t("ld.hybrid.live"), t("ld.hybrid.liveValue", { in: metrics?.siteInBps != null ? formatBitsPerSec(metrics.siteInBps) : "—", out: metrics?.siteOutBps != null ? formatBitsPerSec(metrics.siteOutBps) : "—" }))
        : row(t("ld.coverage.traffic"), t("ld.edge.unmeasured"))}
    </div>
  );
}

"use client";

import { useI18n } from "@/lib/i18n";
import { Section, TwoLine } from "./primitives";
import styles from "../../styles.module.css";

type Route = { prefix: string; nextHopType: string; nextHopIp?: string; target?: { id: string; kind: string }; unresolved?: string; ipForwardingOff?: boolean };
type Routes = { state: "ok" | "unreadable"; routeTable: { name: string; bgpPropagation: boolean } | null; routes: Route[]; total: number };

/**
 * A subnet's route table as configured (API resolveSubnetRoutes): each prefix → next hop, and what the hop resolves
 * to — the one appliance holding the address in reach (SEC-04), the VNet gateway (NET-07) — or why it does not.
 * Configuration, not effective routes. Lines to drawn next hops are the "UDR 경로" layer.
 */
export function UdrRoutesSection({ meta, cardOf, nameOf, onSelectNode }: {
  meta: Record<string, string> | undefined;
  /** prefix → the card its next hop is drawn as (the subnet's "udr-route" lines), when in view */
  cardOf: ReadonlyMap<string, string>;
  nameOf: (id: string) => string;
  onSelectNode?: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!meta?.udrRoutes) return null;
  let r: Routes;
  try { r = JSON.parse(meta.udrRoutes) as Routes; } catch { return null; }
  if (r.state === "unreadable") {
    return <Section id="udr" title={t("ld.panel.udr")}><div className={styles.dpMuted}>{t("ld.lbin.udr.unreadable")}</div></Section>;
  }
  const hop = (x: Route): string => {
    const type = x.nextHopType.toLowerCase();
    const word = t(`ld.udr.hop.${type === "virtualappliance" ? "appliance" : type === "virtualnetworkgateway" ? "gateway" : type === "internet" ? "internet" : type === "none" ? "none" : type === "vnetlocal" ? "vnetLocal" : "other"}`);
    const card = cardOf.get(x.prefix);
    // the drawn card's name; a next hop outside the view by its resource name; an unresolved one by the reason
    const where = card ? nameOf(card) : x.target ? `${x.target.id.split("/").pop() ?? ""} · ${t("ld.udr.outOfView")}` : x.unresolved ? t(`ld.udr.reason.${x.unresolved}`) : "";
    return [word, x.nextHopIp, where, x.ipForwardingOff ? t("ld.udr.ipForwardingOff") : ""].filter(Boolean).join(" · ");
  };
  return (
    <Section id="udr" title={t("ld.panel.udr")} count={r.total}>
      {r.routeTable ? <TwoLine main={r.routeTable.name} sub={t(r.routeTable.bgpPropagation ? "ld.udr.bgpOn" : "ld.udr.bgpOff")} /> : null}
      {r.routes.map((x, i) => {
        const card = cardOf.get(x.prefix);
        return <TwoLine key={`${x.prefix}-${i}`} mono main={x.prefix} sub={hop(x)} {...(card && onSelectNode ? { onClick: () => onSelectNode(card) } : {})} />;
      })}
      {r.total > r.routes.length ? <div className={styles.dpMuted}>{t("ld.lbin.udr.more", { count: r.total - r.routes.length })}</div> : null}
      <div className={styles.dpMuted}>{t("ld.lbin.udr.note")}</div>
    </Section>
  );
}

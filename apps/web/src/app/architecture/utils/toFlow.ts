import { MarkerType, type Edge, type Node } from "reactflow";
import { shownExit, type ArchDrawEdge, type ArchEdgeKind, type ArchHeadItem, type ArchLayout, type ArchModel, type ArchPlaced } from "@/lib/archModel";
import { getAzureIconUrl } from "@/app/live-diagram/utils/azureIcons";
import { formatAzureRegion } from "@/app/live-diagram/utils/regionFormat";
import type { ArchBadge, ArchHeadCell, ArchNodeData } from "../components/ArchNodes";
import type { ArchEdgeData } from "../components/ArchEdge";
import { EDGE_LOOK, lookOf, strokeOf, strokeOfLook } from "@/lib/archStyle";
import { hex } from "@/lib/palette";
import { maskGuids } from "@/lib/mask";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Line style per relationship — derived from the shared table in lib/archStyle (legend and draw.io use it too). */
export const EDGE_STYLE = Object.fromEntries(
  (Object.keys(EDGE_LOOK) as Array<keyof typeof EDGE_LOOK>).map((k) => [k, { stroke: strokeOf(k), dash: EDGE_LOOK[k].dash, width: EDGE_LOOK[k].width, arrow: EDGE_LOOK[k].arrow }]),
) as Record<ArchEdgeKind | "traffic", { stroke: string; dash?: string; width: number; arrow: boolean }>;

/** Region box title: "global" and "unknown" (no location reported, catalog REG-03) have names of their own */
export const regionName = (k: string, t: T) => (k === "global" ? t("arch.lane.global") : k === "unknown" ? t("arch.region.unknown") : formatAzureRegion(k));

/** Category-filter facts needed to label the filtered view honestly */
export type FilterMarks = {
  /** Resources shown only as connection context */
  context: ReadonlySet<string>;
  /** VNet / subnet id → resources hidden inside it by the filter */
  hiddenIn: ReadonlyMap<string, number>;
};
const NO_MARKS: FilterMarks = { context: new Set(), hiddenIn: new Map() };

/** Node data for every shape. Rebuilt only when the layout, the filter or the locale changes. */
export function buildNodes(model: ArchModel, layout: ArchLayout, t: T, marks: FilterMarks = NO_MARKS): Node<ArchNodeData>[] {
  const kindLabel = (k: string) => {
    const key = `arch.kind.${k}`;
    const v = t(key);
    return v === key ? k : v;
  };
  const links = linkFacts(model);
  return layout.shapes.map((sh): Node<ArchNodeData> => {
    // width / height = the layout's own size. React Flow 11 rebuilds its node internals from the node objects on every
    // `nodes` change and treats a node without a size as "not measured yet" (visibility hidden until its
    // ResizeObserver reports) — without these every update (a drag frame, a selection) made the whole picture blink
    const base = { id: sh.id, position: { x: sh.x, y: sh.y }, width: sh.w, height: sh.h, draggable: false, connectable: false, focusable: false };
    if (sh.shape === "box") {
      return {
        ...base,
        type: "archBox",
        // The wrapper lets pointer events through, so panning and pane clicks work inside boundaries
        style: { width: sh.w, height: sh.h, pointerEvents: "none" },
        zIndex: 0,
        data: boxData(model, sh, t, marks, links),
      };
    }
    return { ...base, type: "archTile", style: { width: sh.w, height: sh.h }, zIndex: 2, data: tileData(model, sh, t, kindLabel, marks, links) };
  });
}

/** Facts of the focus-only lines, kept on the tiles as chips (configuration, from model.edges) */
type LinkFacts = {
  peTargets: Map<string, string[]>; peSources: Map<string, number>; integratedFrom: Map<string, string[]>;
  /** NAT / appliance → names of the subnets whose first exit it is; egressKnown = the API read the exits */
  exitsVia: Map<string, string[]>; egressKnown: boolean;
  /** VNet → its peerings (count, not Connected) */
  peerings: Map<string, { n: number; down: number }>;
};
function linkFacts(model: ArchModel): LinkFacts {
  const peTargets = new Map<string, string[]>(), peSources = new Map<string, number>(), integratedFrom = new Map<string, string[]>();
  const exitsVia = new Map<string, string[]>();
  let egressKnown = false;
  for (const sb of model.subnets.values()) {
    if (!sb.egress) continue;
    egressKnown = true;
    const tgt = sb.egress.targetId?.toLowerCase();
    if (tgt && (sb.egress.via === "nat" || sb.egress.via === "appliance")) (exitsVia.get(tgt) ?? exitsVia.set(tgt, []).get(tgt)!).push(sb.node.name);
  }
  const peerings = new Map<string, { n: number; down: number }>();
  for (const e of model.edges) {
    if (e.kind !== "peering") continue;
    for (const v of [e.source, e.target]) {
      const p = peerings.get(v) ?? peerings.set(v, { n: 0, down: 0 }).get(v)!;
      p.n++;
      if ((e.state ?? "Connected").toLowerCase() !== "connected") p.down++;
    }
  }
  for (const e of model.edges) {
    if (e.kind === "privateLink") {
      (peTargets.get(e.source) ?? peTargets.set(e.source, []).get(e.source)!).push(model.nodes.get(e.target)?.name ?? e.target);
      peSources.set(e.target, (peSources.get(e.target) ?? 0) + 1);
    } else if (e.kind === "vnetIntegration") {
      (integratedFrom.get(e.target) ?? integratedFrom.set(e.target, []).get(e.target)!).push(model.nodes.get(e.source)?.name ?? e.source);
    }
  }
  return { peTargets, peSources, integratedFrom, exitsVia, egressKnown, peerings };
}

/** Region marker (a location pin, not the subscription key) — inline SVG, colour from the palette */
const REGION_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${hex("accent")}" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>`,
)}`;

function boxData(model: ArchModel, sh: Extract<ArchPlaced, { shape: "box" }>, t: T, marks: FilterMarks, links: LinkFacts): ArchNodeData {
  const badges: ArchBadge[] = [];
  const hidden = marks.hiddenIn.get(sh.id) ?? 0;
  const hiddenBadge: ArchBadge | null = hidden ? { text: t("arch.filter.hiddenIn", { n: hidden }), tone: "muted", title: t("arch.filter.hiddenInHint") } : null;
  if (sh.type === "subscription") {
    const title = maskGuids(sh.label) || t("arch.box.subscription");
    return { shape: sh, title, sub: t("arch.box.subscription"), icon: "/azure-icons/subscription.svg", badges, ariaLabel: `${t("arch.box.subscription")} ${title}`, variant: "subscription" };
  }
  if (sh.type === "external") {
    const title = t("arch.lane.external");
    return { shape: sh, title, badges, ariaLabel: title, variant: "external" };
  }
  if (sh.type === "region") {
    const reg = model.regions.find((r) => `region:${r.key}` === sh.id)!;
    if (reg.unusedPublicIps.length) badges.push({ text: t("arch.unusedPip", { n: reg.unusedPublicIps.length }), tone: "warn" });
    if (reg.unresolvedPublicIps.length) badges.push({ text: t("arch.unresolvedPip", { n: reg.unresolvedPublicIps.length }), tone: "muted" });
    if (reg.unusedNsgs.length) badges.push({ text: t("arch.unusedNsg", { n: reg.unusedNsgs.length }), tone: "muted" });
    const title = regionName(reg.key, t);
    return { shape: sh, title, sub: reg.key, icon: REGION_ICON, badges, ariaLabel: `${t("arch.box.region")} ${title}`, variant: "region" };
  }
  if (sh.type === "vnet") {
    const v = model.vnets.get(sh.id)!;
    const n = v.subnets.reduce((k, s) => k + s.resources.length, 0);
    badges.push({ text: t("arch.subnetsN", { n: v.subnets.length }), tone: "muted" });
    const pe = links.peerings.get(sh.id);
    if (pe) badges.push(pe.down ? { text: t("arch.badge.peeringDown", { n: pe.n, k: pe.down }), tone: "warn" } : { text: t("arch.badge.peeringN", { n: pe.n }), tone: "info" });
    if (hiddenBadge) badges.push(hiddenBadge);
    return {
      shape: sh, title: v.node.name, sub: v.node.endpoint, icon: getAzureIconUrl("vnet"), badges,
      toggle: "collapse", toggleLabel: `${t("arch.collapse")} ${v.node.name}`,
      ariaLabel: `VNet ${v.node.name} ${v.node.endpoint ?? ""}, ${t("arch.resourcesN", { n })}`, variant: "vnet",
    };
  }
  if (sh.type === "subnet") {
    const sb = model.subnets.get(sh.id)!;
    if (sb.nsgs.length) badges.push({ text: sb.nsgs.length > 1 ? `NSG ${sb.nsgs.length}` : `NSG ${sb.nsgs[0]}`, tone: "info", title: sb.nsgs.join(", ") });
    // The subnet → NAT line is drawn on selection only (FOCUS_KINDS): the badge names the gateway
    if (sb.natGateways.length) {
      const nat = sb.natGateways.length > 1 ? `NAT ${sb.natGateways.length}` : `NAT ${sb.natGateways[0]}`;
      badges.push(sb.egress?.natBypassed
        ? { text: `${nat} · ${t("arch.egress.bypassed")}`, tone: "muted", title: `${sb.natGateways.join(", ")} — ${t("arch.egress.bypassedHint")}` }
        : { text: nat, tone: "muted", title: sb.natGateways.join(", ") });
    }
    const exitBadge: ArchBadge | null = shownExit(sb.egress) ? (() => {
      const e = sb.egress!;
      const target = e.targetId ? maskGuids(model.nodes.get(e.targetId.toLowerCase())?.name ?? "") : "";
      const why = [e.routeTable ? `UDR ${e.routeTable.name} ${e.routeTable.prefix}` : "", e.nextHopIp ? `→ ${e.nextHopIp}` : "", e.bgpMayOverride ? t("arch.egress.bgp") : ""].filter(Boolean).join(" · ");
      if (e.via === "appliance") return target ? { text: `UDR → ${target}`, tone: "warn", title: why } : { text: t(`arch.egress.unresolved.${e.unresolved ?? "none"}`, { ip: e.nextHopIp ?? "" }), tone: "warn", title: why };
      if (e.via === "gateway") return { text: t(e.evidence === "lngDefault" ? "arch.egress.tunnel" : "arch.egress.gateway"), tone: "info", title: why };
      if (e.via === "dropped") return { text: t("arch.egress.dropped"), tone: "danger", title: why };
      return { text: t("arch.egress.unknown"), tone: "muted", title: why };
    })() : null;
    if (exitBadge) badges.push(exitBadge);
    if (sb.publicIps.length) badges.push({ text: t("arch.pipN", { n: sb.publicIps.length }), tone: "danger", title: sb.publicIps.join(", ") });
    if (sb.otherNics) badges.push({ text: t("arch.otherNics", { n: sb.otherNics }), tone: "muted", title: t("arch.otherNicsHint") });
    if (hiddenBadge) badges.unshift(hiddenBadge);
    // The header rows the layout reserved (lib/archModel subnetHead): same items, same order
    const byKey: Partial<Record<ArchHeadItem["k"], ArchBadge>> = {
      nsg: badges.find((b) => b.text.startsWith("NSG")),
      nat: badges.find((b) => b.text.startsWith("NAT")),
      egress: exitBadge ?? undefined,
      pip: sb.publicIps.length ? badges.find((b) => b.tone === "danger") : undefined,
      nic: sb.otherNics ? badges.find((b) => b.title === t("arch.otherNicsHint")) : undefined,
      hidden: hiddenBadge ?? undefined,
    };
    const rows = sh.rows?.map((row) => row.flatMap((it): ArchHeadCell[] => {
      if (it.k === "name" || it.k === "cidr") return [{ k: it.k }];
      if (it.k === "more") {
        return [{ k: "badge", badge: { text: `+${it.n ?? 0}`, tone: "muted", title: badges.map((b) => b.text).join(" · ") } }];
      }
      const b = byKey[it.k];
      return b ? [{ k: "badge", badge: b }] : [];
    }));
    return { shape: sh, title: sb.node.name, sub: sb.node.endpoint, badges, ariaLabel: `${t("arch.box.subnet")} ${sb.node.name} ${sb.node.endpoint ?? ""}`, variant: "subnet", ...(rows ? { rows } : {}) };
  }
  if (sh.type === "group") {
    const title = t(`arch.paas.${sh.label}`);
    return { shape: sh, title, badges, ariaLabel: title, variant: "group" };
  }
  const title = t(`arch.lane.${sh.label}`);
  return { shape: sh, title, badges, ariaLabel: title, variant: sh.type === "global" ? "global" : "lane" };
}

function tileData(model: ArchModel, sh: Exclude<ArchPlaced, { shape: "box" }>, t: T, kindLabel: (k: string) => string, marks: FilterMarks, links: LinkFacts): ArchNodeData {
  if (sh.shape === "internet") {
    if (sh.out) return { shape: sh, title: t("arch.internetOut"), sub: t("arch.internetOutSub"), badges: [], ariaLabel: t("arch.internetOut") };
    return { shape: sh, title: t("arch.internet"), sub: t("arch.internetSub"), badges: [], ariaLabel: t("arch.internet") };
  }
  if (sh.shape === "site") {
    const st = model.sites.get(sh.ref)!;
    const badges: ArchBadge[] = [];
    if (st.prefixes.length) badges.push({ text: st.prefixes.length > 1 ? `${st.prefixes[0]} +${st.prefixes.length - 1}` : st.prefixes[0]!, tone: "info", title: st.prefixes.join(", ") });
    if (st.bgp) badges.push({ text: "BGP", tone: "muted" });
    const down = st.connections.filter((c) => c.status.toLowerCase() !== "connected");
    if (down.length) badges.push({ text: t("arch.site.notConnected", { n: down.length }), tone: "warn", title: `${down.map((c) => `${c.name}: ${c.status}`).join(", ")} — ${t("arch.site.statusAt")}` });
    if (st.connections.length > 1) badges.push({ text: t("arch.site.connections", { n: st.connections.length }), tone: "muted" });
    return {
      shape: sh, title: maskGuids(st.name), sub: t(st.lngKnown ? "arch.site.sub" : "arch.site.subUnknown"), meta: st.peerIp ?? st.fqdn ?? undefined,
      icon: "/azure-icons/onprem-site.svg", badges, ariaLabel: `${t("arch.site.sub")} ${st.name}`,
    };
  }
  if (sh.shape === "pill") {
    const v = model.vnets.get(sh.ref)!;
    const n = v.subnets.reduce((k, s) => k + s.resources.length, 0);
    const hidden = marks.hiddenIn.get(sh.ref) ?? 0;
    // With a filter, "shown / all" — a VNet whose tiles are only hidden must not read as empty
    const res = hidden ? t("arch.filter.resourcesShown", { n, total: n + hidden }) : t("arch.resourcesN", { n });
    return {
      shape: sh, title: v.node.name, sub: v.node.endpoint, meta: `${t("arch.subnetsN", { n: v.subnets.length })} · ${res}`,
      icon: getAzureIconUrl("vnet"), badges: [], ariaLabel: `VNet ${v.node.name}, ${t("arch.clickExpand")}`,
    };
  }
  if (sh.shape === "stack") {
    const title = t("arch.stackOf", { kind: kindLabel(sh.kind), n: sh.members.length });
    return { shape: sh, title, sub: t("arch.clickExpand"), icon: getAzureIconUrl(sh.kind), badges: [], toggle: "expand", ariaLabel: `${title}, ${t("arch.clickExpand")}` };
  }
  if (sh.shape === "fold") {
    const title = t("arch.stackOf", { kind: kindLabel(sh.kind), n: sh.n });
    return { shape: sh, title, sub: t("arch.clickFold"), icon: getAzureIconUrl(sh.kind), badges: [], toggle: "collapse", ariaLabel: `${title}, ${t("arch.clickFold")}` };
  }
  const ref = sh.ref;
  const r = model.resources.get(ref);
  if (!r) {
    // Ghost of a VNet in another region (peering)
    const v = model.vnets.get(ref);
    const n = v?.node ?? model.nodes.get(ref);
    const where = v ? regionName(v.region, t) : "";
    return { shape: sh, title: n?.name ?? ref, sub: `${kindLabel(n?.kind ?? "unknown")} · ${t("arch.inRegion", { region: where })}`, icon: getAzureIconUrl(n?.kind ?? "custom"), badges: [], ariaLabel: n?.name ?? ref };
  }
  const k = r.node.kind;
  if (sh.shape === "ghost") {
    return { shape: sh, title: r.node.name, sub: `${kindLabel(k)} · ${t("arch.inRegion", { region: regionName(r.region, t) })}`, icon: getAzureIconUrl(k), badges: [], ariaLabel: r.node.name };
  }
  const badges: ArchBadge[] = [];
  if (r.publicIps.length) {
    // Tone follows the NSG verdict (PIP-04): open = danger, scoped = warn, closed / no NSG = muted, unknown = info
    const tone: ArchBadge["tone"] = !r.exposure || r.exposure === "open" ? "danger" : r.exposure === "scoped" ? "warn" : r.exposure === "unknown" ? "info" : "muted";
    const state = r.exposure ? ` · ${t(`arch.exposure.${r.exposure}`)}` : "";
    badges.push({ text: r.publicIps.length > 1 ? t("arch.pipN", { n: r.publicIps.length }) : `${t("arch.i.publicIp")} ${r.publicIps[0]}`, tone, title: r.publicIps.join(", ") + state });
  }
  if (r.nsgs.length) badges.push({ text: r.nsgs.length > 1 ? `NSG ${r.nsgs.length}` : "NSG", tone: "info", title: r.nsgs.join(", ") });
  if (r.nicCount > 1) badges.push({ text: t("arch.nicN", { n: r.nicCount }), tone: "muted" });
  if (r.nodePools.length) badges.push({ text: t("arch.poolsN", { n: r.nodePools.length }), tone: "muted", title: r.nodePools.join(", ") });
  if (r.instances.length) badges.push({ text: t("arch.badge.instances", { n: r.instances.length }), tone: "muted", title: r.instances.join(", ") });
  if (r.extraSubnets.length) badges.push({ text: t("arch.moreSubnets", { n: r.extraSubnets.length }), tone: "muted" });
  // Private Link / VNet integration lines appear on selection; their ends stay readable without it
  const peTo = links.peTargets.get(r.id);
  if (peTo?.length) badges.push({ text: peTo.length > 1 ? t("arch.badge.peToN", { n: peTo.length }) : `→ ${maskGuids(peTo[0]!)}`, tone: "info", title: peTo.map(maskGuids).join(", ") });
  const peFrom = links.peSources.get(r.id);
  if (peFrom) badges.push({ text: t("arch.badge.peFrom", { n: peFrom }), tone: "info" });
  const integrated = links.integratedFrom.get(r.id);
  if (integrated?.length) badges.push({ text: t("arch.badge.vnetInt"), tone: "muted", title: integrated.join(", ") });
  // NET-09: which subnets actually leave through this NAT / appliance (the first exit only)
  const exits = links.exitsVia.get(r.id);
  if (k === "natGateway" && links.egressKnown) {
    badges.push(exits?.length
      ? { text: t("arch.badge.exitSubnets", { n: exits.length }), tone: "muted", title: exits.join(", ") }
      : { text: t("arch.badge.notExit"), tone: "warn", title: t("arch.badge.notExitHint") });
  } else if (exits?.length) badges.push({ text: t("arch.badge.udrExit", { n: exits.length }), tone: "info", title: exits.join(", ") });
  const context = marks.context.has(r.id);
  const endpoint = r.node.endpoint && r.node.endpoint.length < 48 && !r.publicIps.includes(r.node.endpoint) ? r.node.endpoint : undefined;
  const ip = r.privateIps[0] ?? endpoint;
  return {
    shape: sh, title: r.node.name, sub: kindLabel(k), meta: ip, icon: getAzureIconUrl(k), badges,
    context, ariaLabel: `${context ? t("arch.filter.contextTile") + " · " : ""}${kindLabel(k)} ${r.node.name}${ip ? `, ${ip}` : ""}`,
  };
}

/**
 * React Flow edges along the routes of lib/archRoute. Focus lines (FOCUS_KINDS) are left out unless one of their
 * ends is `selected` — their facts stay on the tiles as chips (tileData / boxData).
 */
export function buildEdges(edges: ArchDrawEdge[], t: T, selected: string | null = null): Edge<ArchEdgeData>[] {
  return edges
    .filter((e) => e.display === "always" || (selected !== null && (e.source === selected || e.target === selected)))
    .map((e) => {
      const look = lookOf(e.kind, e.state);
      const st = { stroke: strokeOfLook(look), dash: look.dash, width: look.width, arrow: look.arrow };
      const width = st.width + (e.count > 1 ? Math.min(e.count, 6) * 0.4 : 0);
      const peering = e.kind === "peering";
      const state = e.state ?? "Connected";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "archPath",
        zIndex: 1,
        focusable: false,
        selectable: false,
        data: {
          points: e.points, ...(e.manual === "curve" ? { curve: true } : {}),
          // Peering: a pipe of two rails (Connected) with a chain-link badge; its state word when not Connected
          ...(peering ? { rail: state.toLowerCase() === "connected", glyph: "chain" as const, glyphTitle: `${t("arch.edge.peering")} · ${t(`arch.peering.state.${["connected", "initiated", "disconnected"].includes(state.toLowerCase()) ? state.toLowerCase() : "unknown"}`)}`, ...(state.toLowerCase() !== "connected" ? { glyphText: t(`arch.peering.state.${["initiated", "disconnected"].includes(state.toLowerCase()) ? state.toLowerCase() : "unknown"}`) } : {}) } : {}),
        },
        label: peering ? undefined : e.count > 1 ? `×${e.count}` : undefined,
        labelStyle: { fontSize: 10, fontWeight: 700, fill: st.stroke },
        // white label background — the canvas is light in both themes (exported PNG too)
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        style: { stroke: st.stroke, strokeWidth: width, strokeDasharray: st.dash },
        markerEnd: st.arrow ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color: st.stroke } : undefined,
      };
    });
}

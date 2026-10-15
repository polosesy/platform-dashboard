// VNet peerings on the live diagram (catalog EDGE-02) — pure, tested from apps/api/test/livePeering.test.ts.
// The API sends each VNet's own side of every peering (metadata.peerings, LivePeering[] as JSON): flags it does not
// know are null and stay "미확인" here. Nothing calls a VNet a hub — only facts (counts, gateway transit flags).
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramSpec, LivePeering } from "@aud/types";

export type PeeringTone = "warn" | "neutral" | "unknown" | "ok";

/** The VNet's peerings from its metadata; malformed or older entries are normalised, unknown flags stay null */
export function parsePeerings(raw: string | undefined): LivePeering[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<Partial<LivePeering>>;
    return list.filter((p) => p && (p.name || p.key)).map((p, i) => ({
      key: String(p.key ?? p.link ?? p.name ?? `peer-${i}`),
      link: String(p.link ?? ""),
      id: p.id ?? null,
      name: String(p.name ?? ""),
      state: String(p.state ?? "Unknown"),
      sync: p.sync ?? null,
      provisioning: p.provisioning ?? null,
      access: p.access ?? null,
      forwarded: p.forwarded ?? null,
      gatewayTransit: p.gatewayTransit ?? null,
      useRemoteGateways: p.useRemoteGateways ?? null,
      remoteSpace: Array.isArray(p.remoteSpace) ? p.remoteSpace : [],
      remoteCurrentSpace: Array.isArray(p.remoteCurrentSpace) ? p.remoteCurrentSpace : null,
      complete: p.complete ?? null,
      ...(p.localSubnets ? { localSubnets: p.localSubnets } : {}),
      ...(p.remoteSubnets ? { remoteSubnets: p.remoteSubnets } : {}),
      ...(p.other ? { other: p.other } : {}),
      transit: p.transit ?? null,
    }));
  } catch {
    return [];
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * What a peering needs attention for (i18n keys), and its tone: warn = not Connected / provisioning not done /
 * address spaces out of sync / transit half set up; neutral = remote access off (may be intended); unknown =
 * state unknown. Never red (red is fault impact only).
 */
export function peeringIssue(p: LivePeering): { tone: PeeringTone; reasons: string[] } {
  const warn: string[] = [];
  if (p.state === "Unknown") return { tone: "unknown", reasons: ["ld.peering.unknown"] };
  if (p.state !== "Connected") warn.push(`ld.peering.state.${p.state}`);
  if (p.provisioning && p.provisioning !== "Succeeded") warn.push("ld.peering.provisioning");
  if ((p.sync && p.sync !== "FullyInSync") || (p.remoteCurrentSpace && !sameSet(p.remoteSpace, p.remoteCurrentSpace))) warn.push("ld.peering.syncNeeded");
  if (p.useRemoteGateways === true && p.other && p.other.gatewayTransit === false) warn.push("ld.peering.transitHalf");
  if (warn.length) return { tone: "warn", reasons: warn };
  if (p.access === false) return { tone: "neutral", reasons: ["ld.peering.accessOff"] };
  return { tone: "ok", reasons: [] };
}

const RANK: Record<PeeringTone, number> = { warn: 0, unknown: 1, neutral: 2, ok: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Problems first, then gateway transit, then the ones on this diagram, then by name (code points) — deterministic */
export function sortPeerings(list: readonly LivePeering[]): LivePeering[] {
  return [...list].sort((a, b) =>
    RANK[peeringIssue(a).tone] - RANK[peeringIssue(b).tone]
    || Number(!a.transit) - Number(!b.transit)
    || Number(!a.id) - Number(!b.id)
    || cmp(a.name, b.name) || cmp(a.key, b.key));
}

export const PEER_CHIP = { SUMMARY_W: 120, NAME_W: 132, MORE_W: 44, GAP: 6, PAD: 16 };

/** How many name chips fit on the one peering row of a VNet header this wide (summary and "+n" counted) */
export function peeringChipFit(width: number, n: number): number {
  if (n <= 0) return 0;
  const room = width - 2 * PEER_CHIP.PAD - PEER_CHIP.SUMMARY_W - PEER_CHIP.GAP;
  const per = PEER_CHIP.NAME_W + PEER_CHIP.GAP;
  const all = Math.floor((room + PEER_CHIP.GAP) / per);
  if (all >= n) return n;
  return Math.max(0, Math.floor((room - PEER_CHIP.MORE_W) / per));
}

/** Facts for the header summary chip: count, problems, gateway transit roles */
export function peeringSummary(list: readonly LivePeering[]): { n: number; problems: number; provides: number; uses: number } {
  return {
    n: list.length,
    problems: list.filter((p) => peeringIssue(p).tone === "warn").length,
    provides: list.filter((p) => p.transit === "provides").length,
    uses: list.filter((p) => p.transit === "uses").length,
  };
}

/**
 * A peering line's two sides: each VNet's own link to the other (matched by the peer's node id). A side is null when
 * that VNet is not in the diagram or lists no link back — the panel says "확인 불가", never guesses.
 */
export function peeringPairOf(spec: DiagramSpec | null | undefined, edge: DiagramEdgeSpec | null | undefined): {
  a: { label: string; peering: LivePeering | null };
  b: { label: string; peering: LivePeering | null };
} | null {
  if (!spec || !edge || edge.edgeKind !== "peering") return null;
  const node = (id: string) => spec.nodes.find((n) => n.id === id);
  const side = (self: string, other: string) => {
    const n = node(self);
    return { label: n?.label ?? self, peering: parsePeerings(n?.metadata?.peerings).find((p) => p.id === other) ?? null };
  };
  return { a: side(edge.source, edge.target), b: side(edge.target, edge.source) };
}

/** The on-premises site at the end of a VPN gateway → site line (S2S) */
export function siteOfEdge(spec: DiagramSpec | null | undefined, edge: DiagramEdgeSpec | null | undefined): DiagramNodeSpec | null {
  if (!spec || !edge || edge.edgeKind !== "hybrid") return null;
  const n = spec.nodes.find((x) => x.id === edge.target);
  return n && (n.resourceKind ?? n.icon) === "onPremSite" ? n : null;
}

// VPN gateway and on-premises site cards (catalog EDGE-08 / EDGE-09) — pure, tested from apps/api/test/livePeering.test.ts.
// Everything here was read with the topology ("at read time"): it labels the card, it never colours it — the card's
// state is Resource Health of the connection and its measured BitsIn/BitsOut.

export type HybridFacts =
  | { kind: "gateway"; s2s: number; sku: string | null; activeActive: boolean; bgp: boolean }
  | { kind: "site"; prefixes: number; bgp: boolean; nat: boolean; status: string };

export function hybridFacts(kind: string, meta: Record<string, string> | undefined): HybridFacts | undefined {
  if (!meta) return undefined;
  if (kind === "vnetGateway") {
    return { kind: "gateway", s2s: Number(meta.s2sCount ?? 0) || 0, sku: meta.sku ?? null, activeActive: meta.activeActive === "true", bgp: meta.enableBgp === "true" };
  }
  if (kind === "onPremSite") {
    let prefixes = 0;
    try { prefixes = ((JSON.parse(meta.lng ?? "null") as { prefixes?: unknown[] } | null)?.prefixes ?? []).length; } catch { /* malformed — 0 */ }
    return { kind: "site", prefixes, bgp: meta.bgp === "true", nat: meta.nat === "true", status: meta.connectionStatus ?? "Unknown" };
  }
  return undefined;
}

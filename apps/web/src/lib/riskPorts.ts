// Ports that matter when they are reachable from the Internet. Same list as apps/api/src/services/riskPorts.ts
// (apps/api/test/nsgExposure.test.ts checks they match).

export type PortTier = "critical" | "high" | "medium";

export const RISK_PORTS: Readonly<Record<PortTier, readonly number[]>> = {
  critical: [22, 23, 135, 139, 445, 2375, 2376, 2379, 3389, 5900, 5985, 5986, 10250],
  high: [1433, 1521, 3306, 5432, 5984, 6379, 9042, 9200, 9300, 11211, 27017],
  medium: [3000, 5601, 6443, 8080, 8443, 8500, 9090, 15672],
};

const ORDER: PortTier[] = ["critical", "high", "medium"];

/** Tier of one port, or null when it is not on the list */
export function portTier(port: number): PortTier | null {
  return ORDER.find((t) => RISK_PORTS[t].includes(port)) ?? null;
}

/**
 * Highest tier among port specs ("22", "8000-8100", "*", "53/udp"). "*" and a range that contains a listed port
 * count as that port; "*" is critical.
 */
export function portSpecTier(specs: readonly string[]): PortTier | null {
  let best: PortTier | null = null;
  const rank = (t: PortTier | null) => (t ? ORDER.indexOf(t) : ORDER.length);
  for (const raw of specs) {
    const spec = raw.replace(/\/(tcp|udp)$/i, "");
    let tier: PortTier | null = null;
    if (spec === "*") tier = "critical";
    else {
      const [a, b] = spec.split("-").map(Number);
      if (Number.isFinite(a)) {
        const hi = Number.isFinite(b) ? b! : a!;
        tier = ORDER.find((t) => RISK_PORTS[t].some((p) => p >= a! && p <= hi)) ?? null;
      }
    }
    if (rank(tier) < rank(best)) best = tier;
  }
  return best;
}

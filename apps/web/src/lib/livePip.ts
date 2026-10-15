// Internet → VM through its own public IP (catalog PIP-04) on the live diagram: the NSG verdict the API put on the
// card (`metadata.pipExposure`) and on the line (`edge.exposure`), turned into a chip and panel facts. Pure — tested
// from apps/api/test/livePip.test.ts.
import type { InboundExposure } from "@aud/types";
import { portSpecTier, type PortTier } from "./riskPorts";

const STATES = new Set<InboundExposure["state"]>(["open", "scoped", "closed", "noNsg", "unknown"]);

/** The verdict stored on a card (JSON string — the spec is shared JSON), null when absent or unreadable */
export function pipExposure(metadata: Record<string, string> | undefined): InboundExposure | null {
  const raw = metadata?.pipExposure;
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as InboundExposure;
    return x && STATES.has(x.state) && Array.isArray(x.ports) ? x : null;
  } catch {
    return null;
  }
}

export type PipChip = { key: string; vars?: Record<string, string | number>; tone: "public" | "muted" | undefined; title: string };

/**
 * Card chip: what the Internet may do with this VM's public IP. Orange only for a configured opening of a risky port
 * (open: critical / high, scoped: critical) — unknown is never coloured (project rule: unknown = unk, no risk colour).
 */
export function pipChip(ex: InboundExposure, address?: string): PipChip {
  const tier: PortTier | null = portSpecTier(ex.ports);
  const risky = (ex.state === "open" && (tier === "critical" || tier === "high")) || (ex.state === "scoped" && tier === "critical");
  const title = [address, ex.ports.length ? ex.ports.join(", ") : null].filter(Boolean).join(" · ");
  switch (ex.state) {
    case "open":
      return ex.ports.includes("*")
        ? { key: "ld.card.pip.openAll", tone: "public", title }
        : { key: "ld.card.pip.open", vars: { n: ex.ports.length }, tone: risky ? "public" : undefined, title };
    case "scoped": return { key: "ld.card.pip.scoped", tone: risky ? "public" : undefined, title };
    case "closed": return { key: "ld.card.pip.closed", tone: "muted", title };
    case "noNsg": return { key: "ld.card.pip.noNsg", tone: "muted", title };
    default: return { key: "ld.card.pip.unknown", tone: undefined, title };
  }
}

/** Ports with their risk tier, for the line panel ("22" critical, "443" none) */
export function exposurePorts(ex: InboundExposure): Array<{ spec: string; tier: PortTier | null }> {
  return ex.ports.map((spec) => ({ spec, tier: portSpecTier([spec]) }));
}

/** Who may connect, as an i18n key + vars */
export function exposureSources(ex: InboundExposure): { key: string; vars?: Record<string, string | number> } {
  if (ex.sources === "any") return { key: "ld.pip.src.any" };
  if (ex.sources === "none") return { key: "ld.pip.src.none" };
  if (ex.azureCloud) return { key: "ld.pip.src.azureCloud", vars: { n: ex.rangeCount } };
  return { key: ex.sources === "tags" ? "ld.pip.src.tags" : "ld.pip.src.ranges", vars: { n: ex.rangeCount } };
}

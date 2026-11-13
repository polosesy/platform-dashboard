// Why Hubble dropped a packet — three groups the views treat differently (2026-11-13, stg):
//
// The service map painted every drop as a red "blocked connection". On stg the drops in a live sample were all
// UNSUPPORTED_L3_PROTOCOL (Hubble UI, 45 s: 11 of 11; AMW hubble_drop_total 1 h: 308 unsupported_l3_protocol,
// 0 policy_denied) — ICMPv6 neighbour discovery / router solicitation that pods send on an IPv4-only Cilium
// datapath, to multicast addresses Cilium cannot map (identity 0, `reserved:unknown`). They are packets, not
// connections, and no policy decided them — while the security tab correctly said "policy blocked 0".
//
//   policy   — a network policy denied it (what "차단"/"denied" means to an operator)
//   ipv6     — UNSUPPORTED_L3_PROTOCOL with an IPv6 address: the cluster does not carry IPv6 (expected, harmless)
//   datapath — every other reason (conntrack, routing, missing service backend …): a real drop worth a look,
//              but not a policy decision
//
// Classification reads Hubble's own drop reason and the packet's addresses only — nothing is inferred from names.

import type { HubbleDropClass, HubbleDropCounts, HubbleFlow } from "@aud/types";

const POLICY_REASONS = new Set(["POLICY_DENIED", "POLICY_DENY", "AUTH_REQUIRED"]);

/** Pure: the group of one DROPPED flow (null for a flow that was not dropped) */
export function dropClass(f: Pick<HubbleFlow, "verdict" | "dropReasonDesc" | "sourceIp" | "destinationIp">): HubbleDropClass | null {
  if (f.verdict !== "DROPPED") return null;
  const reason = (f.dropReasonDesc || "").toUpperCase();
  if (POLICY_REASONS.has(reason)) return "policy";
  if (reason === "UNSUPPORTED_L3_PROTOCOL" && (f.sourceIp?.includes(":") || f.destinationIp?.includes(":"))) return "ipv6";
  return "datapath";
}

export const noDrops = (): HubbleDropCounts => ({ policy: 0, ipv6: 0, datapath: 0 });

/** Pure: count a flow into a per-class tally (no-op for a flow that was not dropped) */
export function countDrop(acc: HubbleDropCounts, f: Parameters<typeof dropClass>[0]): void {
  const c = dropClass(f);
  if (c) acc[c]++;
}

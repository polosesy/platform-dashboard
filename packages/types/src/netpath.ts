// ─────────────────────────────────────────────────────────────
// 네트워크 › 네트워크 경로 — from a user's device to a SaaS endpoint, hop by hop (Datadog Network Path + End User
// Device Monitoring, done the honest way): the DEVICE measures (scripts/netpath-probe.ps1 · `mtr --json`) and uploads
// the raw result; the API keeps it and computes loss / latency per hop. The dashboard never probes the internet itself.
// ─────────────────────────────────────────────────────────────

/** Where a hop's address sits: a private LAN / ISP range (RFC 1918), carrier-grade NAT (100.64/10), or public */
export type NetPathScope = "private" | "cgnat" | "public";

export type NetPathHop = {
  ttl: number;
  /** the address that answered most often at this TTL — null = no answer at all ("*") */
  ip: string | null;
  /** other addresses that answered at the same TTL (load-balanced paths) */
  others: string[];
  sent: number;
  received: number;
  /** (sent − received) / sent, % */
  lossPct: number;
  /** ms over the answered probes — null without answers */
  rttMin: number | null;
  rttAvg: number | null;
  rttMax: number | null;
  scope: NetPathScope | null;
};

export type NetPathRun = {
  id: string;
  /** the probe that measured it */
  source: "aud-netpath/1" | "mtr";
  target: string;
  targetIp: string | null;
  /** the device's label as the probe reported it */
  device: string;
  startedAt: string;
  uploadedAt: string;
  /** who uploaded it (display name) */
  by?: string;
  probes: number;
  /** the destination answered */
  reached: boolean;
  hops: NetPathHop[];
};

export type NetPathResponse = {
  signedIn: boolean;
  /** kept on the state volume (false = memory only, lost on restart) */
  durable: boolean;
  /** operators may delete runs */
  canDelete: boolean;
  runs: NetPathRun[];
};

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

/** One traceroute probe as the device saw it (aud-netpath/2): the TTL, who answered (null = no answer) and its time */
export type NetPathProbe = { ttl: number; ip: string | null; rtt: number | null; /** the destination answered (not "TTL expired") */ dest: boolean };

/** End-to-end probes to the destination (aud-netpath/2) — every time kept in order, a lost one = null; the rest computed */
export type NetPathE2e = {
  protocol: "tcp" | "icmp";
  /** tcp: the port connected to */
  port: number | null;
  rtt: Array<number | null>;
  sent: number;
  received: number;
  lossPct: number;
  rttMin: number | null;
  rttAvg: number | null;
  rttMax: number | null;
  /** mean |difference| of consecutive answered probes, ms (RFC 3550 / 5481 IPDV without smoothing) — null under 2 pairs */
  jitter: number | null;
};

/** What the device looked up for a public hop, only with the probe's -Lookup (its DNS · Team Cymru DNS TXT) */
export type NetPathHopInfo = { name?: string; asn?: number; asName?: string; prefix?: string; country?: string };

export type NetPathRun = {
  id: string;
  /** the probe that measured it */
  source: "aud-netpath/1" | "aud-netpath/2" | "mtr";
  target: string;
  targetIp: string | null;
  /** the device's label as the probe reported it */
  device: string;
  startedAt: string;
  uploadedAt: string;
  /** who uploaded it (display name) */
  by?: string;
  /** aud-netpath/1 · mtr: probes per TTL — aud-netpath/2: traceroutes (passes) */
  probes: number;
  /** a traceroute reached the destination (ICMP — many SaaS hosts never answer it; see e2e) */
  reached: boolean;
  /** per TTL over every probe (aud-netpath/2: over its passes) */
  hops: NetPathHop[];
  /** aud-netpath/2: every traceroute as measured, probe by probe — the paths (which hop followed which) */
  passes?: NetPathProbe[][];
  /** aud-netpath/2: end-to-end probes to the destination */
  e2e?: NetPathE2e;
  /** aud-netpath/2: the link the device used — its type (.NET NetworkInterfaceType) and speed, nothing else */
  link?: { type: string; mbps: number | null };
  /** aud-netpath/2 with -Lookup: per public address */
  hopInfo?: Record<string, NetPathHopInfo>;
};

export type NetPathResponse = {
  signedIn: boolean;
  /** kept on the state volume (false = memory only, lost on restart) */
  durable: boolean;
  /** operators may delete runs */
  canDelete: boolean;
  runs: NetPathRun[];
};

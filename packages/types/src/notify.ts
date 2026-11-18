// 알림 센터 — alerts from Azure Monitor (action group webhook, common alert schema) and Grafana Alerting / Alertmanager
// (webhook contact point), received by the dashboard itself and shown to the people who may see them. Messenger
// webhooks are not required to see them (the inbox is a channel), and the dashboard relays them on to chat tools
// (Flow · Slack · Google Chat · Teams) in each tool's own payload shape — see apps/api/src/services/notifyChannels.ts.
import type { ConnectCause } from "./common.js";

/** sev1 critical (outage, data loss) · sev2 major · sev3 warning · sev4 info — the Grafana standard of the platform */
export type NotifySeverity = "sev1" | "sev2" | "sev3" | "sev4";
/** What the alert is about: an outage / service health, security, a monitoring signal, a planned change or maintenance */
export type NotifyCategory = "incident" | "security" | "monitoring" | "change";
/** advisory = 긴급 취약점 선제 감시 (the API's own watcher of vendor announcements — services/earlyWatch.ts) */
export type NotifySource = "azure-monitor" | "grafana" | "alertmanager" | "test" | "advisory";

export type NotifyLink = { kind: "dashboard" | "grafana" | "portal" | "runbook" | "silence" | "source"; label: string; url: string };

export type NotifyEvent = { at: string; status: "firing" | "resolved"; by?: string; note?: string };

export type NotifyAlert = {
  /** Stable per alert instance (Azure alertId / Grafana fingerprint) — repeated deliveries update one item */
  id: string;
  source: NotifySource;
  status: "firing" | "resolved";
  severity: NotifySeverity;
  category: NotifyCategory;
  /** Why this category: an explicit label, the Azure monitoring service, the alert name, sev1 (= incident), or the default */
  categoryBasis: "label" | "service" | "name" | "severity" | "default";
  /** Alert rule name (alertname / alertRule) */
  rule: string;
  title: string;
  summary?: string;
  description?: string;
  /** Azure monitoringService ("Platform", "ServiceHealth", "Resource Health", "Activity Log - Security", "Prometheus" …) or the Grafana folder */
  service?: string;
  target: {
    cluster?: string;
    namespace?: string;
    pod?: string;
    /** Prometheus service / application label */
    workload?: string;
    node?: string;
    /** Azure resource (ARM id) the alert fired on — first of alertTargetIDs */
    resourceId?: string;
    resourceName?: string;
    resourceType?: string;
    resourceGroup?: string;
    /** Subscription GUID — used for visibility (connection access), not shown */
    subscriptionId?: string;
  };
  /** Selected labels (no secrets — label names in a fixed allow-list, values truncated) */
  labels: Record<string, string>;
  /** Measured values (Grafana `values` / Azure condition metric value) */
  values?: Record<string, number>;
  links: NotifyLink[];
  /** Owning team from the connection file `owners` (namespace before resource group) */
  team?: string;
  startsAt: string;
  endsAt?: string;
  firstReceivedAt: string;
  lastReceivedAt: string;
  /** Deliveries received for this alert (repeat notifications included) */
  received: number;
  /** Times it went firing again after being resolved */
  refired: number;
  ack?: { by: string; at: string; note?: string };
  history: NotifyEvent[];
  /** Last delivery per outbound channel (Flow · Slack · Google Chat · Teams …) */
  deliveries?: NotifyDelivery[];
};

/**
 * Why a send made no connection — from the socket / TLS error code only (never its text):
 * dns name does not resolve · refused nothing listens (or a firewall rejects) · timeout no answer (firewall drop, wrong
 * port) · noRoute no route to the address · tls the certificate was refused (expired, wrong name, unknown CA — an
 * internal CA needs NODE_EXTRA_CA_CERTS)
 */
export type NotifyFailCause = ConnectCause | "tls";

export type NotifyDelivery = {
  channel: string; at: string; ok: boolean; status?: number; attempts: number;
  error?: "timeout" | "network" | "http" | "notConfigured";
  /** Set on network / timeout errors when the code says why */
  cause?: NotifyFailCause;
};

/**
 * '연결 확인' — the path to a channel's host without sending anything: name → TCP → TLS handshake (no HTTP request,
 * so no message reaches the room). Answers the network question; whether the receiver accepts the body is the test send.
 */
export type NotifyChannelCheck = {
  ok: boolean;
  /** The last stage reached: dns (name resolved) · connect (TCP open) · tls (certificate accepted) */
  stage: "none" | "dns" | "connect" | "tls";
  cause?: NotifyFailCause;
  /** The TLS error code when the certificate was refused (e.g. CERT_HAS_EXPIRED) */
  tlsCode?: string;
  /** How many addresses the name resolved to, and whether any is private (internal network) — never the addresses */
  addresses?: number;
  privateAddress?: boolean;
  /** The certificate the host presented (issuer organisation, expiry) */
  cert?: { issuer: string | null; validTo: string; daysLeft: number };
  /** The API sends through an HTTP proxy for this host — a direct check would not test that path; use the test send */
  viaProxy?: boolean;
  ms: number;
};

/** An outbound channel as the admin sees it — the webhook URL (a secret) is never returned, only its host */
export type NotifyChannelInfo = {
  key: string;
  name: string;
  format: "flow" | "azureCommon" | "grafana" | "slack" | "googleChat" | "teams" | "json";
  host: string | null;
  /** The URL variable is set (and https, or http allowed) */
  configured: boolean;
  /** The variable that holds the URL — its name, never its value (what to set when `configured` is false) */
  urlEnv: string;
  enabled: boolean;
  minSeverity: NotifySeverity;
  categories: NotifyCategory[];
  teams: string[];
  statuses: Array<"firing" | "resolved">;
  lang: "ko" | "en";
  prefix: string;
};

export type NotifyChannelTest = { ok: boolean; status?: number; ms: number; attempts: number; error?: NotifyDelivery["error"]; cause?: NotifyFailCause };

export type NotificationsResponse = {
  items: NotifyAlert[];
  counts: {
    firing: number;
    firingUnacked: number;
    bySeverity: Record<NotifySeverity, number>;
    byCategory: Record<NotifyCategory, number>;
  };
  /** false = kept in memory only (no directory) — lost on restart */
  durable: boolean;
  /** The receiver accepts deliveries (a token is configured) */
  receiverEnabled: boolean;
  canWrite: boolean;
};

export type NotifyPullInfo = {
  enabled: boolean;
  /** Grafana host only — never a token */
  host?: string;
  /** The Azure connection whose identity reads it (entra) */
  connection?: string;
  /** Contact points mirrored (empty = all) */
  receivers?: string[];
  intervalSec?: number;
  /** entra = the platform identity (Azure Managed Grafana, role Grafana Viewer) · token = a service account token */
  auth?: "entra" | "token";
  state: "off" | "starting" | "ok" | "failed";
  /** forbidden · notFound · timeout · network · http · shape */
  error?: string;
  lastAt?: string;
  lastOkAt?: string;
  /** Active alerts routed to those contact points at the last poll */
  active?: number;
};

export type NotifyReceiverInfo = {
  enabled: boolean;
  /** Path to append to the dashboard's public address — the token is never returned */
  paths: { azure: string; grafana: string; auto: string };
  tokenHint: string | null;
  channels: NotifyChannelInfo[];
  /** Grafana pull (the dashboard reads Grafana's active alerts — private clusters) */
  pull: NotifyPullInfo;
  durable: boolean;
  retentionDays: number;
};

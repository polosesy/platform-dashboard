// 알림 센터 — alerts from Azure Monitor (action group webhook, common alert schema) and Grafana Alerting / Alertmanager
// (webhook contact point), received by the dashboard itself and shown to the people who may see them. Messenger
// webhooks (Slack · Teams · Google Chat) are not required: the inbox is the channel; an internal relay is optional.

/** sev1 critical (outage, data loss) · sev2 major · sev3 warning · sev4 info — the Grafana standard of the platform */
export type NotifySeverity = "sev1" | "sev2" | "sev3" | "sev4";
/** What the alert is about: an outage / service health, security, a monitoring signal, a planned change or maintenance */
export type NotifyCategory = "incident" | "security" | "monitoring" | "change";
export type NotifySource = "azure-monitor" | "grafana" | "alertmanager" | "test";

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
  /** Outbound relay result of the last change (when a relay is configured) */
  relay?: { at: string; ok: boolean; status?: number };
};

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

export type NotifyReceiverInfo = {
  enabled: boolean;
  /** Path to append to the dashboard's public address — the token is never returned */
  paths: { azure: string; grafana: string; auto: string };
  tokenHint: string | null;
  relay: { configured: boolean; host: string | null; minSeverity: NotifySeverity };
  durable: boolean;
  retentionDays: number;
};

// 알림 센터 view model (pure) — inbox filters, the feature × alert source mapping, and the sender setup snippets.
// Unit-tested from apps/api/test/notify.test.ts.

import type { NotifyAlert, NotifyCategory, NotifySeverity } from "@aud/types";

export const CATEGORIES: NotifyCategory[] = ["incident", "security", "monitoring", "change"];
export const SEVERITIES: NotifySeverity[] = ["sev1", "sev2", "sev3", "sev4"];

export type InboxFilter = {
  category: NotifyCategory | "all";
  status: "firing" | "resolved" | "all";
  severity: NotifySeverity | "all";
  team: string | "all" | "none";
  unackedOnly: boolean;
  q: string;
};
export const DEFAULT_FILTER: InboxFilter = { category: "all", status: "firing", severity: "all", team: "all", unackedOnly: false, q: "" };

const targetWords = (a: NotifyAlert) => [a.target.cluster, a.target.namespace, a.target.pod, a.target.workload, a.target.node, a.target.resourceName, a.target.resourceGroup].filter(Boolean).join(" ");

export function filterInbox(items: NotifyAlert[], f: InboxFilter): NotifyAlert[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((a) =>
    (f.category === "all" || a.category === f.category)
    && (f.status === "all" || a.status === f.status)
    && (f.severity === "all" || a.severity === f.severity)
    && (f.team === "all" || (f.team === "none" ? !a.team : a.team === f.team))
    && (!f.unackedOnly || !a.ack)
    && (!q || `${a.title} ${a.rule} ${a.summary ?? ""} ${targetWords(a)} ${a.team ?? ""}`.toLowerCase().includes(q)));
}

/** "ns/pod", "ns/workload", node, Azure resource, cluster — what the alert points at, shortest first */
export function targetText(a: Pick<NotifyAlert, "target">): string {
  const t = a.target;
  if (t.pod) return `${t.namespace ? `${t.namespace}/` : ""}${t.pod}`;
  if (t.workload) return `${t.namespace ? `${t.namespace}/` : ""}${t.workload}`;
  if (t.node) return t.node;
  if (t.namespace) return t.namespace;
  if (t.resourceName) return `${t.resourceName}${t.resourceGroup ? ` · ${t.resourceGroup}` : ""}`;
  return t.cluster ?? "";
}

export const teamsOf = (items: NotifyAlert[]) => [...new Set(items.map((a) => a.team).filter((x): x is string => !!x))].sort();

/** New firing sev1/sev2 alerts not seen yet — what a desktop notification is raised for */
export function newUrgent(items: NotifyAlert[], seen: Set<string>): NotifyAlert[] {
  return items.filter((a) => a.status === "firing" && !a.ack && (a.severity === "sev1" || a.severity === "sev2") && !seen.has(`${a.id}@${a.startsAt}`));
}

// ── Feature × alert source mapping (what to connect for each category, which screen it opens) ──

export type MappingRow = {
  category: NotifyCategory;
  /** i18n key suffixes under notify.map.src.* */
  sources: string[];
  /** Dashboard screens the alert links to */
  screens: Array<{ href: string; labelKey: string }>;
};

export const MAPPING: MappingRow[] = [
  { category: "incident", sources: ["serviceHealth", "resourceHealth", "sev1"], screens: [{ href: "/health", labelKey: "nav.item.health" }, { href: "/live-diagram", labelKey: "nav.item.liveDiagram" }] },
  { category: "security", sources: ["activitySecurity", "activityPolicy", "grafanaCilium", "nameSecurity"], screens: [{ href: "/security/threats", labelKey: "nav.item.securityThreats" }, { href: "/security/findings", labelKey: "nav.item.securityFindings" }, { href: "/policies", labelKey: "nav.item.clusterSecurity" }, { href: "/hubble", labelKey: "nav.item.podTraffic" }] },
  { category: "monitoring", sources: ["azureMetric", "azureLog", "azurePrometheus", "grafanaRules"], screens: [{ href: "/observability", labelKey: "nav.item.aksMonitoring" }, { href: "/live-diagram", labelKey: "nav.item.liveDiagram" }] },
  { category: "change", sources: ["activityAdmin", "grafanaMaintenance"], screens: [{ href: "/observability", labelKey: "nav.item.aksMonitoring" }, { href: "/health", labelKey: "nav.item.health" }] },
];

// ── Sender setup snippets (placeholders only — the token is never shown by the dashboard) ──

export function receiverUrls(origin: string): { azure: string; grafana: string } {
  const base = origin.replace(/\/$/, "");
  return { azure: `${base}/hooks/alerts/azure?token=<AUD_ALERT_RECEIVER_TOKEN>`, grafana: `${base}/hooks/alerts/grafana` };
}

export function azureSnippet(origin: string): string {
  const { azure } = receiverUrls(origin);
  return `# Azure CLI — add the dashboard to an action group (common alert schema ON)
az monitor action-group update -g <resource-group> -n <action-group> \\
  --add-action webhook aud-dashboard "${azure}" usecommonalertschema

# Terraform (azurerm_monitor_action_group)
webhook_receiver {
  name                    = "aud-dashboard"
  service_uri             = "${azure}"   # token: TF_VAR / Key Vault, never in git
  use_common_alert_schema = true
}`;
}

/** The admin's channel definition (no secrets — each webhook URL is its own variable) */
export function channelsSnippet(): string {
  return `# API environment (api.env · Helm api.extraEnv · Key Vault/Secret for the URLs)
AUD_NOTIFY_CHANNELS='[
  {"key":"flow-ops","name":"Flow ops room","format":"flow","urlEnv":"AUD_NOTIFY_URL_FLOW_OPS",
   "minSeverity":"sev3","categories":["incident","security","monitoring"],"prefix":"[STG] ","lang":"ko"},
  {"key":"slack-sec","name":"Slack #security","format":"slack","urlEnv":"AUD_NOTIFY_URL_SLACK_SEC",
   "minSeverity":"sev2","categories":["security"],"statuses":["firing"]}
]'
AUD_NOTIFY_URL_FLOW_OPS=<Flow BOT webhook URL — secret>
AUD_NOTIFY_URL_SLACK_SEC=<Slack incoming webhook URL — secret>
# formats: flow · azureCommon · grafana · slack · googleChat · teams · json
# optional: "teams":["platform"] (connection file owners) · "authHeaderEnv":"AUD_NOTIFY_AUTH_X" · "allowHttp":true (internal http only)`;
}

/** Flow (Madras Check) BOT webhook template — the body carries both the Azure paths and finished text */
export function flowTemplateHint(): string {
  return `# Flow BOT webhook template (either works with format "flow")
title:   {{title}}
message: {{message}}
# or the existing Azure common-schema template:
title:   {{data.essentials.alertRule}} ({{data.essentials.severity}} · {{data.essentials.monitorCondition}})
message: {{data.essentials.description}}  /  {{data.alertContext.labels.namespace}} {{data.alertContext.labels.pod}}`;
}

/** Grafana pull — for a private cluster Grafana's webhooks can't reach (the dashboard reads the active alerts itself) */
export function pullSnippet(): string {
  return `# API environment — mirror the alerts of the Google Chat contact points (Grafana keeps sending to Google Chat)
AUD_NOTIFY_PULL_GRAFANA_URL=https://<grafana-name>.<region>.grafana.azure.com
AUD_NOTIFY_PULL_RECEIVERS=<urgent-contact-point>,<info-contact-point>
AUD_NOTIFY_PULL_INTERVAL_SEC=60

# Azure Managed Grafana: the platform identity reads with its Entra token — no secret
az role assignment create --assignee <platform-identity-client-id> --role "Grafana Viewer" \
  --scope <grafana-resource-id>
# Any other Grafana: a Viewer service account token (secret)
# AUD_NOTIFY_PULL_GRAFANA_TOKEN=<service account token>

# Kubernetes egress (chart): networkPolicy.extraFqdns: ["<grafana-name>.<region>.grafana.azure.com"]`;
}

export function grafanaSnippet(origin: string): string {
  const { grafana } = receiverUrls(origin);
  return `# Grafana → Alerting → Contact points → Webhook
#   URL:                 ${grafana}
#   HTTP Method:         POST
#   Authorization header: scheme Bearer, credentials <AUD_ALERT_RECEIVER_TOKEN>

# Terraform (grafana provider)
resource "grafana_contact_point" "aud_dashboard" {
  name = "aud-dashboard"
  webhook {
    url                     = "${grafana}"
    http_method             = "POST"
    authorization_scheme    = "Bearer"
    authorization_credentials = var.aud_alert_receiver_token   # sensitive
  }
}
# Rules: labels.severity = sev1..sev4, optional labels.category = incident | security | monitoring | change`;
}

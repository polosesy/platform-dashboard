// 알림 센터 — incoming alert payloads → one alert model (pure). Two formats reach one receiver; the shape decides:
//   `data.essentials`  → Azure Monitor common alert schema (action group webhook, "Enable the common alert schema")
//   `alerts[]`         → Grafana Alerting webhook contact point (has `orgId` / `values` / `state`) or Prometheus Alertmanager
// A receiver that reads only one shape shows the other as empty fields — the reason the in-house bot templates went blank.
// Nothing here trusts the payload: strings are truncated, labels are an allow-list, links are http(s) without
// credentials or secret-looking query parameters, Portal links only to portal.azure.com.
import { createHash } from "node:crypto";
import type { NotifyCategory, NotifyLink, NotifySeverity, NotifySource } from "@aud/types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 300): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return s ? s.slice(0, max) : undefined;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** What one delivery carries per alert, before the store adds received counts, history and team */
export type ParsedAlert = {
  id: string;
  source: NotifySource;
  status: "firing" | "resolved";
  severity: NotifySeverity;
  category: NotifyCategory;
  categoryBasis: "label" | "service" | "name" | "severity" | "default";
  rule: string;
  title: string;
  summary?: string;
  description?: string;
  service?: string;
  target: {
    cluster?: string; namespace?: string; pod?: string; workload?: string; node?: string;
    resourceId?: string; resourceName?: string; resourceType?: string; resourceGroup?: string; subscriptionId?: string;
  };
  labels: Record<string, string>;
  values?: Record<string, number>;
  links: NotifyLink[];
  startsAt: string;
  endsAt?: string;
};

export type DetectResult = { kind: "azure" | "grafana" | "alertmanager"; alerts: ParsedAlert[] } | { kind: "unsupported"; reason: string };

// ── Severity ──

/** Azure Sev0 critical → sev1 … Sev3 informational / Sev4 verbose → sev4 */
export function azureSeverity(v: unknown): NotifySeverity {
  const n = Number(String(v ?? "").replace(/^sev/i, ""));
  return n === 0 ? "sev1" : n === 1 ? "sev2" : n === 2 ? "sev3" : n >= 3 ? "sev4" : "sev3";
}

/** sev1–4 (the platform standard) as is; critical / page / p1 → sev1, error / major / high → sev2, warning → sev3, info → sev4 */
export function labelSeverity(v: unknown): NotifySeverity {
  const s = String(v ?? "").trim().toLowerCase();
  const m = /^sev\s*([1-4])$/.exec(s) ?? /^p([1-4])$/.exec(s);
  if (m) return `sev${m[1]}` as NotifySeverity;
  if (/^(critical|crit|page|fatal|emergency|disaster)$/.test(s)) return "sev1";
  if (/^(error|err|major|high)$/.test(s)) return "sev2";
  if (/^(warning|warn|minor|medium|average)$/.test(s)) return "sev3";
  if (/^(info|information|informational|low|none|notice|debug|verbose)$/.test(s)) return "sev4";
  return "sev3";
}

// ── Category: explicit label > Azure monitoring service > the alert's name > sev1 = incident > monitoring ──

const CATEGORIES = new Set<NotifyCategory>(["incident", "security", "monitoring", "change"]);
const SECURITY_NAME = /secur|defender|cilium.*(drop|deny)|policy.?(drop|deny|violation)|audit|vuln|\bcve\b|secret|rbac|intrusion|malware|suspicious|brute|unauthori[sz]ed|forbidden/i;
const CHANGE_NAME = /maintenance|upgrade|scheduled|reboot|redeploy|freeze|planned|rollout/i;

export function classify(input: { labels: Record<string, string>; service?: string; names: string[]; severity: NotifySeverity }): { category: NotifyCategory; basis: ParsedAlert["categoryBasis"] } {
  const l = (input.labels.category ?? input.labels.aud_category ?? "").toLowerCase();
  if (CATEGORIES.has(l as NotifyCategory)) return { category: l as NotifyCategory, basis: "label" };
  const svc = (input.service ?? "").toLowerCase();
  if (svc === "servicehealth" || svc === "resource health") return { category: "incident", basis: "service" };
  if (svc === "activity log - security" || svc === "activity log - policy") return { category: "security", basis: "service" };
  if (svc === "activity log - administrative" || svc === "activity log - autoscale") return { category: "change", basis: "service" };
  const name = input.names.join(" ");
  if (SECURITY_NAME.test(name)) return { category: "security", basis: "name" };
  if (CHANGE_NAME.test(name)) return { category: "change", basis: "name" };
  if (input.severity === "sev1") return { category: "incident", basis: "severity" };
  return { category: "monitoring", basis: "default" };
}

// ── Links ──

const SECRET_PARAM = /token|code|sig|signature|key|secret|password|pwd|auth/i;
/** http(s) only, no user:password@, secret-looking query parameters dropped; null = not a safe link */
export function safeUrl(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.username = ""; u.password = "";
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;

function addLink(links: NotifyLink[], kind: NotifyLink["kind"], label: string, v: unknown) {
  const url = safeUrl(v);
  if (url && !links.some((l) => l.url === url)) links.push({ kind, label, url });
}

/** Dashboard screens for an alert — the feature that shows what the alert is about (label = the web's i18n key) */
export function featureLinks(a: Pick<ParsedAlert, "category" | "service" | "target" | "rule" | "title">): NotifyLink[] {
  const out: NotifyLink[] = [];
  const add = (url: string, label: string) => { if (!out.some((l) => l.url === url)) out.push({ kind: "dashboard", label, url }); };
  const svc = (a.service ?? "").toLowerCase();
  const name = `${a.rule} ${a.title}`;
  if (svc === "servicehealth" || svc === "resource health") add("/health", "nav.item.health");
  if (svc === "activity log - security") add("/security/threats", "nav.item.securityThreats");
  if (svc === "activity log - policy") add("/security/findings", "nav.item.securityFindings");
  if (/cilium|hubble|policy.?drop/i.test(name)) { add("/hubble", "nav.item.podTraffic"); add("/policies?tab=netpolSim", "pol.panel.netpolSim"); }
  if (a.target.namespace || a.target.pod || a.target.node || a.target.cluster) add("/observability", "nav.item.aksMonitoring");
  if (a.category === "security" && (a.target.namespace || a.target.cluster)) add("/policies", "nav.item.clusterSecurity");
  if (a.target.resourceId) add("/health", "nav.item.health");
  if (a.category === "security" && !out.length) add("/security", "nav.item.securityOverview");
  return out;
}

// ── ARM ids ──

export function parseArmId(id: string | undefined): { subscriptionId?: string; resourceGroup?: string; resourceType?: string; resourceName?: string } {
  if (!id) return {};
  const m = /^\/subscriptions\/([0-9a-f-]{36})(?:\/resourcegroups\/([^/]+))?(?:\/providers\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?)?/i.exec(id);
  if (!m) return {};
  return {
    subscriptionId: m[1]!.toLowerCase(),
    ...(m[2] ? { resourceGroup: m[2] } : {}),
    ...(m[3] && m[4] ? { resourceType: `${m[3]}/${m[4]}${m[6] ? `/${m[6]}` : ""}`.toLowerCase() } : {}),
    ...(m[7] ? { resourceName: m[7] } : m[5] ? { resourceName: m[5] } : {}),
  };
}

// ── Labels ──

const LABEL_KEYS = new Set([
  "alertname", "severity", "category", "aud_category", "team", "plane", "cluster", "namespace", "pod", "container", "node",
  "service_name", "application", "deployment", "statefulset", "daemonset", "job", "persistentvolumeclaim", "grafana_folder",
  "event", "scheduled_at", "duration_s", "reason", "source", "workload", "service", "instance",
]);
export function pickLabels(src: unknown, extra: Array<{ name?: unknown; value?: unknown }> = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(src) ?? {})) {
    if (!LABEL_KEYS.has(k)) continue;
    const s = str(v, 200);
    if (s) out[k] = s;
  }
  for (const d of extra.slice(0, 20)) {
    const k = str(d.name, 60), v = str(d.value, 200);
    if (k && v && /^[A-Za-z0-9_.\-/ ]+$/.test(k) && !SECRET_PARAM.test(k)) out[`dim:${k}`] = v;
  }
  return out;
}

const targetFromLabels = (l: Record<string, string>): ParsedAlert["target"] => ({
  ...(l.cluster ? { cluster: l.cluster } : {}),
  ...(l.namespace ? { namespace: l.namespace } : {}),
  ...(l.pod ? { pod: l.pod } : {}),
  ...(l.service_name || l.application || l.deployment || l.statefulset || l.daemonset || l.workload
    ? { workload: l.service_name ?? l.application ?? l.deployment ?? l.statefulset ?? l.daemonset ?? l.workload } : {}),
  ...(l.node ? { node: l.node } : {}),
});

const numbers = (v: unknown): Record<string, number> | undefined => {
  const o = obj(v);
  if (!o) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(o).slice(0, 10)) if (typeof x === "number" && Number.isFinite(x)) out[k.slice(0, 40)] = x;
  return Object.keys(out).length ? out : undefined;
};
const plain = (v: unknown, max = 2000) => str(typeof v === "string" ? v.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ") : v, max);
const iso = (v: unknown): string | undefined => {
  const s = str(v, 40);
  if (!s || s.startsWith("0001-")) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

// ── Azure Monitor common alert schema ──

function parseAzure(body: Obj, now: Date): ParsedAlert[] {
  const data = obj(body.data) ?? {};
  const e = obj(data.essentials) ?? {};
  const ctx = obj(data.alertContext) ?? {};
  const alertId = str(e.alertId, 600) ?? str(e.originAlertId, 600) ?? JSON.stringify(e).slice(0, 600);
  const service = str(e.monitoringService, 80);
  const severity = azureSeverity(e.severity);
  const props = obj(ctx.properties) ?? {};
  const resourceId = str(arr(e.alertTargetIDs)[0], 600);
  const arm = parseArmId(resourceId);
  // Prometheus rule groups (Azure Monitor managed Prometheus) carry Kubernetes labels and annotations
  const promLabels = obj(ctx.labels) ?? {};
  const promAnn = obj(ctx.annotations) ?? {};
  const cond = arr(obj(ctx.condition)?.allOf).map(obj).filter((c): c is Obj => !!c);
  const labels = pickLabels(promLabels, cond.flatMap((c) => arr(c.dimensions).map((d) => (obj(d) ?? {}) as { name?: unknown; value?: unknown })));
  const rule = str(e.alertRule, 200) ?? labels.alertname ?? "Azure Monitor alert";
  const title = str(props.title, 300) ?? rule;
  const metricText = cond.map((c) => {
    const m = str(c.metricName, 80), op = str(c.operator, 30), th = str(c.threshold, 30), v = c.metricValue;
    return m ? `${m} ${op ?? ""} ${th ?? ""}${typeof v === "number" ? ` (= ${v})` : ""}`.replace(/\s+/g, " ").trim() : null;
  }).filter(Boolean).join(" · ");
  const description = plain(promAnn.description) ?? plain(props.communication) ?? plain(props.details) ?? (metricText || undefined);
  const values: Record<string, number> = {};
  for (const c of cond) if (typeof c.metricValue === "number" && str(c.metricName, 40)) values[str(c.metricName, 40)!] = c.metricValue;
  if (typeof ctx.expressionValue === "number") values.value = ctx.expressionValue;
  const links: NotifyLink[] = [];
  const investigation = str(e.investigationLink, 2000);
  if (investigation && /^https:\/\/portal\.azure\.com\//.test(investigation)) addLink(links, "portal", "portal", investigation);
  else if (str(e.alertId, 600)?.startsWith("/subscriptions/")) addLink(links, "portal", "portal", `https://portal.azure.com/#view/Microsoft_Azure_Monitoring_Alerts/AlertDetails.ReactView/alertId/${encodeURIComponent(str(e.alertId, 600)!)}`);
  for (const c of cond) { const u = str(c.linkToFilteredSearchResultsUI, 2000) ?? str(c.linkToSearchResultsUI, 2000); if (u && /^https:\/\/portal\.azure\.com\//.test(u)) addLink(links, "portal", "logs", u); }
  addLink(links, "runbook", "runbook", promAnn.runbook_url);
  addLink(links, "dashboard", "dashboard", promAnn.dashboard);
  const sev = labels.severity ? labelSeverity(labels.severity) : severity;
  const { category, basis } = classify({ labels, service, names: [rule, title], severity: sev });
  const target = {
    ...targetFromLabels(labels),
    ...(resourceId ? { resourceId } : {}),
    ...(arm.resourceName ? { resourceName: arm.resourceName } : {}), ...(arm.resourceType ? { resourceType: arm.resourceType } : {}),
    ...(arm.resourceGroup ? { resourceGroup: arm.resourceGroup } : {}), ...(arm.subscriptionId ? { subscriptionId: arm.subscriptionId } : {}),
  };
  const status = String(e.monitorCondition ?? "").toLowerCase() === "resolved" ? "resolved" as const : "firing" as const;
  const base = { category, service, target, rule, title };
  return [{
    id: `az:${hash(alertId)}`, source: "azure-monitor", status, severity: sev, category, categoryBasis: basis, rule, title,
    ...(str(e.description, 1000) ?? plain(promAnn.summary, 1000) ? { summary: str(e.description, 1000) ?? plain(promAnn.summary, 1000) } : {}),
    ...(description ? { description } : {}),
    ...(service ? { service } : {}),
    target, labels, ...(Object.keys(values).length ? { values } : {}),
    links: [...featureLinks(base), ...links],
    startsAt: iso(e.firedDateTime) ?? now.toISOString(),
    ...(status === "resolved" ? { endsAt: iso(e.resolvedDateTime) ?? now.toISOString() } : {}),
  }];
}

// ── Grafana Alerting / Alertmanager ──

function parseAlertList(body: Obj, kind: "grafana" | "alertmanager", now: Date): ParsedAlert[] {
  const common = obj(body.commonLabels) ?? {};
  const externalURL = str(body.externalURL, 500);
  return arr(body.alerts).slice(0, 200).map(obj).filter((a): a is Obj => !!a).map((a) => {
    const labels = pickLabels({ ...common, ...(obj(a.labels) ?? {}) });
    const ann = obj(a.annotations) ?? {};
    const rule = labels.alertname ?? str(body.title, 200) ?? "Grafana alert";
    const severity = labelSeverity(labels.severity);
    const summary = plain(ann.summary, 1000) ?? plain(obj(body.commonAnnotations)?.summary, 1000);
    const description = plain(ann.description, 2000);
    const service = labels.grafana_folder ?? (kind === "grafana" ? "Grafana" : "Alertmanager");
    const links: NotifyLink[] = [];
    addLink(links, "dashboard", "dashboard", ann.dashboard);
    addLink(links, "runbook", "runbook", ann.runbook_url);
    addLink(links, "dashboard", "dashboard", a.dashboardURL);
    addLink(links, "dashboard", "panel", a.panelURL);
    // URLs written into the description ("🔗 Grafana: https://…")
    for (const m of (typeof ann.description === "string" ? ann.description : "").match(URL_IN_TEXT) ?? []) addLink(links, "grafana", "grafana", m);
    addLink(links, "source", "rule", a.generatorURL);
    addLink(links, "silence", "silence", a.silenceURL);
    if (!links.some((l) => l.kind === "grafana" || l.kind === "dashboard") && externalURL) addLink(links, "grafana", "grafana", externalURL);
    const { category, basis } = classify({ labels, service, names: [rule, summary ?? ""], severity });
    const target = targetFromLabels(labels);
    const fp = str(a.fingerprint, 100) ?? JSON.stringify(Object.entries(labels).sort());
    const status = (str(a.status, 20) ?? str(body.status, 20)) === "resolved" ? "resolved" as const : "firing" as const;
    const values = numbers(a.values);
    const base = { category, service, target, rule, title: rule };
    return {
      id: `${kind === "grafana" ? "gf" : "am"}:${hash(`${fp}|${rule}`)}`, source: kind, status, severity, category, categoryBasis: basis, rule, title: rule,
      ...(summary ? { summary } : {}), ...(description ? { description } : {}), service,
      target, labels, ...(values ? { values } : {}),
      links: [...featureLinks(base), ...links],
      startsAt: iso(a.startsAt) ?? now.toISOString(),
      ...(status === "resolved" ? { endsAt: iso(a.endsAt) ?? now.toISOString() } : {}),
    } satisfies ParsedAlert;
  });
}

/** The receiver's one entry: which format, and the alerts in it */
export function parseAlertPayload(body: unknown, now = new Date()): DetectResult {
  const b = obj(body);
  if (!b) return { kind: "unsupported", reason: "not_json_object" };
  if (obj(obj(b.data)?.essentials)) return { kind: "azure", alerts: parseAzure(b, now) };
  if (Array.isArray(b.alerts)) {
    const grafana = b.orgId !== undefined || b.state !== undefined || arr(b.alerts).some((a) => obj(a)?.values !== undefined || obj(a)?.silenceURL !== undefined);
    const alerts = parseAlertList(b, grafana ? "grafana" : "alertmanager", now);
    return alerts.length ? { kind: grafana ? "grafana" : "alertmanager", alerts } : { kind: "unsupported", reason: "no_alerts" };
  }
  // The older non-common Azure schemas (metric alert v1/v2, activity log) carry no `essentials`
  if (b.schemaId || obj(b.data)?.context || b.context) return { kind: "unsupported", reason: "azure_not_common_schema" };
  return { kind: "unsupported", reason: "unknown_shape" };
}

// ── Samples (the setup screen's test buttons and the tests) ──

export function samplePayload(kind: "azure" | "grafana", now = new Date()): Obj {
  const at = now.toISOString();
  if (kind === "azure") {
    return {
      schemaId: "azureMonitorCommonAlertSchema",
      data: {
        essentials: {
          alertId: `/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.AlertsManagement/alerts/test-${now.getTime()}`,
          alertRule: "Test — node CPU high", severity: "Sev2", signalType: "Metric", monitorCondition: "Fired", monitoringService: "Platform",
          alertTargetIDs: ["/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-example/providers/microsoft.containerservice/managedclusters/aks-example"],
          firedDateTime: at, description: "Sample alert from the setup screen", essentialsVersion: "1.0", alertContextVersion: "1.0",
        },
        alertContext: { condition: { windowSize: "PT5M", allOf: [{ metricName: "node_cpu_usage_percentage", operator: "GreaterThan", threshold: "90", timeAggregation: "Average", metricValue: 93.5, dimensions: [{ name: "node", value: "aks-pool-0" }] }] } },
      },
    };
  }
  return {
    receiver: "aud-dashboard", status: "firing", orgId: 1, version: "1", title: "[FIRING:1] TestPodCrashLooping",
    commonLabels: { alertname: "TestPodCrashLooping", severity: "sev2", namespace: "example" },
    alerts: [{
      status: "firing",
      labels: { alertname: "TestPodCrashLooping", severity: "sev2", namespace: "example", pod: "example-api-0", team: "platform" },
      annotations: { summary: "Sample alert from the setup screen", description: "CrashLoopBackOff 5m — kubectl -n example describe pod example-api-0" },
      startsAt: at, endsAt: "0001-01-01T00:00:00Z", fingerprint: `test${now.getTime()}`, values: { A: 3 },
    }],
  };
}

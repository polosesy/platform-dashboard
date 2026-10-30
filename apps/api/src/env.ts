import { z } from "zod";
import { isAbsolute } from "node:path";

/**
 * Boolean env flag. `z.coerce.boolean()` treats any non-empty string as true
 * (so "false" → true), which silently inverted every *_ENABLED flag.
 */
const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (typeof v === "boolean") return v;
      if (v === undefined || v.trim() === "") return defaultValue;
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    });

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000,http://localhost:3001"),
  /** Interface the API listens on — loopback by default (the web reaches it through its /api rewrite) */
  API_BIND_HOST: z.string().default("127.0.0.1"),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // ── Sign-in policy ──
  // Every bearer token is verified (signature, issuer, audience, lifetime, scope). Sign-in (SSO) decides WHO may use
  // the platform and with which platform role (app roles AUD.Viewer / AUD.Operator / AUD.Admin); Azure is read with
  // the platform's own credential of each connection (infra/connectionRegistry.ts) — not with the user's Azure
  // permissions, unless a connection is "delegated" (OBO). Anonymous callers get sample data or 401.
  /** Local development only: anonymous callers read Azure with the service principal (loopback bind required) */
  AUD_ANONYMOUS_SP: envBool(false),
  /** …and may also reach AKS (kubeconfig, pod logs, Hubble exec). Ignored unless AUD_ANONYMOUS_SP is on */
  AUD_ANONYMOUS_K8S: envBool(false),
  /** Delegated scopes of this API accepted in `scp` (comma list) */
  AUD_AUTH_SCOPES: z.string().default("Azure.Read.All"),
  /** Accepted `aud` values (comma list); default api://{AZURE_AD_CLIENT_ID} and {AZURE_AD_CLIENT_ID} */
  AUD_AUTH_AUDIENCES: z.string().optional(),
  /**
   * Role for a signed-in user whose token carries none of this app's roles (app roles not assigned yet).
   * Unset: "viewer" in development, "none" (403 no_platform_role) in production — production refuses any other value.
   */
  AUD_DEFAULT_ROLE: z.enum(["none", "viewer", "operator", "admin"]).optional(),
  /** Azure connections (JSON, never committed — config/connections.example.json). Unset: the home connection only */
  AUD_CONNECTIONS_FILE: z.string().optional(),
  /** Deprecated alias of AUD_CONNECTIONS_FILE (version-1 "tenants" document) */
  AUD_TENANTS_FILE: z.string().optional(),
  /** How the home connection reads Azure: the platform identity (default) or each user's own permissions (OBO) */
  AUD_HOME_CONNECTION_MODE: z.enum(["platform", "delegated"]).default("platform"),
  /** Platform credential as a certificate (absolute PEM path) instead of AZURE_AD_CLIENT_SECRET */
  AUD_PLATFORM_CERT_PATH: z.string().optional(),
  /**
   * How the platform identity proves itself: certificate | secret | workloadIdentity (a user-assigned managed
   * identity through a federated service-account token — no secret; AKS). Unset = certificate if
   * AUD_PLATFORM_CERT_PATH, else secret if AZURE_AD_CLIENT_SECRET, else workloadIdentity if a token file is set.
   */
  AUD_PLATFORM_CREDENTIAL: z.enum(["certificate", "secret", "workloadIdentity"]).optional(),
  /** Client id the platform credential signs in as. workloadIdentity: the managed identity (default AZURE_CLIENT_ID,
   *  set by the AKS webhook) — NOT the SSO app (AZURE_AD_CLIENT_ID stays the token audience) */
  AUD_PLATFORM_CLIENT_ID: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a GUID").optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  /** Build / image version shown by /healthz and the startup log */
  AUD_VERSION: z.string().max(64).optional(),
  /**
   * Workload identity federation (servicePrincipal connections with `federation: {kind: "kubernetes"}`): the projected
   * service-account token file of the pod the API runs in (audience api://AzureADTokenExchange). Falls back to
   * AZURE_FEDERATED_TOKEN_FILE, which the AKS workload identity webhook sets. Absolute path.
   */
  AUD_FEDERATED_TOKEN_FILE: z.string().optional(),
  AZURE_FEDERATED_TOKEN_FILE: z.string().optional(),
  /** Shown to admins only, to write the customer's federated credential: this platform's OIDC issuer and subject */
  AUD_PLATFORM_OIDC_ISSUER: z.string().url().optional(),
  AUD_PLATFORM_FEDERATION_SUBJECT: z.string().regex(/^system:serviceaccount:[a-z0-9-]+:[a-z0-9.-]+$/, "system:serviceaccount:<namespace>:<name>").optional(),
  /** One JSON audit line per signed-in API request (who · role · connection · route · status), never tokens or IDs */
  AUD_AUDIT_LOG: z.enum(["off", "stdout"]).optional(),
  /** Team layout of the infrastructure diagram: a writable directory (mounted volume); unset = in memory, lost on restart */
  AUD_ARRANGEMENT_DIR: z.string().refine((v) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v), "absolute path").optional(),
  /** 통합 위험 이슈 상태(열림·진행·해결·예외): a writable directory; unset = `<AUD_ARRANGEMENT_DIR>/issues`, else in memory */
  AUD_ISSUE_STATE_DIR: z.string().refine((v) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v), "absolute path").optional(),
  /** 알림 센터 receiver (POST /hooks/alerts/*): the shared secret Azure action groups (?token=) and Grafana
   *  (Authorization: Bearer) send — unset = the receiver answers 404. At least 32 characters. */
  AUD_ALERT_RECEIVER_TOKEN: z.string().min(32).optional(),
  /** Where received alerts are kept: a writable directory; unset = `<AUD_ARRANGEMENT_DIR>/notifications`, else in memory */
  AUD_NOTIFY_DIR: z.string().refine((v) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v), "absolute path").optional(),
  AUD_NOTIFY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Optional internal relay (https, set by the platform admin): each new / changed alert at or above the minimum
   *  severity is POSTed as {title, message, …} — e.g. an in-house bot or mail gateway. Never a messenger by default. */
  AUD_NOTIFY_RELAY_URL: z.string().url().refine((v) => v.startsWith("https://"), "https only").optional(),
  AUD_NOTIFY_RELAY_MIN_SEVERITY: z.enum(["sev1", "sev2", "sev3", "sev4"]).default("sev2"),
  AZURE_SUBSCRIPTION_IDS: z.string().optional(),

  // Verbose diagnostic logging (graph build, hubble strategies, KQL row counts)
  AUD_DEBUG: envBool(false),

  // Azure Log Analytics (Traffic Analytics)
  AZURE_LOG_ANALYTICS_WORKSPACE_ID: z.string().optional(),
  AZURE_LOG_ANALYTICS_TABLE: z.string().default("NTANetAnalytics"),
  AZURE_LOG_ANALYTICS_CACHE_TTL_MS: z.coerce.number().default(60_000),
  /** VNet traffic coverage (flow-log resources, workspaces, last row) cache */
  AZURE_NETWORK_COVERAGE_TTL_MS: z.coerce.number().default(300_000),

  // Azure Reservations (Consumption)
  AZURE_RESERVATIONS_GRAIN: z.enum(["daily", "monthly"]).default("monthly"),
  AZURE_RESERVATIONS_CACHE_TTL_MS: z.coerce.number().default(10 * 60_000),

  // Azure AD (API confidential client) for OBO
  AZURE_AD_TENANT_ID: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),

  // Azure Resource Graph
  AZURE_RESOURCE_GRAPH_PAGE_SIZE: z.coerce.number().default(1000),
  AZURE_RESOURCE_GRAPH_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // Azure Cost Management (set false to serve mock data only)
  AZURE_COST_MANAGEMENT_ENABLED: envBool(true),
  AZURE_COST_CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),

  // Azure Security — Defender for Cloud (set false to serve mock data only)
  AZURE_SECURITY_ENABLED: envBool(true),
  AZURE_SECURITY_CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),
  // Security posture (/api/security/posture) uses the signed-in user (OBO) only. Set true to let
  // anonymous requests read live Defender data with the service principal (local verification only).
  AZURE_SECURITY_SP_FALLBACK: envBool(false),

  // 보안 › 긴급 취약점: official public feeds (CISA KEV, NVD, nodejs.org, php.net) read by the API — false in an
  // air-gapped install (the page then matches only Defender findings and the platform's own runtime)
  AUD_ADVISORY_FEEDS: envBool(true),
  // Send the package list (npm / OS package names + versions, Kubernetes and known open-source image versions — never
  // app image names) to api.osv.dev for exact-version matching. false = keep feeds, skip the SBOM match
  AUD_ADVISORY_OSV: envBool(true),
  // Optional NVD API key (raises the public rate limit of 5 requests / 30 s)
  AUD_NVD_API_KEY: z.string().optional(),

  // Live diagram: who uses each Private Endpoint (PaaS access logs + VNet flow logs). Signed-in users only;
  // the SP fallback is for local verification (access logs name callers, so anonymous use is off by default).
  AZURE_PL_USAGE_ENABLED: envBool(true),
  AZURE_PL_USAGE_SP_FALLBACK: envBool(false),
  AZURE_PL_USAGE_CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),
  AZURE_PL_USAGE_WINDOW_H: z.coerce.number().int().min(1).max(168).default(24),

  // Azure Resource Health (set false to serve mock data only)
  AZURE_HEALTH_ENABLED: envBool(true),
  AZURE_HEALTH_CACHE_TTL_MS: z.coerce.number().default(2 * 60_000),

  // Azure Translator (optional — for Service Events translation feature)
  AZURE_TRANSLATOR_KEY: z.string().optional(),
  AZURE_TRANSLATOR_REGION: z.string().optional(),
  /**
   * The keyless public translate endpoint when no AZURE_TRANSLATOR_KEY is set. Unset = on in development, OFF in
   * production: event text is not sent to an unauthenticated third-party endpoint from a server (and a container's
   * egress policy would block it anyway)
   */
  AUD_TRANSLATOR_KEYLESS: z.union([z.boolean(), z.string()]).optional()
    .transform((v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()))),
  /** Azure status RSS feeds, tried in order (comma list, https only) — default the two public Azure status feeds */
  AZURE_STATUS_FEED_URLS: z.string().optional()
    .refine((v) => !v || v.split(",").every((u) => /^https:\/\/[a-z0-9.-]+(\/\S*)?$/i.test(u.trim())), "a comma list of https URLs"),

  // Live Diagram — Azure Monitor real integration
  AZURE_LIVE_DIAGRAM_ENABLED: envBool(false),
  AZURE_LIVE_METRICS_CACHE_TTL_MS: z.coerce.number().default(60_000),
  AZURE_MONITOR_ALERTS_CACHE_TTL_MS: z.coerce.number().default(30_000),
  AZURE_APP_INSIGHTS_APP_ID: z.string().optional(),
  AZURE_APP_INSIGHTS_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // NSG Flow Logs (from Azure Blob Storage)
  AZURE_NSG_FLOW_LOG_STORAGE_ACCOUNT: z.string().optional(),
  AZURE_NSG_FLOW_LOG_CONTAINER: z.string().default("insights-logs-networksecuritygroupflowevent"),
  AZURE_NSG_FLOW_LOG_CACHE_TTL_MS: z.coerce.number().default(120_000),

  // Traffic Analytics (live diagram edge traffic)
  AZURE_TRAFFIC_ANALYTICS_ENABLED: envBool(false),
  AZURE_TRAFFIC_ANALYTICS_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // Connection Monitor
  AZURE_CONNECTION_MONITOR_ENABLED: envBool(false),
  AZURE_CONNECTION_MONITOR_CACHE_TTL_MS: z.coerce.number().default(120_000),

  // Observability / APM (Container Insights + Prometheus + App Insights)
  AZURE_CONTAINER_INSIGHTS_WORKSPACE_ID: z.string().optional(), // Log Analytics workspace for Container Insights (auto-discovered from the cluster when unset)
  AZURE_PROMETHEUS_ENDPOINT: z.string().optional(),             // Prometheus HTTP API base URL (auto-discovered when unset)
  AZURE_OBSERVABILITY_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // AKS access (services/aksAccess.ts, docs/integrations/azure/aks.md)
  /**
   * Clusters without Entra integration hand out a static client certificate that is effectively cluster-admin and
   * revocable only by rotating the cluster CA. Refused unless this (development only — production refuses it) or the
   * connection's `aks.allowLocalAccount` allows it.
   */
  AUD_AKS_ALLOW_LOCAL_ACCOUNTS: envBool(false),
  /** Pre-flight DNS + TCP 443 probe of the API server (ms per step) — a private cluster answers fast instead of hanging */
  AUD_AKS_PROBE_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),

  // Cilium Hubble
  HUBBLE_ENABLED: envBool(true),
  /**
   * Hubble reads flows by exec-ing `hubble observe` in the privileged cilium-agent pods (≈ node access) or through the
   * API server's service proxy. Unset: on in development, off in production. Even when on, only the home connection
   * (platform / delegated) or a connection with `aks.hubbleExec: true` may use it.
   */
  HUBBLE_EXEC_ENABLED: z.union([z.boolean(), z.string()]).optional()
    .transform((v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()))),
  HUBBLE_RELAY_NAMESPACE: z.string().default("kube-system"),
  HUBBLE_RELAY_PORT: z.coerce.number().default(80),
  HUBBLE_FLOW_LIMIT: z.coerce.number().default(10_000),
  HUBBLE_CACHE_TTL_MS: z.coerce.number().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(processEnv: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(processEnv);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${msg}`);
  }
  return assertSafeEnv(parsed.data);
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

/** Settings that must never ship together (exported for tests) */
export function assertSafeEnv(env: Env): Env {
  if (env.AUD_ANONYMOUS_SP && !LOOPBACK.test(env.API_BIND_HOST)) {
    throw new Error(`AUD_ANONYMOUS_SP=true needs a loopback API_BIND_HOST (got ${env.API_BIND_HOST}) — anonymous callers would read Azure with the service principal`);
  }
  if (env.NODE_ENV === "production" && env.AUD_DEFAULT_ROLE && env.AUD_DEFAULT_ROLE !== "none") {
    throw new Error("AUD_DEFAULT_ROLE must be none in production — assign the app roles (AUD.Viewer / AUD.Operator / AUD.Admin) instead");
  }
  if (env.NODE_ENV === "production" && env.AUD_AKS_ALLOW_LOCAL_ACCOUNTS) {
    throw new Error("AUD_AKS_ALLOW_LOCAL_ACCOUNTS must be off in production — a local-account kubeconfig is cluster-admin; allow it per connection (aks.allowLocalAccount) after review");
  }
  if (env.AUD_PLATFORM_CERT_PATH && !isAbsolute(env.AUD_PLATFORM_CERT_PATH)) {
    throw new Error("AUD_PLATFORM_CERT_PATH must be an absolute path");
  }
  // An explicit platform credential needs its input — fail at start, not on the first Azure call
  if (env.AUD_PLATFORM_CREDENTIAL === "certificate" && !env.AUD_PLATFORM_CERT_PATH) throw new Error("AUD_PLATFORM_CREDENTIAL=certificate needs AUD_PLATFORM_CERT_PATH");
  if (env.AUD_PLATFORM_CREDENTIAL === "secret" && !env.AZURE_AD_CLIENT_SECRET) throw new Error("AUD_PLATFORM_CREDENTIAL=secret needs AZURE_AD_CLIENT_SECRET");
  if (env.AUD_PLATFORM_CREDENTIAL === "workloadIdentity") {
    if (!(env.AUD_FEDERATED_TOKEN_FILE ?? env.AZURE_FEDERATED_TOKEN_FILE)) throw new Error("AUD_PLATFORM_CREDENTIAL=workloadIdentity needs AUD_FEDERATED_TOKEN_FILE (or the webhook's AZURE_FEDERATED_TOKEN_FILE)");
    if (!(env.AUD_PLATFORM_CLIENT_ID ?? env.AZURE_CLIENT_ID)) throw new Error("AUD_PLATFORM_CREDENTIAL=workloadIdentity needs AUD_PLATFORM_CLIENT_ID (the managed identity's client id) or the webhook's AZURE_CLIENT_ID");
  }
  for (const name of ["AUD_FEDERATED_TOKEN_FILE", "AZURE_FEDERATED_TOKEN_FILE"] as const) {
    if (env[name] && !isAbsolute(env[name]!)) throw new Error(`${name} must be an absolute path`);
  }
  if (env.CORS_ORIGIN.split(",").some((o) => o.trim() === "*")) {
    throw new Error("CORS_ORIGIN must list origins, not *");
  }
  return env;
}

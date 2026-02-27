import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  ARGOCD_BASE_URL: z.string().optional(),
  ARGOCD_TOKEN: z.string().optional(),
  AZURE_SUBSCRIPTION_IDS: z.string().optional(),

  // Azure Log Analytics (Traffic Analytics)
  AZURE_LOG_ANALYTICS_WORKSPACE_ID: z.string().optional(),
  AZURE_LOG_ANALYTICS_TABLE: z.string().default("NTANetAnalytics"),
  AZURE_LOG_ANALYTICS_CACHE_TTL_MS: z.coerce.number().default(60_000),

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

  // Azure Cost Management
  AZURE_COST_MANAGEMENT_ENABLED: z.coerce.boolean().default(false),
  AZURE_COST_CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),

  // Azure Security (Defender for Cloud)
  AZURE_SECURITY_ENABLED: z.coerce.boolean().default(false),
  AZURE_SECURITY_CACHE_TTL_MS: z.coerce.number().default(5 * 60_000),

  // Azure Resource Health
  AZURE_HEALTH_ENABLED: z.coerce.boolean().default(false),
  AZURE_HEALTH_CACHE_TTL_MS: z.coerce.number().default(2 * 60_000),

  // Live Diagram — Azure Monitor real integration
  AZURE_LIVE_DIAGRAM_ENABLED: z.coerce.boolean().default(false),
  AZURE_LIVE_METRICS_CACHE_TTL_MS: z.coerce.number().default(60_000),
  AZURE_MONITOR_ALERTS_CACHE_TTL_MS: z.coerce.number().default(60_000),
  AZURE_APP_INSIGHTS_APP_ID: z.string().optional(),
  AZURE_APP_INSIGHTS_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // NSG Flow Logs (from Azure Blob Storage)
  AZURE_NSG_FLOW_LOG_STORAGE_ACCOUNT: z.string().optional(),
  AZURE_NSG_FLOW_LOG_CONTAINER: z.string().default("insights-logs-networksecuritygroupflowevent"),
  AZURE_NSG_FLOW_LOG_CACHE_TTL_MS: z.coerce.number().default(120_000),

  // Traffic Analytics (live diagram edge traffic)
  AZURE_TRAFFIC_ANALYTICS_ENABLED: z.coerce.boolean().default(false),
  AZURE_TRAFFIC_ANALYTICS_CACHE_TTL_MS: z.coerce.number().default(60_000),

  // Connection Monitor
  AZURE_CONNECTION_MONITOR_ENABLED: z.coerce.boolean().default(false),
  AZURE_CONNECTION_MONITOR_CACHE_TTL_MS: z.coerce.number().default(120_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(processEnv: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(processEnv);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${msg}`);
  }
  return parsed.data;
}

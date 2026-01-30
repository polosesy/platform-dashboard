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

  // Azure AD (API confidential client) for OBO
  AZURE_AD_TENANT_ID: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),

  // Azure Resource Graph
  AZURE_RESOURCE_GRAPH_PAGE_SIZE: z.coerce.number().default(1000),
  AZURE_RESOURCE_GRAPH_CACHE_TTL_MS: z.coerce.number().default(60_000)
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

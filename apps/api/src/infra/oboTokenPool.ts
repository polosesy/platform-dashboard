import { OnBehalfOfCredential } from "@azure/identity";
import type { Env } from "../env";
import { bearerKeyPrefix } from "./cacheManager";

type CachedCredential = {
  credential: OnBehalfOfCredential;
  createdAt: number;
};

const CREDENTIAL_TTL_MS = 30 * 60_000; // 30 min

const pool = new Map<string, CachedCredential>();

function ensureOBOConfig(env: Env): { tenantId: string; clientId: string; clientSecret: string } {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("OBO not configured: AZURE_AD_TENANT_ID, CLIENT_ID, CLIENT_SECRET required");
  }
  return { tenantId, clientId, clientSecret };
}

function getOrCreateCredential(env: Env, bearerToken: string): OnBehalfOfCredential {
  const key = bearerKeyPrefix(bearerToken);
  const cached = pool.get(key);
  if (cached && Date.now() - cached.createdAt < CREDENTIAL_TTL_MS) {
    return cached.credential;
  }
  const { tenantId, clientId, clientSecret } = ensureOBOConfig(env);
  const credential = new OnBehalfOfCredential({
    tenantId,
    clientId,
    clientSecret,
    userAssertionToken: bearerToken,
  });
  pool.set(key, { credential, createdAt: Date.now() });

  // Evict old entries
  if (pool.size > 200) {
    const cutoff = Date.now() - CREDENTIAL_TTL_MS;
    for (const [k, v] of pool) {
      if (v.createdAt < cutoff) pool.delete(k);
    }
  }

  return credential;
}

async function getToken(env: Env, bearerToken: string, scope: string): Promise<string> {
  const credential = getOrCreateCredential(env, bearerToken);
  const result = await credential.getToken(scope);
  return result.token;
}

export async function getArmToken(env: Env, bearerToken: string): Promise<string> {
  return getToken(env, bearerToken, "https://management.azure.com/.default");
}

export async function getLogAnalyticsToken(env: Env, bearerToken: string): Promise<string> {
  return getToken(env, bearerToken, "https://api.loganalytics.io/.default");
}

export function getOBOCredential(env: Env, bearerToken: string): OnBehalfOfCredential {
  return getOrCreateCredential(env, bearerToken);
}

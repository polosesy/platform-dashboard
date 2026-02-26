import { createHash } from "crypto";
import { OnBehalfOfCredential } from "@azure/identity";
import type { Env } from "../env";
import type {
  ReservationUtilizationResponse,
  ReservationUtilizationRow,
  SubscriptionReservationUtilization,
} from "../types";

type Grain = "daily" | "monthly";

type ReservationSummaryItem = {
  properties?: {
    reservationId?: string;
    reservationOrderId?: string;
    skuName?: string;
    usedHours?: number;
    reservedHours?: number;
    utilizedPercentage?: number;
    usageDate?: string;
  };
};

type ReservationSummariesResponse = {
  value?: ReservationSummaryItem[];
};

let cache:
  | {
      key: string;
      expiresAt: number;
      resp: ReservationUtilizationResponse;
    }
  | undefined;

function bearerKey(bearerToken: string): string {
  return createHash("sha256").update(bearerToken).digest("hex").slice(0, 16);
}

function parseSubscriptionIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(used: number, reserved: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(reserved) || reserved <= 0) return 0;
  return Math.max(0, Math.min(100, (used / reserved) * 100));
}

async function armGetJson<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ARM request failed: HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

async function getArmAccessToken(env: Env, bearerToken: string): Promise<string> {
  const tenantId = env.AZURE_AD_TENANT_ID;
  const clientId = env.AZURE_AD_CLIENT_ID;
  const clientSecret = env.AZURE_AD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Azure OBO not configured (AZURE_AD_* required)");
  }

  const credential = new OnBehalfOfCredential({
    tenantId,
    clientId,
    clientSecret,
    userAssertionToken: bearerToken,
  });
  const token = await credential.getToken("https://management.azure.com/.default");
  if (!token?.token) throw new Error("Failed to acquire ARM token");
  return token.token;
}

async function fetchReservationSummariesForSubscription(armToken: string, subscriptionId: string, grain: Grain) {
  const scope = `/subscriptions/${subscriptionId}`;
  const url = `https://management.azure.com${scope}/providers/Microsoft.Consumption/reservationSummaries?api-version=2024-08-01&grain=${grain}`;
  return await armGetJson<ReservationSummariesResponse>(armToken, url);
}

function aggregateLatestPeriod(items: ReservationSummaryItem[], grain: Grain): {
  usedHours: number;
  reservedHours: number;
  utilizedPercentage: number;
  rows: ReservationUtilizationRow[];
} {
  const rows: ReservationUtilizationRow[] = [];

  const byDate = new Map<string, ReservationSummaryItem[]>();
  for (const it of items) {
    const d = it.properties?.usageDate ?? "";
    const key = d ? d : "__unknown__";
    const arr = byDate.get(key) ?? [];
    arr.push(it);
    byDate.set(key, arr);
  }

  const dates = [...byDate.keys()].filter((d) => d !== "__unknown__").sort();
  const latest = dates.at(-1) ?? "__unknown__";
  const latestItems = byDate.get(latest) ?? [];

  let used = 0;
  let reserved = 0;
  for (const it of latestItems) {
    const p = it.properties;
    if (!p) continue;
    const usedHours = safeNum(p.usedHours);
    const reservedHours = safeNum(p.reservedHours);
    used += usedHours;
    reserved += reservedHours;
    rows.push({
      reservationId: p.reservationId,
      reservationOrderId: p.reservationOrderId,
      skuName: p.skuName,
      usedHours,
      reservedHours,
      utilizedPercentage: typeof p.utilizedPercentage === "number" ? p.utilizedPercentage : undefined,
    });
  }

  rows.sort((a, b) => b.reservedHours - a.reservedHours);
  const utilizedPercentage = pct(used, reserved);

  return { usedHours: used, reservedHours: reserved, utilizedPercentage, rows };
}

export function mockReservationUtilization(grain: Grain, note?: string): ReservationUtilizationResponse {
  const subs: SubscriptionReservationUtilization[] = [
    {
      subscriptionId: "SUBSCRIPTION_ID_1",
      grain,
      utilizedPercentage: 71.2,
      usedHours: 712,
      reservedHours: 1000,
      topReservations: [
        { skuName: "Standard_D4s_v5", usedHours: 300, reservedHours: 400, utilizedPercentage: 75 },
        { skuName: "Standard_D2s_v5", usedHours: 240, reservedHours: 350, utilizedPercentage: 68.6 },
      ],
    },
    {
      subscriptionId: "SUBSCRIPTION_ID_2",
      grain,
      utilizedPercentage: 54.8,
      usedHours: 548,
      reservedHours: 1000,
      topReservations: [{ skuName: "Standard_E4s_v5", usedHours: 548, reservedHours: 1000, utilizedPercentage: 54.8 }],
    },
  ];
  const usedHours = subs.reduce((a, s) => a + s.usedHours, 0);
  const reservedHours = subs.reduce((a, s) => a + s.reservedHours, 0);
  return {
    generatedAt: new Date().toISOString(),
    grain,
    utilizedPercentage: pct(usedHours, reservedHours),
    usedHours,
    reservedHours,
    subscriptions: subs,
    note,
  };
}

export async function tryGetReservationUtilization(
  env: Env,
  bearerToken: string | undefined,
  grainOverride?: Grain,
  opts?: { subscriptionId?: string }
): Promise<ReservationUtilizationResponse | null> {
  if (!bearerToken) return null;
  if (!env.AZURE_SUBSCRIPTION_IDS) return null;

  const grain: Grain = grainOverride ?? env.AZURE_RESERVATIONS_GRAIN;
  const allowedSubs = parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS);
  if (allowedSubs.length === 0) return null;

  const subs = opts?.subscriptionId ? [opts.subscriptionId] : allowedSubs;
  if (opts?.subscriptionId && !allowedSubs.includes(opts.subscriptionId)) {
    throw new Error("subscriptionId is not in AZURE_SUBSCRIPTION_IDS allow-list");
  }
  if (subs.length === 0) return null;

  const key = `${bearerKey(bearerToken)}:${grain}:${subs.join(",")}`;
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) return cache.resp;

  const armToken = await getArmAccessToken(env, bearerToken);

  const perSub: SubscriptionReservationUtilization[] = [];
  for (const subId of subs) {
    const json = await fetchReservationSummariesForSubscription(armToken, subId, grain);
    const items = json.value ?? [];
    const agg = aggregateLatestPeriod(items, grain);
    perSub.push({
      subscriptionId: subId,
      grain,
      utilizedPercentage: agg.utilizedPercentage,
      usedHours: agg.usedHours,
      reservedHours: agg.reservedHours,
      topReservations: agg.rows.slice(0, 5),
    });
  }

  const usedHours = perSub.reduce((a, s) => a + s.usedHours, 0);
  const reservedHours = perSub.reduce((a, s) => a + s.reservedHours, 0);
  const resp: ReservationUtilizationResponse = {
    generatedAt: new Date().toISOString(),
    grain,
    utilizedPercentage: pct(usedHours, reservedHours),
    usedHours,
    reservedHours,
    subscriptions: perSub,
  };

  cache = {
    key,
    expiresAt: now + env.AZURE_RESERVATIONS_CACHE_TTL_MS,
    resp,
  };

  return resp;
}

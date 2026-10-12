import type { Env } from "../env.js";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager.js";
import { getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";
import type {
  ReservationUtilizationResponse,
  ReservationUtilizationRow,
  SubscriptionReservationUtilization,
} from "@aud/types";

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

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(used: number, reserved: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(reserved) || reserved <= 0) return 0;
  return Math.max(0, Math.min(100, (used / reserved) * 100));
}

const utilizationCache = new CacheManager<ReservationUtilizationResponse>(50);

function fetchReservationSummariesForSubscription(fetcher: ArmFetcher, subscriptionId: string, grain: Grain) {
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Consumption/reservationSummaries?api-version=2024-08-01&grain=${grain}`;
  return fetcher.fetchJson<ReservationSummariesResponse>(url);
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
  opts?: { subscriptionId?: string },
): Promise<ReservationUtilizationResponse | null> {
  if (!bearerToken) return null;

  const grain: Grain = grainOverride ?? env.AZURE_RESERVATIONS_GRAIN;
  const subs = opts?.subscriptionId ? [opts.subscriptionId] : parseSubscriptionIds(env);
  if (subs.length === 0) return null;

  const key = `${bearerKeyPrefix(bearerToken)}:${grain}:${subs.join(",")}`;
  const cached = utilizationCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const perSub: SubscriptionReservationUtilization[] = await Promise.all(
    subs.map(async (subId) => {
      const json = await fetchReservationSummariesForSubscription(fetcher, subId, grain);
      const agg = aggregateLatestPeriod(json.value ?? [], grain);
      return {
        subscriptionId: subId,
        grain,
        utilizedPercentage: agg.utilizedPercentage,
        usedHours: agg.usedHours,
        reservedHours: agg.reservedHours,
        topReservations: agg.rows.slice(0, 5),
      };
    }),
  );

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

  utilizationCache.set(key, resp, env.AZURE_RESERVATIONS_CACHE_TTL_MS);
  return resp;
}

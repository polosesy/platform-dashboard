// A load balancer's data path per rule-bound frontend (pure). The API reads `dp<i>` = VipAvailability filtered by
// FrontendIPAddress, in the order of `dataPathFrontendIps` (apps/api/src/services/specGenerator.ts — the same rule,
// tested to agree). The unsplit "data path" Azure shows is the average over every frontend IP × port, not a loss rate:
// 2026-11-16 an internal LB read 83.3 % = five rules at 100 % and one at 0 % (a Service scaled to zero pods).

/** Same cap as the API (specGenerator MAX_DATA_PATH_FRONTENDS) */
export const MAX_DATA_PATH_FRONTENDS = 8;

export function dataPathFrontendIps(frontendsJson: string | undefined): string[] {
  let fes: Array<{ ip?: string; ruleBound?: boolean }> = [];
  try { fes = JSON.parse(frontendsJson ?? "[]") as typeof fes; } catch { return []; }
  return [...new Set(fes.filter((f) => f.ruleBound && f.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(f.ip)).map((f) => f.ip!))].slice(0, MAX_DATA_PATH_FRONTENDS);
}

export type FrontendPath = { ip: string; value: number | null; level: "ok" | "low" | "down" | "unmeasured" };
export type LbDataPath = { frontends: FrontendPath[]; measured: number; down: number; low: number };

/** Pure: each frontend's latest data path (≥ 99 ok · below 99 low · below 90 down — the API's thresholds) */
export function lbDataPath(frontendsJson: string | undefined, metrics: Record<string, number | null> | undefined): LbDataPath | null {
  const ips = dataPathFrontendIps(frontendsJson);
  if (!ips.length) return null;
  const frontends = ips.map((ip, i): FrontendPath => {
    const v = metrics?.[`dp${i}`];
    const value = typeof v === "number" && Number.isFinite(v) ? v : null;
    return { ip, value, level: value == null ? "unmeasured" : value < 90 ? "down" : value < 99 ? "low" : "ok" };
  });
  const measured = frontends.filter((f) => f.value != null);
  return { frontends, measured: measured.length, down: measured.filter((f) => f.level === "down").length, low: measured.filter((f) => f.level !== "ok").length };
}

/** The per-frontend keys are shown in their own section, not in the generic metric list */
export const isDataPathFrontendKey = (k: string) => /^dp\d+$/.test(k);

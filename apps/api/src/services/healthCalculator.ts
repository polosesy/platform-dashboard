import type {
  HealthStatus,
  HealthRule,
  EdgeStatus,
  EdgeTrafficLevel,
  MetricBinding,
  LiveEdge,
} from "@aud/types";

// ────────────────────────────────────────────
// Health Score Calculator
//
// Evaluates composite health rules against
// collected metrics to produce a 0–1 score
// and categorical health status.
// ────────────────────────────────────────────

/**
 * Evaluate composite health rules.
 * Returns a score between 0.0 and 1.0.
 */
export function computeHealthScore(
  metrics: Record<string, number | null>,
  rules: HealthRule[],
): number {
  if (rules.length === 0) return 0.5; // unknown

  let totalWeight = 0;
  let passWeight = 0;

  for (const rule of rules) {
    const value = metrics[rule.metric];
    if (value == null) continue;

    totalWeight += rule.weight;
    const pass = evaluateOp(value, rule.op, rule.threshold);
    if (pass) passWeight += rule.weight;
  }

  return totalWeight > 0 ? passWeight / totalWeight : 0.5;
}

function evaluateOp(value: number, op: HealthRule["op"], threshold: number): boolean {
  switch (op) {
    case "<":  return value < threshold;
    case ">":  return value > threshold;
    case "<=": return value <= threshold;
    case ">=": return value >= threshold;
    case "==": return Math.abs(value - threshold) < 0.001;
    default:   return false;
  }
}

/**
 * Convert a 0–1 score to categorical health status.
 *
 * Thresholds:
 *   score >= 0.70 → ok
 *   score >= 0.40 → warning
 *   score <  0.40 → critical
 *   no data      → unknown
 */
export function scoreToHealth(score: number, hasData: boolean): HealthStatus {
  if (!hasData) return "unknown";
  if (score >= 0.70) return "ok";
  if (score >= 0.40) return "warning";
  return "critical";
}

/**
 * Determine health from metric bindings (handles both composite and simple monitor).
 */
export function resolveNodeHealth(
  metrics: Record<string, number | null>,
  bindings: Record<string, MetricBinding>,
): { health: HealthStatus; score: number } {
  const healthBinding = bindings.health;

  if (healthBinding?.source === "composite" && healthBinding.rules) {
    const score = computeHealthScore(metrics, healthBinding.rules);
    const hasData = Object.values(metrics).some((v) => v != null);
    return { score, health: scoreToHealth(score, hasData) };
  }

  // Fallback: if any metric exists, assume ok; otherwise unknown
  const hasAnyMetric = Object.values(metrics).some((v) => v != null);
  return { score: hasAnyMetric ? 0.75 : 0.5, health: hasAnyMetric ? "ok" : "unknown" };
}

// ────────────────────────────────────────────
// Edge Status + Traffic Level Calculator
// ────────────────────────────────────────────

/**
 * Determine edge status from metrics.
 */
export function resolveEdgeStatus(metrics: LiveEdge["metrics"]): EdgeStatus {
  const { errorRate, latencyMs, throughputBps } = metrics;

  if (errorRate != null && errorRate > 25) return "down";
  if (errorRate != null && errorRate > 5) return "degraded";
  if (latencyMs != null && latencyMs > 2000) return "degraded";
  if (throughputBps != null && throughputBps === 0) return "idle";

  return "normal";
}

/**
 * Determine traffic level (controls animation speed/particles).
 * Normalized against maxThroughput across all edges.
 */
export function resolveTrafficLevel(
  throughputBps: number | undefined,
  maxThroughput: number,
): EdgeTrafficLevel {
  if (throughputBps == null || throughputBps <= 0) return "none";
  if (maxThroughput <= 0) return "low";

  const ratio = throughputBps / maxThroughput;
  if (ratio >= 0.80) return "burst";
  if (ratio >= 0.50) return "high";
  if (ratio >= 0.15) return "medium";
  return "low";
}

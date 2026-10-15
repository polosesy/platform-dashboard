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
 * "Activity" rules (`metric > 0` — requests, transactions, connections, network bytes) say whether the
 * resource is being used, not whether it is healthy: an idle Application Gateway or Storage account is not down.
 * They never lower the score; health comes from the quality rules (CPU, latency, availability, errors…).
 */
export function isActivityRule(rule: HealthRule): boolean {
  return !rule.level && rule.op === ">" && rule.threshold === 0;
}

/** The rule may be judged: its metric has a value and its low-sample guard (`when`) is met */
function judgeable(metrics: Record<string, number | null>, rule: HealthRule): boolean {
  if (metrics[rule.metric] == null) return false;
  if (!rule.when) return true;
  const g = metrics[rule.when.metric];
  return g != null && g >= rule.when.atLeast;
}

/**
 * Leveled rules (hard thresholds): the worst failing level, "ok" when every judgeable one passes, null when none
 * could be judged. Exported for tests.
 */
export function leveledHealth(metrics: Record<string, number | null>, rules: HealthRule[]): HealthStatus | null {
  let judged = false;
  let worst: HealthStatus = "ok";
  for (const rule of rules) {
    if (!rule.level || !judgeable(metrics, rule)) continue;
    judged = true;
    if (evaluateOp(metrics[rule.metric]!, rule.op, rule.threshold)) continue;
    if (rule.level === "critical") worst = "critical";
    else if (worst === "ok") worst = "warning";
  }
  return judged ? worst : null;
}

/**
 * Evaluate composite health rules over the quality rules that have data.
 * Returns a score between 0.0 and 1.0, or null when no quality rule has a value (health unknown).
 */
export function computeHealthScore(
  metrics: Record<string, number | null>,
  rules: HealthRule[],
): number | null {
  let totalWeight = 0;
  let passWeight = 0;

  for (const rule of rules) {
    if (isActivityRule(rule) || rule.level || !judgeable(metrics, rule)) continue;
    const value = metrics[rule.metric]!;

    totalWeight += rule.weight;
    if (evaluateOp(value, rule.op, rule.threshold)) passWeight += rule.weight;
  }

  return totalWeight > 0 ? passWeight / totalWeight : null;
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
  const rules = healthBinding?.source === "composite" ? healthBinding.rules ?? [] : [];
  const score = computeHealthScore(metrics, rules);
  const leveled = leveledHealth(metrics, rules);
  // No rule with data (or no rules at all) → not judged. A metric existing is not evidence of health.
  if (score == null && leveled == null) return { score: 0.5, health: "unknown" };
  const rank = (h: HealthStatus) => (h === "critical" ? 2 : h === "warning" ? 1 : 0);
  const fromScore = score != null ? scoreToHealth(score, true) : "ok";
  const health = leveled != null && rank(leveled) > rank(fromScore) ? leveled : fromScore;
  return { score: score ?? (health === "critical" ? 0.2 : health === "warning" ? 0.55 : 1), health };
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
 * Traffic level (comet size, pace and density) from measured bit/s, in absolute bands — relative to the busiest
 * line, a 1 KB/s line alone on screen read as "burst".
 */
export function resolveTrafficLevel(throughputBps: number | undefined): EdgeTrafficLevel {
  if (throughputBps == null || throughputBps <= 0) return "none";
  if (throughputBps < 100_000) return "low";
  if (throughputBps < 10_000_000) return "medium";
  if (throughputBps < 100_000_000) return "high";
  return "burst";
}

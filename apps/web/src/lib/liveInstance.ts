// Health of one AKS node-pool instance from its Kubernetes node conditions (kubelet-reported) — pure, tested from
// apps/api/test/livePip.test.ts. No conditions → unknown (the power state alone is not health).
import type { AksNodeCondition, HealthStatus } from "@aud/types";

const PRESSURE = new Set(["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"]);

export function instanceHealth(conditions?: AksNodeCondition[], source?: "kubernetes" | "platformMetric" | "containerInsights"): { status: HealthStatus; reason?: string } {
  if (!conditions?.length) return { status: "unknown" };
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready && ready.status !== "True") return { status: "critical", reason: "ld.inst.notReady" };
  if (conditions.some((c) => PRESSURE.has(c.type) && c.status === "True")) return { status: "warning", reason: "ld.inst.pressure" };
  return ready ? { status: "ok", reason: source === "platformMetric" ? "ld.inst.readyMetric" : source === "containerInsights" ? "ld.inst.readyCi" : "ld.inst.ready" } : { status: "unknown" };
}

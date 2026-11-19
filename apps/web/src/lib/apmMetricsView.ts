// APM › 메트릭 — the charts of one service, by section (API services/apmMetrics.ts — tested in apmMetrics.test.ts).
// One time axis for all, so a latency jump can be read against GC, the DB pool and the pods' CPU at the same time.
import type { ApmMetricSection, ApmMetricsResponse } from "@aud/types";

export type ApmChart = { id: string; lines: string[]; limit?: string };
export const APM_SECTIONS: ApmMetricSection[] = ["golden", "runtime", "deps", "pods"];
export const APM_CHARTS: Record<ApmMetricSection, ApmChart[]> = {
  golden: [
    { id: "requests", lines: ["reqOk", "req4xx", "req5xx"] },
    { id: "errors", lines: ["errShare"] },
    { id: "latency", lines: ["p50", "p95", "p99"] },
  ],
  runtime: [
    { id: "heap", lines: ["heapUsed"], limit: "heapMax" },
    { id: "nonHeap", lines: ["nonHeap"] },
    { id: "gc", lines: ["gcPause"] },
    { id: "gcMax", lines: ["gcMax"] },
    { id: "threads", lines: ["threads"] },
    { id: "cpuProcess", lines: ["cpuProcess"] },
  ],
  deps: [
    { id: "pool", lines: ["poolActive", "poolPending"], limit: "poolMax" },
    { id: "poolTimeouts", lines: ["poolTimeouts"] },
    { id: "client", lines: ["clientReq", "clientFailed"] },
    { id: "queued", lines: ["queued"] },
  ],
  pods: [
    { id: "podCpu", lines: ["cpu", "cpuRequest"], limit: "cpuLimit" },
    { id: "podMem", lines: ["mem", "memRequest"], limit: "memLimit" },
  ],
};

/** Pure: whether a section has any measured series (a service without HikariCP / JVM gets one line, not empty charts) */
export function sectionMeasured(svc: NonNullable<ApmMetricsResponse["service"]>, section: ApmMetricSection): boolean {
  return Object.values(svc.sections[section]).some((s) => s.series || s.failed);
}

/** Pure: the service to show — the asked one if listed, else the busiest */
export function pickService(services: ApmMetricsResponse["services"], key: string): { namespace: string; application: string } | null {
  const hit = services.find((s) => `${s.namespace}/${s.application}` === key);
  const s = hit ?? services[0];
  return s ? { namespace: s.namespace, application: s.application } : null;
}

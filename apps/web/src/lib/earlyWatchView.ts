// 긴급 취약점 › 선제 감시 — pure: our Java runtimes (AKS 모니터링's app runtime facts: metrics · telemetry · image config)
// against a vendor's "newest affected per line" list (Oracle's pre-release / advisory, OpenJDK's advisory). The same
// version rule as the API (services/earlyWatch.ts `javaVerdict` — a test keeps them equal).

import type { AppMetricsResponse, EarlyWatchResponse } from "@aud/types";

export type JavaVerdict = "affected" | "newer" | "lineNotListed" | "unknown";

/** "21.0.12+7-LTS" · "jdk-21.0.12+7" · "1.8.0_412" · "8u412" · "21.0.13.0.2" → numbers [line, …] */
export function javaParts(v: string): number[] | null {
  const s = v.trim().toLowerCase().replace(/^jdk-?/, "").replace(/[+-].*$/, "");
  let m = /^1\.8\.0_(\d+)/.exec(s) ?? /^8u(\d+)/.exec(s);
  if (m) return [8, Number(m[1])];
  m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
  if (!m || Number(m[1]) < 9) return null;
  const parts = m.slice(1).filter((x) => x !== undefined).map(Number);
  return parts.length === 1 ? [parts[0]!, 0, 0] : parts;
}
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

export function javaVerdict(version: string, affected: string[]): JavaVerdict {
  const v = javaParts(version);
  if (!v) return "unknown";
  const same = affected.map(javaParts).filter((x): x is number[] => !!x && x[0] === v[0]);
  if (!same.length) return "lineNotListed";
  return same.some((x) => cmp(v, x) <= 0) ? "affected" : "newer";
}

export type JavaRow = {
  namespace: string; workload: string;
  /** null = a Java workload whose version no source told */
  version: string | null;
  basis: string;
  oracle: JavaVerdict | null;
  openjdk: JavaVerdict | null;
};

/** Every Java (jvm) workload with its version and both verdicts — affected first; null verdict = no list to compare */
export function javaExposure(workloads: AppMetricsResponse["workloads"], ew: Pick<EarlyWatchResponse, "oracle" | "openjdk"> | null): JavaRow[] {
  const oracle = ew?.oracle.current.java?.versions.length ? ew.oracle.current.java.versions : null;
  const openjdk = ew?.openjdk?.affected.length ? ew.openjdk.affected : null;
  const rows: JavaRow[] = [];
  for (const w of workloads) {
    const j = w.kinds.find((k) => k.kind === "jvm");
    if (!j) continue;
    const version = j.version ?? null;
    rows.push({
      namespace: w.namespace, workload: w.workload, version, basis: j.basis,
      oracle: oracle ? (version ? javaVerdict(version, oracle) : "unknown") : null,
      openjdk: openjdk ? (version ? javaVerdict(version, openjdk) : "unknown") : null,
    });
  }
  const rank = (r: JavaRow) => (r.oracle === "affected" || r.openjdk === "affected" ? 0 : r.oracle === "unknown" || r.openjdk === "unknown" || r.oracle === "lineNotListed" ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || `${a.namespace}/${a.workload}`.localeCompare(`${b.namespace}/${b.workload}`));
}

export function exposureCounts(rows: JavaRow[]) {
  return {
    total: rows.length,
    oracle: rows.filter((r) => r.oracle === "affected").length,
    openjdk: rows.filter((r) => r.openjdk === "affected").length,
    noVersion: rows.filter((r) => !r.version).length,
    versions: [...new Set(rows.map((r) => r.version).filter((v): v is string => !!v))].sort(),
  };
}

/** "21:00 UTC" style countdown pieces: hours and minutes until (negative = past) */
export function untilParts(iso: string, now: Date): { past: boolean; h: number; m: number } {
  const d = Date.parse(iso) - now.getTime();
  const abs = Math.abs(d);
  return { past: d < 0, h: Math.floor(abs / 3_600_000), m: Math.floor((abs % 3_600_000) / 60_000) };
}

// Sample data for the VNet traffic page — anonymous callers only (signed-in users get live data or a state).
// Public addresses are from the documentation ranges (RFC 5737); labels are invented.
import type { NetCoverageResponse, NetDir, NetFlowsResponse, NetMapEdge, NetSection, NetTalkerDim } from "@aud/types";
import { binMinutes, snapRange } from "./networkQueries.js";

export function mockNetFlows(section: NetSection, dim: NetTalkerDim, dir: NetDir, rangeMin: number): NetFlowsResponse {
  const range = snapRange(rangeMin);
  const bin = binMinutes(range);
  const base: NetFlowsResponse = {
    generatedAt: new Date().toISOString(), source: "mock", section, state: "ok", lookbackMinutes: range, binMinutes: bin, gaps: [],
  };
  if (section === "map") {
    const last = new Date(Date.now() - 20 * 60_000).toISOString();
    const e = (src: string, dst: string, bytes: number, port: number, denied = 0, malicious = 0): NetMapEdge => ({
      src, dst, bytes, allowedFlows: Math.round(bytes / 150_000), deniedFlows: denied, records: Math.max(1, Math.round(bytes / 2_000_000)) + denied, maliciousRecords: malicious, last,
      ports: [{ port, proto: "TCP", bytes, allowedFlows: Math.round(bytes / 150_000), deniedFlows: denied }], deniedPorts: denied ? [port] : [],
    });
    return {
      ...base,
      map: {
        edges: [
          e("@internet", "rg-app/vnet-hub/snet-web", 1_900_000_000, 443, 312, 2),
          e("rg-app/vnet-hub/snet-web", "rg-app/vnet-hub/snet-app", 1_350_000_000, 8080),
          e("rg-app/vnet-hub/snet-app", "rg-app/vnet-hub/snet-data", 2_100_000_000, 5432),
          e("rg-app/vnet-hub/snet-app", "rg-shared/vnet-shared/snet-dns", 92_000_000, 53),
          e("rg-app/vnet-hub/snet-app", "@azure", 640_000_000, 443),
          e("rg-app/vnet-hub/snet-app", "@internet", 120_000_000, 443),
          e("@onprem", "rg-app/vnet-hub/snet-app", 48_000_000, 8443),
          e("@internet", "rg-app/vnet-hub/snet-app", 0, 22, 280),
        ],
        omitted: 0, unplaced: { bytes: 310_000_000, records: 820 },
      },
    };
  }
  if (section === "overview") {
    const points = Math.min(24, Math.floor(range / bin));
    const now = Date.now();
    const series = Array.from({ length: points }, (_, i) => {
      const wave = 1 + 0.45 * Math.sin(i / 2.5);
      return {
        t: new Date(now - (points - i) * bin * 60_000).toISOString(),
        bytes: Math.round(320_000_000 * wave),
        allowedFlows: Math.round(5200 * wave),
        deniedFlows: i % 7 === 3 ? 160 : 12 + (i % 4) * 3,
      };
    });
    const sum = (k: "bytes" | "allowedFlows" | "deniedFlows") => series.reduce((a, s) => a + s[k], 0);
    return {
      ...base,
      overview: {
        totals: { bytes: sum("bytes"), allowedFlows: sum("allowedFlows"), deniedFlows: sum("deniedFlows"), records: points * 410 },
        series,
        byFlowType: [
          { flowType: "IntraVNet", bytes: Math.round(sum("bytes") * 0.62), allowedFlows: Math.round(sum("allowedFlows") * 0.7), deniedFlows: 40, records: points * 260 },
          { flowType: "AzurePublic", bytes: Math.round(sum("bytes") * 0.21), allowedFlows: Math.round(sum("allowedFlows") * 0.15), deniedFlows: 0, records: points * 70 },
          { flowType: "ExternalPublic", bytes: Math.round(sum("bytes") * 0.12), allowedFlows: Math.round(sum("allowedFlows") * 0.1), deniedFlows: Math.round(sum("deniedFlows") * 0.6), records: points * 60 },
          { flowType: "InterVNet", bytes: Math.round(sum("bytes") * 0.05), allowedFlows: Math.round(sum("allowedFlows") * 0.05), deniedFlows: 0, records: points * 18 },
          { flowType: "MaliciousFlow", bytes: 48_000, allowedFlows: 0, deniedFlows: 64, records: 2 },
        ],
      },
    };
  }
  if (section === "talkers") {
    const pairs: Record<Exclude<NetTalkerDim, "port">, [string, string, number][]> = {
      subnet: [["rg-app/vnet-hub/snet-app", "rg-app/vnet-hub/snet-data", 2_100_000_000], ["rg-app/vnet-hub/snet-web", "rg-app/vnet-hub/snet-app", 1_350_000_000], ["rg-app/vnet-hub/snet-app", "rg-shared/vnet-shared/snet-dns", 92_000_000]],
      vm: [["rg-app/vm-app-01", "rg-app/vm-db-01", 1_400_000_000], ["rg-app/vm-web-01", "rg-app/vm-app-01", 980_000_000], ["rg-app/vm-app-02", "rg-app/vm-db-01", 610_000_000]],
      ip: [["10.10.1.12", "10.10.2.31", 1_400_000_000], ["10.10.0.8", "10.10.1.12", 980_000_000], ["10.10.1.14", "10.10.2.31", 610_000_000]],
    };
    if (dim === "port") {
      return {
        ...base,
        talkers: {
          dim, rows: [
            { port: 443, protocol: "TCP", bytes: 2_900_000_000, allowedFlows: 54_000, deniedFlows: 7, publicInAllowed: 1800 },
            { port: 5432, protocol: "TCP", bytes: 1_200_000_000, allowedFlows: 9_100, deniedFlows: 0, publicInAllowed: 0 },
            { port: 53, protocol: "UDP", bytes: 21_000_000, allowedFlows: 7_600, deniedFlows: 0, publicInAllowed: 0 },
            { port: 22, protocol: "TCP", bytes: 3_000_000, allowedFlows: 22, deniedFlows: 280, publicInAllowed: 14 },
          ],
        },
      };
    }
    return { ...base, talkers: { dim, rows: pairs[dim].map(([src, dest, bytes], i) => ({ src, dest, bytes, allowedFlows: Math.round(bytes / 120_000), deniedFlows: i === 1 ? 18 : 0 })) } };
  }
  if (section === "blocked") {
    const last = new Date(Date.now() - 12 * 60_000).toISOString();
    return {
      ...base,
      blocked: [
        { group: "nsg-snet-app", rule: "DefaultRule_DenyAllInBound", direction: "in", port: 22, protocol: "TCP", deniedFlows: 280, records: 96, sources: ["203.0.113.40", "203.0.113.77", "198.51.100.7"], lastSeen: last },
        { group: "nsg-snet-data", rule: "UserRule_deny-app-to-db-3306", direction: "in", port: 3306, protocol: "TCP", deniedFlows: 42, records: 18, sources: ["10.10.1.14"], lastSeen: last },
        { group: "nsg-snet-web", rule: "DefaultRule_DenyAllInBound", direction: "in", port: 3389, protocol: "TCP", deniedFlows: 31, records: 12, sources: ["203.0.113.9"], lastSeen: last },
      ],
    };
  }
  const rows = dir === "in"
    ? [
      { ip: "198.51.100.7", direction: dir, flowTypes: ["MaliciousFlow"], malicious: true, country: "ZZ", threat: "Botnet", targets: ["rg-app/vnet-hub/snet-web"], ports: [22, 443], records: 2, allowedRecords: 0, deniedRecords: 2 },
      { ip: "203.0.113.40", direction: dir, flowTypes: ["ExternalPublic"], malicious: false, country: "ZZ", targets: ["rg-app/vnet-hub/snet-web"], ports: [443], records: 640, allowedRecords: 638, deniedRecords: 2 },
      { ip: "203.0.113.77", direction: dir, flowTypes: ["ExternalPublic"], malicious: false, targets: ["rg-app/vnet-hub/snet-app"], ports: [22], records: 30, allowedRecords: 0, deniedRecords: 30 },
    ]
    : [
      { ip: "203.0.113.120", direction: dir, flowTypes: ["AzurePublic"], malicious: false, targets: ["rg-app/vm-app-01"], ports: [443], records: 410, allowedRecords: 410, deniedRecords: 0 },
      { ip: "203.0.113.200", direction: dir, flowTypes: ["ExternalPublic"], malicious: false, targets: ["rg-app/vm-app-02"], ports: [443, 80], records: 96, allowedRecords: 96, deniedRecords: 0 },
    ];
  return { ...base, internet: { direction: dir, rows } };
}

export function mockNetCoverage(): NetCoverageResponse {
  return {
    generatedAt: new Date().toISOString(),
    source: "mock",
    vnets: [
      { key: "rg-legacy/vnet-legacy", name: "vnet-legacy", region: "koreacentral", kind: "nsgOnly", config: "read", trafficAnalytics: false, intervalMin: null, workspaceMatches: null, retentionDays: null, nsgLegacy: 2, disabledLogs: 0, observed: { rows7d: 0, lastRow: null } },
      { key: "rg-app/vnet-spoke", name: "vnet-spoke", region: "koreacentral", kind: "partial", config: "read", trafficAnalytics: true, intervalMin: 60, workspace: "law-network", workspaceMatches: true, retentionDays: 30, nsgLegacy: 0, disabledLogs: 1, observed: { rows7d: 96_000, lastRow: new Date(Date.now() - 52 * 60_000).toISOString() } },
      { key: "rg-app/vnet-hub", name: "vnet-hub", region: "koreacentral", kind: "vnet", config: "read", trafficAnalytics: true, intervalMin: 10, workspace: "law-network", workspaceMatches: true, retentionDays: 30, nsgLegacy: 1, disabledLogs: 0, observed: { rows7d: 316_000, lastRow: new Date(Date.now() - 14 * 60_000).toISOString() } },
    ],
    unmappedFlowLogs: 0,
    workspace: { state: "ok", lastRow: new Date(Date.now() - 14 * 60_000).toISOString(), rows7d: 412_000, legacyFlowRows7d: 0, read: [{ name: "law-network", via: "connection", rows7d: 412_000 }], unlisted: [] },
    gaps: [],
  };
}

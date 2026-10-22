// What a live card's state rests on — a deterministic evidence ladder for resources Azure gives few health signals
// for (Private Endpoint, public IP, DNS zones, gateways …). Pure; tested from apps/api/test/healthEvidence.test.ts.
//
// `health` stays the risk axis (and the only input to fault impact); `basis` says why a card is ok / unknown:
//   risk (worst wins)  quality rules · an active Azure Monitor alert (Sev0/1 critical, Sev2 warning — Azure's own
//                      verdict, basis "alert") · Resource Health Degraded (warning) / Unavailable (critical) ·
//                      configuration faults — provisioning Failed, a PE connection Rejected / Disconnected — at most
//                      warning (a configuration fact must not start a fault-impact spread)
//   positive (first)   quality rules passed → metric · Resource Health Available → resourceHealth (ok) ·
//                      traffic both ways in the window → observed (health stays unknown: "inferred normal", not ok) ·
//                      provisioned (and, for a PE, approved) with nothing observed → configured (idle / no series /
//                      one way) · Azure defines no state (NSG, an unused public IP) → notApplicable · else none
// Learn: Resource Health states https://learn.microsoft.com/azure/service-health/resource-health-overview ·
// "Only private endpoints in an approved state can be used to send traffic" https://learn.microsoft.com/azure/private-link/private-endpoint-overview ·
// zeros vs NULLs are the provider's choice https://learn.microsoft.com/azure/azure-monitor/metrics/metrics-aggregation-explained
import type { AlertSeverity, HealthStatus, LiveNode } from "@aud/types";
import type { RhState } from "./resourceHealthCollector.js";

export type Evidence = { health: HealthStatus; basis: NonNullable<LiveNode["basis"]>; reasons: string[] };

export type EvidenceInput = {
  kind: string;
  /** From the quality rules (resolveNodeHealth) */
  health: HealthStatus;
  /** Did a quality rule have data? (resolveNodeHealth returned a verdict, not "unknown") */
  judged: boolean;
  metrics: Record<string, number | null>;
  provisioningState?: string;
  /** Private Endpoint: approval state of each connection */
  peConnections?: string[];
  rh?: RhState;
  /** Public IP attached to nothing */
  unused?: boolean;
  /** Severities of the resource's active (Fired, not Closed) Azure Monitor alerts */
  alerts?: AlertSeverity[];
};

/** Two directions of traffic per kind; one key = a single activity count (DNS queries) */
const TRAFFIC: Record<string, readonly string[]> = {
  privateEndpoint: ["bytesIn", "bytesOut"],
  publicIP: ["bytesIn", "bytesOut"],
  dns: ["queries"],
};

/** Kinds whose provisioning state is shown as "configured" when no quality metric judged them — network plumbing and
 *  gateways; compute and data services keep "unknown" (their own metrics or power state speak for them) */
const CONFIG_ONLY = new Set(["nic", "vnetGateway", "bastion", "paas", "agc", "natGateway", "lb", "appGateway", "firewall", "frontDoor", "trafficManager"]);

const rank = (h: HealthStatus) => (h === "critical" ? 3 : h === "warning" ? 2 : h === "ok" ? 1 : 0);
const worst = (a: HealthStatus, b: HealthStatus) => (rank(b) > rank(a) && b !== "ok" ? b : a);

export function resolveEvidence(i: EvidenceInput): Evidence {
  const reasons: string[] = [];
  let risk: HealthStatus = i.judged && (i.health === "warning" || i.health === "critical") ? i.health : "unknown";
  let riskBasis: Evidence["basis"] = "metric";

  const prov = (i.provisioningState ?? "").toLowerCase();
  if (prov === "failed") { risk = worst(risk, "warning"); reasons.push("ld.ev.provisionFailed"); if (!i.judged) riskBasis = "configured"; }
  const pe = (i.peConnections ?? []).map((s) => s.toLowerCase());
  if (pe.includes("rejected")) { risk = worst(risk, "warning"); reasons.push("ld.ev.peRejected"); if (!i.judged) riskBasis = "configured"; }
  if (pe.includes("disconnected")) { risk = worst(risk, "warning"); reasons.push("ld.ev.peDisconnected"); if (!i.judged) riskBasis = "configured"; }
  if (pe.includes("pending")) reasons.push("ld.ev.pePending");
  // An active alert is Azure's verdict on this resource now — it outranks a metric bucket that already looks fine
  // (a rule over a 5-minute window stays Fired for minutes after the latest minute reads 0)
  const alertRisk: HealthStatus = (i.alerts ?? []).includes("critical") ? "critical" : (i.alerts ?? []).includes("warning") ? "warning" : "unknown";
  if (alertRisk !== "unknown") {
    if (rank(alertRisk) > rank(risk) || risk === "unknown") { risk = alertRisk; riskBasis = "alert"; }
    reasons.push("ld.ev.alertFired");
  }
  if (i.rh === "Unavailable") { risk = worst(risk, "critical"); reasons.push("ld.ev.rhUnavailable"); riskBasis = "resourceHealth"; }
  if (i.rh === "Degraded") { risk = worst(risk, "warning"); reasons.push("ld.ev.rhDegraded"); if (riskBasis !== "resourceHealth" && riskBasis !== "alert" && !i.judged) riskBasis = "resourceHealth"; }
  if (risk === "warning" || risk === "critical") return { health: risk, basis: riskBasis, reasons };

  if (i.judged && i.health === "ok") return { health: "ok", basis: "metric", reasons };
  if (i.rh === "Available") return { health: "ok", basis: "resourceHealth", reasons: [...reasons, "ld.ev.rhAvailable"] };
  if (i.rh === "Unknown") reasons.push("ld.ev.rhUnknown");

  if (i.kind === "nsg" || (i.kind === "publicIP" && i.unused)) return { health: "unknown", basis: "notApplicable", reasons: [...reasons, "ld.ev.notApplicable"] };

  const keys = TRAFFIC[i.kind];
  if (keys) {
    const vals = keys.map((k) => i.metrics[k] ?? null);
    const seen = vals.filter((v) => v != null && v > 0).length;
    if (seen === keys.length) return { health: "unknown", basis: "observed", reasons: [...reasons, keys.length > 1 ? "ld.ev.twoWay" : "ld.ev.activity"] };
    const approved = i.kind !== "privateEndpoint" || (pe.length > 0 && pe.every((s) => s === "approved"));
    if ((prov === "succeeded" || prov === "") && approved && (prov === "succeeded" || pe.length > 0)) {
      const why = seen > 0 ? "ld.ev.oneWay" : vals.every((v) => v == null) ? "ld.ev.noSeries" : "ld.ev.idle";
      return { health: "unknown", basis: "configured", reasons: [...reasons, why] };
    }
  } else if (prov === "succeeded" && !i.judged && CONFIG_ONLY.has(i.kind)) {
    return { health: i.health, basis: "configured", reasons: [...reasons, "ld.ev.provisioned"] };
  }
  if (pe.includes("pending")) return { health: "unknown", basis: "configured", reasons };
  return { health: i.health, basis: i.judged ? "metric" : "none", reasons };
}

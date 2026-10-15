// Card / mini-map / panel status — pure (tested in apps/api/test/liveCard.test.ts).
import type { HealthStatus, PowerState } from "@aud/types";
import { rgba } from "./palette";

/** Tone of the status for the UI kit Badge (detail panel) */
export type StatusTone = "high" | "medium" | "info" | "success" | "neutral";

export type CardStatus = {
  /** i18n key of the short status text (card pill, panel badge) */
  key: string;
  glyph: "■" | "▲" | "◐" | "●" | "○";
  /** Colour of the card's status strip and pill (and the mini-map) */
  color: string;
  tone: StatusTone;
};

/**
 * The one status a resource shows — card strip and pill, mini-map and detail panel all use it.
 * First matching row wins. "Running" with no metric verdict is grey, not green: a power state is not
 * evidence of health. Nothing is assumed: no data → "상태 미확인".
 */
export function cardStatus(health: HealthStatus, powerState?: PowerState, impact?: "source" | "affected"): CardStatus {
  if (impact === "source") return { key: "ld.status.faultSource", glyph: "■", color: rgba("danger"), tone: "high" };
  if (health === "critical") return { key: "ld.status.critical", glyph: "■", color: rgba("danger"), tone: "high" };
  if (impact === "affected") return { key: "ld.status.affected", glyph: "▲", color: rgba("warning"), tone: "medium" };
  if (powerState === "stopped") return { key: "ld.power.stopped", glyph: "▲", color: rgba("warning"), tone: "medium" };
  if (health === "warning") return { key: "ld.status.warning", glyph: "▲", color: rgba("warning"), tone: "medium" };
  if (powerState === "starting") return { key: "ld.power.starting", glyph: "◐", color: rgba("accent"), tone: "info" };
  if (powerState === "stopping") return { key: "ld.power.stopping", glyph: "◐", color: rgba("warning"), tone: "medium" };
  if (health === "ok") return { key: "ld.status.ok", glyph: "●", color: rgba("ok"), tone: "success" };
  if (powerState === "running") return { key: "ld.power.running", glyph: "●", color: rgba("ink", 0.35), tone: "neutral" };
  if (powerState === "deallocated") return { key: "ld.power.deallocated", glyph: "○", color: rgba("ink", 0.18), tone: "neutral" };
  return { key: "ld.status.unknown", glyph: "○", color: rgba("ink", 0.18), tone: "neutral" };
}

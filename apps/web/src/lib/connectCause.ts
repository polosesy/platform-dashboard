// Why an in-cluster connection (Loki · Hubble UI) was not made → what the page says and whether the network-policy
// rule belongs under it. The API reads the socket error's code (apps/api/src/infra/connectCause.ts — measured from the
// dashboard pod on stg 2026-11-18). Only a connect timeout can be a policy; a refusal is "no ready pod" (Loki restarting
// — 11-18 that read "check the network policy"), a DNS failure is a wrong or missing name.
import type { ConnectCause } from "@aud/types";

export type CauseView = {
  /** i18n key of the one-line title (takes {target}) */
  title: string;
  /** i18n key of the explanation (takes {target}) */
  hint: string;
  /** the network-policy allow rule is the likely fix — shown only then */
  showRule: boolean;
};

const VIEWS: Record<ConnectCause, CauseView> = {
  dns: { title: "net.cause.dns.title", hint: "net.cause.dns.hint", showRule: false },
  refused: { title: "net.cause.refused.title", hint: "net.cause.refused.hint", showRule: false },
  timeout: { title: "net.cause.timeout.title", hint: "net.cause.timeout.hint", showRule: true },
  noRoute: { title: "net.cause.noRoute.title", hint: "net.cause.noRoute.hint", showRule: false },
};
/** An answer without a cause (an older API, or an error that carried no code): connection-stage, cause not known */
const UNKNOWN: CauseView = { title: "net.cause.unknown.title", hint: "net.cause.unknown.hint", showRule: true };

/** Pure: "unreachable" + its cause → the words; null for any other state (the page keeps its own words for those) */
export function causeView(state: string, cause?: ConnectCause | null): CauseView | null {
  if (state !== "unreachable") return null;
  return cause ? VIEWS[cause] : UNKNOWN;
}

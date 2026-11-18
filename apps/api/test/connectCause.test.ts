import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { connectCauseOf } from "../src/infra/connectCause.js";
import { lokiStateOf } from "../src/services/lokiLogs.js";
import * as ccNs from "../../web/src/lib/connectCause.ts";

const { causeView } = ((ccNs as unknown as { default?: typeof ccNs }).default ?? ccNs) as typeof ccNs;

// Real fetch failures where they can be made locally; the connect timeout in the shape measured from the dashboard pod
// on stg (2026-11-18): TypeError "fetch failed" → cause ConnectTimeoutError { code: "UND_ERR_CONNECT_TIMEOUT" }.
const fetchError = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch (e) { return e; } throw new Error(`${url} answered`); };
const closedPort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const connectTimeout = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error (attempted address: 10.0.0.9:3100, timeout: 10000ms)"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" }) });

test("connect cause: a refused connection (a Service with no ready pod) is 'refused', not a policy", async () => {
  const e = await fetchError(`http://127.0.0.1:${await closedPort()}/ready`);
  assert.equal(connectCauseOf(e), "refused");
  assert.deepEqual(lokiStateOf(e), { state: "unreachable", message: lokiStateOf(e).message, cause: "refused" });
});

test("connect cause: a name that does not resolve is 'dns'", async () => {
  const e = await fetchError("http://no-such-svc.aud-test.invalid:3100/ready"); // .invalid never resolves (RFC 2606)
  assert.equal(connectCauseOf(e), "dns");
  assert.equal(lokiStateOf(e).cause, "dns");
});

test("connect cause: a connect timeout (policy drop · port the Service lacks) is 'timeout'; the codes, never the text", () => {
  assert.equal(connectCauseOf(connectTimeout), "timeout");
  assert.deepEqual({ ...lokiStateOf(connectTimeout), message: "" }, { state: "unreachable", message: "", cause: "timeout" });
  for (const code of ["EHOSTUNREACH", "ENETUNREACH"]) assert.equal(connectCauseOf({ cause: { code } }), "noRoute");
  assert.equal(connectCauseOf({ cause: { code: "EAI_AGAIN" } }), "dns", "a DNS server that did not answer");
  // happy eyeballs: one error per address under an AggregateError
  assert.equal(connectCauseOf({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] } }), "refused");
  assert.equal(connectCauseOf(new Error("ECONNREFUSED in a message only")), null, "the text is not read");
});

test("connect cause: a read that broke after connecting has no connect cause (busy / unreachable stay as before)", () => {
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(connectCauseOf(reset), null);
  assert.deepEqual(lokiStateOf(reset, true), { state: "busy", message: "fetch failed" }, "Loki answers /ready → busy");
  assert.equal(lokiStateOf(reset, false).cause, undefined, "no cause to say");
  assert.equal(lokiStateOf(Object.assign(new Error("Loki 503: too many"), {})).state, "busy");
});

test("the page: only a connect timeout (or an unknown cause) gets the network-policy rule", () => {
  assert.equal(causeView("busy", "timeout"), null, "other states keep their own words");
  assert.equal(causeView("unreachable", "refused")!.showRule, false, "a restarting Loki is not a policy (2026-11-18)");
  assert.equal(causeView("unreachable", "dns")!.showRule, false);
  assert.equal(causeView("unreachable", "noRoute")!.showRule, false);
  assert.equal(causeView("unreachable", "timeout")!.showRule, true);
  assert.equal(causeView("unreachable", undefined)!.showRule, true, "an older API without causes: as before");
  assert.equal(causeView("unreachable", "refused")!.title, "net.cause.refused.title");
});

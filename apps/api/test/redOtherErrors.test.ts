// 2026-11-19 (RED · "an ERROR log of a workflow service is not in the error count"): measured on stg — the request
// was answered HTTP 424 (Spring caught the async failure: exception=none, outcome=CLIENT_ERROR), so its server span's
// status stayed UNSET (OpenTelemetry HTTP server rule: 4xx is not an error), and the failure itself was only logged by
// an executor thread (no span had status ERROR — 0 of 245 spans in the trace). RED counts ERROR server spans: 0.
// Second finding: Micrometer creates a counter at its first event, so every 4xx / 5xx series of the service sat at 1
// since it appeared and increase() read all of them as 0 (6 h: 4xx 0 · 5xx 0 → counted from the raw samples 5 · 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { counterIncrease, durationMinutes } from "../src/services/promScope.js";
import { otherErrorQueries, otherErrorsOf } from "../src/services/workloadRed.js";
import { sloQueries } from "../src/services/workloadSlo.js";
import * as rNs from "../../web/src/lib/redView.ts";

const R = ((rNs as unknown as { default?: typeof rNs }).default ?? rNs) as typeof rNs;

test("counterIncrease: increase() for series present at the start, + the first value of series created inside the window", () => {
  assert.deepEqual(["5m", "6h", "3d", "4320m", "x", "1w"].map(durationMinutes), [5, 360, 4320, 4320, null, null]);
  const s = 'c{a="b"}';
  assert.equal(counterIncrease(s, "60m"), '((increase(c{a="b"}[60m]) + (min_over_time(c{a="b"}[60m]) unless c{a="b"} offset 60m)) or increase(c{a="b"}[60m]) or (min_over_time(c{a="b"}[60m]) unless c{a="b"} offset 60m))');
  // an offset window: the presence check is at its start (offset + range)
  assert.match(counterIncrease(s, "3d", " offset 3d"), /increase\(c\{a="b"\}\[3d\] offset 3d\)/);
  assert.match(counterIncrease(s, "3d", " offset 3d"), /unless c\{a="b"\} offset 8640m/);
  assert.throws(() => counterIncrease(s, "1w"), /unsupported/);
  // the SLO counts use it (a service's only 5xx was never counted)
  const q = sloQueries('cluster="aks-a"', 'cluster="aks-a"', 30, ["1.0"]);
  assert.ok(q["n:5m"]!.includes("min_over_time(") && q["n:5m"]!.includes("unless"));
  assert.ok(Object.entries(q).filter(([k]) => k.startsWith("n:") || k.startsWith("g:")).every(([, v]) => v.includes("unless")));
});

test("RED other sources: HTTP 4xx / 5xx and log ERROR per application — measured 0 ≠ not instrumented (null)", () => {
  const q = otherErrorQueries('cluster="aks-a"', 'cluster="aks-a"', 60);
  assert.deepEqual(Object.keys(q).sort(), ["httpApps", "httpErrors", "logApps", "logErrors"]);
  assert.match(q.httpErrors!, /outcome=~"\(\?i\)client_error\|server_error"/);
  assert.match(q.httpErrors!, /uri!~"\(\?i\)\.\*actuator\.\*"/);
  assert.match(q.logErrors!, /log4j2_events_total.*logback_events_total/s);
  assert.deepEqual(Object.keys(otherErrorQueries(null, 'cluster="aks-a"', 60)).sort(), ["logApps", "logErrors"], "no HTTP series in the cluster → not asked");
  // the workspace answers label values in lower case
  const raw = {
    httpApps: [{ metric: { application: "flow-service" }, value: 1 }, { metric: { application: "quiet-service" }, value: 1 }],
    httpErrors: [{ metric: { application: "flow-service", outcome: "client_error" }, value: 5 }, { metric: { application: "flow-service", outcome: "server_error" }, value: 1 }],
    logApps: [{ metric: { application: "flow-service" }, value: 1 }],
    logErrors: [{ metric: { application: "flow-service" }, value: 8.02 }],
  };
  const m = otherErrorsOf(raw, { http: true, log: true });
  assert.deepEqual(m.get("flow-service"), { http4xx: 5, http5xx: 1, logErrors: 8.02 });
  assert.deepEqual(m.get("quiet-service"), { http4xx: 0, http5xx: 0, logErrors: null }, "HTTP measured 0; no log metric = null, not 0");
  assert.equal(m.get("other"), undefined);
  const notRead = otherErrorsOf(raw, { http: false, log: true });
  assert.deepEqual(notRead.get("flow-service"), { http4xx: null, http5xx: null, logErrors: 8.02 }, "a source not read says nothing");
});

test("RED view: the other sources line, ▲ only when they saw errors and the server spans saw none", () => {
  assert.deepEqual(R.otherErrorParts({ http4xx: 4, http5xx: 0, logErrors: 6.1 }).parts.map((p) => [p.key, p.n]), [["ob.red.other4xx", 4], ["ob.red.other5xx", 0], ["ob.red.otherLog", 6.1]]);
  assert.equal(R.otherErrorParts({ http4xx: null, http5xx: null, logErrors: null }).measured, false);
  assert.equal(R.otherErrorParts(undefined).measured, false);
  assert.equal(R.errorsElsewhere({ errors: 0, other: { http4xx: 1, http5xx: 0, logErrors: null } }), true);
  assert.equal(R.errorsElsewhere({ errors: 3.1, other: { http4xx: 1, http5xx: 0, logErrors: 8 } }), false, "RED already shows errors");
  assert.equal(R.errorsElsewhere({ errors: 0, other: { http4xx: 0, http5xx: 0, logErrors: 0.4 } }), false, "an increase() fraction is not an event");
});

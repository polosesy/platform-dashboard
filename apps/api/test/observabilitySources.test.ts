import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { StackComponent } from "@aud/types";
import { pipelineOf, sourceStates } from "../src/services/observabilitySources.js";
import * as ds from "../../web/src/lib/dataSources.ts";

const { sourceChips } = ((ds as { default?: typeof ds }).default ?? ds) as typeof ds;
const GRAFANA = { endpoint: "https://demo-abcd.krc.grafana.azure.com", datasources: { loki: "loki-uid", tempo: "tempo-uid" } };
const comp = (kind: StackComponent["kind"], checks: Array<[string, number | null]> = []): StackComponent => ({
  kind, name: kind, namespace: "monitor", state: "ok", pods: [],
  checks: checks.map(([id, value]) => ({ id: id as StackComponent["checks"][number]["id"], state: "ok", value, unit: "perSecond", promql: "" })),
});
const STACK = { metricsState: "ok" as const, components: [comp("alloy", [["logsSent", 120], ["spansAccepted", 0]]), comp("tempo")] };

test("Loki: read only after a good /ready; blocked on refusal/timeout; error carries the HTTP status only", () => {
  const base = { grafana: GRAFANA, stack: STACK };
  assert.equal(sourceStates({ ...base, lokiConfigured: true, probe: { state: "ok" } })[0]!.state, "read");
  assert.equal(sourceStates({ ...base, lokiConfigured: true, probe: { state: "unreachable" } })[0]!.state, "blocked");
  const err = sourceStates({ ...base, lokiConfigured: true, probe: { state: "failed", status: 503 } })[0]!;
  assert.deepEqual([err.state, err.detail], ["error", "HTTP 503"]);
  assert.equal(sourceStates({ ...base, lokiConfigured: false, probe: null })[0]!.state, "link", "no in-cluster config, a Grafana UID → link only");
  assert.equal(sourceStates({ grafana: null, stack: null, lokiConfigured: false, probe: null })[0]!.state, "off");
});

test("Tempo / Pyroscope / Grafana are never 'read'; links stay on *.grafana.azure.com", () => {
  for (const probe of [{ state: "ok" as const }, null]) {
    const s = sourceStates({ grafana: GRAFANA, stack: STACK, lokiConfigured: true, probe });
    for (const x of s.filter((x) => x.kind !== "loki")) assert.notEqual(x.state, "read", x.kind);
    for (const x of s) if (x.href) assert.equal(new URL(x.href).hostname.endsWith(".grafana.azure.com"), true);
  }
  const s = sourceStates({ grafana: GRAFANA, stack: STACK, lokiConfigured: false, probe: null });
  assert.deepEqual(s.map((x) => [x.kind, x.state]), [["loki", "link"], ["tempo", "link"], ["pyroscope", "off"], ["grafana", "link"]]);
});

test("pipeline comes from the stack metrics; unknown when the stack view failed", () => {
  assert.equal(pipelineOf("loki", STACK), "seen");
  assert.equal(pipelineOf("tempo", STACK), "seen", "a Tempo component is there");
  assert.equal(pipelineOf("pyroscope", STACK), "notSeen");
  assert.equal(pipelineOf("loki", { metricsState: "forbidden", components: [] }), null);
  assert.equal(pipelineOf("loki", null), null);
});

test("chips: Prometheus and Container Insights always; unset sources fold into one chip", () => {
  const sources = sourceStates({ grafana: GRAFANA, stack: STACK, lokiConfigured: true, probe: { state: "unreachable" } });
  const { shown, folded } = sourceChips({ prometheus: true, containerInsights: false, appInsights: false }, sources);
  assert.deepEqual(shown.map((c) => [c.kind, c.state]), [["prometheus", "read"], ["containerInsights", "notRead"], ["loki", "blocked"], ["tempo", "link"], ["grafana", "link"]]);
  assert.deepEqual(folded.map((c) => c.kind), ["pyroscope", "appInsights"]);
  // shipping seen keeps an unset source visible (so the user learns it exists)
  const seen = sourceChips(null, [{ kind: "pyroscope", state: "off", pipeline: "seen" }]);
  assert.deepEqual(seen.shown.map((c) => c.kind), ["pyroscope"]);
});

test("every chip state and role has ko/en text", () => {
  const src = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const keys = [
    ...["read", "link", "blocked", "error", "off", "notRead"].map((s) => `ob.ds.state.${s}`),
    ...["prometheus", "containerInsights", "appInsights", "loki", "tempo", "pyroscope", "grafana"].map((k) => `ob.ds.role.${k}`),
    "ob.ds.pipeline.seen", "ob.ds.pipeline.notSeen",
  ];
  for (const k of keys) assert.match(src, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
});

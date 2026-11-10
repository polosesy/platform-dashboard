// Live diagram restore (web lib/liveRestore): after an API restart the remembered generated diagram is gone (404) and
// "generate" answers the same id. A new generate must be a new load (no old 404 read as its answer), and a gone diagram
// is generated again for its subscription — once. 2026-11-11 stg: generate 201 · spec 200 six times, page stayed empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ns from "../../web/src/lib/liveRestore.ts";

const R = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
const SUB = "00000000-0000-0000-0000-000000000000";

test("last diagram: the bare id older pages stored still reads; id + subscription round-trips; junk is nothing", () => {
  assert.deepEqual(R.parseLastDiagram("auto-00000000"), { id: "auto-00000000" });
  assert.deepEqual(R.parseLastDiagram(R.serializeLastDiagram({ id: "auto-00000000", subscriptionId: SUB })), { id: "auto-00000000", subscriptionId: SUB });
  assert.deepEqual(R.parseLastDiagram(R.serializeLastDiagram({ id: "prod-infra" })), { id: "prod-infra" });
  for (const bad of [null, undefined, "", "  ", "{", "{\"id\":3}", "{\"x\":1}"]) assert.equal(R.parseLastDiagram(bad), null, String(bad));
});

test("a gone generated diagram is generated again for its subscription — once; never the example, never without a subscription", () => {
  const last = { id: "auto-00000000", subscriptionId: SUB };
  assert.equal(R.onMissingDiagram(last, "auto-00000000", false), "regenerate");
  assert.equal(R.onMissingDiagram(last, "auto-00000000", true), "empty", "only once per visit");
  assert.equal(R.onMissingDiagram({ id: "auto-00000000" }, "auto-00000000", false), "empty", "no subscription remembered (older page)");
  assert.equal(R.onMissingDiagram({ id: "prod-infra", subscriptionId: SUB }, "prod-infra", false), "empty", "not a generated diagram");
  assert.equal(R.onMissingDiagram(last, "auto-11111111", false), "empty", "a different diagram went missing");
  assert.equal(R.onMissingDiagram(null, "auto-00000000", false), "empty");
});

test("each generate is a new load: same id, new rev → a new query key (the earlier 404 is not this load's answer)", () => {
  assert.equal(R.diagramLoadKey("", 3), null);
  assert.notEqual(R.diagramLoadKey("auto-00000000", 0), R.diagramLoadKey("auto-00000000", 1));
  assert.equal(R.diagramLoadKey("auto-00000000", 2), R.diagramLoadKey("auto-00000000", 2));
});

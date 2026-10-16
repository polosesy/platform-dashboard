// Resource Health coverage: inventory types vs the types with a status vs Microsoft's supported list — pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksFor, classifyCoverage } from "../src/services/healthCoverage.js";
import { RH_CHECKS, RH_SUPPORTED_TYPES } from "../src/services/rhSupportedTypes.js";
import { RH_SUPPORTED } from "../src/services/resourceHealthCollector.js";

test("types without a status are split by Microsoft's list; a status for an unlisted type is noted, not counted as missing", () => {
  const inventory = [
    { type: "Microsoft.Network/networkInterfaces", count: 92 },
    { type: "microsoft.compute/virtualmachines", count: 46 },
    { type: "microsoft.web/sites", count: 2 },
    { type: "microsoft.insights/metricalerts", count: 53 },
  ];
  const status = new Set(["microsoft.compute/virtualmachines", "microsoft.insights/metricalerts"]);
  const c = classifyCoverage(inventory, status);
  assert.deepEqual(c.types, [
    { type: "microsoft.web/sites", count: 2, bucket: "noStatusListed" },
    { type: "microsoft.network/networkinterfaces", count: 92, bucket: "noStatusUnlisted" },
    { type: "microsoft.insights/metricalerts", count: 53, bucket: "statusUnlisted" },
  ]);
  assert.equal(c.inventoryResources, 193);
  assert.equal(c.noStatusResources, 94, "statusUnlisted is not 'no status'");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(JSON.stringify(c)), "no ids");
});

test("the supported-list snapshot covers the live diagram's list and every type with executed checks", () => {
  for (const t of RH_SUPPORTED) assert.ok(RH_SUPPORTED_TYPES.has(t), t);
  for (const t of Object.keys(RH_CHECKS)) assert.ok(RH_SUPPORTED_TYPES.has(t), t);
  for (const [t, c] of Object.entries(RH_CHECKS)) assert.equal(c.en.length, c.ko.length, t);
  assert.ok(!RH_SUPPORTED_TYPES.has("microsoft.network/networkinterfaces"));
  assert.deepEqual(checksFor(["microsoft.network/loadbalancers", "microsoft.insights/metricalerts"], "ko"), { "microsoft.network/loadbalancers": ["부하 분산 엔드포인트를 사용할 수 있나요?"] });
  assert.equal(checksFor(["microsoft.network/loadbalancers"], "en")["microsoft.network/loadbalancers"]![0], "Are the load balancing endpoints available?");
});

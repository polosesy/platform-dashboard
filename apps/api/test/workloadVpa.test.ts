import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuantity, vpaForWorkload } from "../src/services/workloadVpa.js";

// Shapes as an AKS cluster returns them (2026-10-27: 26 VPAs, all updateMode Off) — names are placeholders
const Mi = 1024 * 1024;

test("quantities: millicores, binary and decimal suffixes, plain bytes, exponent; nonsense is null", () => {
  assert.equal(parseQuantity("25m"), 0.025);
  assert.equal(parseQuantity("1"), 1);
  assert.equal(parseQuantity("1200Mi"), 1200 * Mi);
  assert.equal(parseQuantity("1238659775"), 1238659775);
  assert.equal(parseQuantity("1G"), 1e9);
  assert.equal(parseQuantity("1e3"), 1000);
  assert.equal(parseQuantity("12Xi"), null);
  assert.equal(parseQuantity(undefined), null);
});

const vpa = (name: string, target: string, mode: string, rec: Record<string, { cpu: string; memory: string }> | null) => ({
  metadata: { name, namespace: "app" },
  spec: { targetRef: { apiVersion: "apps/v1", kind: "Deployment", name: target }, updatePolicy: { updateMode: mode } },
  status: rec ? {
    recommendation: { containerRecommendations: [{ containerName: "web", target: rec.target, lowerBound: rec.lower, upperBound: rec.upper, uncappedTarget: rec.target }] },
    conditions: [{ type: "RecommendationProvided", status: "True" }],
  } : { conditions: [{ type: "RecommendationProvided", status: "False" }] },
});

test("VPA beside the template: only VPA's own semantics are noted (target > limit, request outside lower–upper)", () => {
  const vpas = [
    vpa("web-vpa", "web", "Off", { target: { cpu: "25m", memory: "256Mi" }, lower: { cpu: "25m", memory: "256Mi" }, upper: { cpu: "25m", memory: "256Mi" } }),
    vpa("other-vpa", "other", "Auto", null),
  ];
  const containers = [{ name: "web", resources: { requests: { cpu: "50m", memory: "200Mi" }, limits: { memory: "200Mi" } } }, { name: "sidecar" }];
  const [v] = vpaForWorkload(vpas, { namespace: "app", kind: "Deployment", name: "web" }, containers);
  assert.ok(v);
  assert.deepEqual([v.name, v.mode, v.recommending, v.containers.length], ["web-vpa", "Off", true, 2]);
  const web = v.containers[0]!;
  assert.deepEqual([web.request, web.limit, web.target], [{ cpu: 0.05, memory: 200 * Mi }, { cpu: null, memory: 200 * Mi }, { cpu: 0.025, memory: 256 * Mi }]);
  assert.deepEqual(web.notes, [
    { resource: "memory", kind: "targetOverLimit" }, { resource: "memory", kind: "belowLower" }, { resource: "cpu", kind: "aboveUpper" },
  ], "no CPU limit → no target-over-limit note for CPU");
  assert.deepEqual([v.containers[1]!.target, v.containers[1]!.notes], [null, []], "a container VPA has no recommendation for");
  assert.deepEqual(vpaForWorkload(vpas, { namespace: "app", kind: "StatefulSet", name: "web" }, containers), [], "kind must match");
  assert.deepEqual(vpaForWorkload(vpas, { namespace: "other", kind: "Deployment", name: "web" }, containers), [], "namespace must match");
  const [o] = vpaForWorkload(vpas, { namespace: "app", kind: "Deployment", name: "other" }, [{ name: "web" }]);
  assert.deepEqual([o!.mode, o!.recommending, o!.containers[0]!.target], ["Auto", false, null]);
});

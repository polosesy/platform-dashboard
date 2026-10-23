import { test } from "node:test";
import assert from "node:assert/strict";
import * as k8s from "@kubernetes/client-node";
import { k8sFailureReason, retryableK8sError, withK8sRetry } from "../src/infra/k8sRetry.js";
import { tokenKubeConfig } from "../src/services/aksAccess.js";

test("one retry for transient failures only: network blips and 429/5xx, never 403/404", async () => {
  let n = 0;
  const flaky = () => (++n === 1 ? Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })) : Promise.resolve("ok"));
  assert.equal(await withK8sRetry(flaky, 1), "ok");
  assert.equal(n, 2);

  let calls = 0;
  await assert.rejects(withK8sRetry(() => { calls++; return Promise.reject(Object.assign(new Error("Forbidden"), { code: 403 })); }, 1), /Forbidden/);
  assert.equal(calls, 1, "403 is an answer, not a blip");

  calls = 0;
  await assert.rejects(withK8sRetry(() => { calls++; return Promise.reject(new Error("Invalid response body while trying to fetch https://x/api/v1/services: Premature close")); }, 1));
  assert.equal(calls, 2, "exactly one retry, then the failure is reported");

  assert.ok(retryableK8sError(Object.assign(new Error("x"), { code: 503 })));
  assert.ok(!retryableK8sError(Object.assign(new Error("x"), { code: 404 })));
  assert.equal(k8sFailureReason(new Error("socket hang up")), "network");
  assert.equal(k8sFailureReason(Object.assign(new Error("x"), { code: 403 })), "HTTP 403");
});

test("Kubernetes clients never use a keep-alive agent (node-fetch 2 false 'Premature close' on reused sockets)", async () => {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: "https://api.example.test", caData: Buffer.from("ca").toString("base64"), skipTLSVerify: false }],
    users: [{ name: "u", token: "t" }], contexts: [{ name: "x", cluster: "c", user: "u" }], currentContext: "x",
  });
  const opts: { agent?: unknown } = {};
  await tokenKubeConfig(kc, "token").applyToHTTPSOptions(opts as never);
  assert.notEqual((opts.agent as { keepAlive?: boolean } | undefined)?.keepAlive, true);
});

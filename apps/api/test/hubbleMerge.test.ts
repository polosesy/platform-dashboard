import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubbleFlow } from "@aud/types";
import { dedupeObservations, mergeAgentBatches, type AgentBatch } from "../src/services/hubbleMerge.js";
import { parseHubbleJsonOutput } from "../src/services/hubbleClient.js";

const ep = (namespace: string, podName: string) => ({ namespace, podName, labels: {}, identity: 1000, workloadName: podName });

function flow(time: string, over: Partial<HubbleFlow> = {}): HubbleFlow {
  return {
    time,
    source: ep("app", "web-1"),
    destination: ep("obs", "alloy-1"),
    verdict: "FORWARDED",
    type: "L3_L4",
    l4Protocol: "TCP",
    sourcePort: 56530,
    destinationPort: 4318,
    trafficDirection: "EGRESS",
    dropReasonDesc: "",
    isReply: false,
    nodeName: "node-a",
    summary: "",
    sourceIp: "10.0.0.5",
    destinationIp: "10.0.1.9",
    tcpFlags: "ACK,PSH",
    ...over,
  };
}

const batch = (nodeName: string, flows: HubbleFlow[], truncated = false, error?: string): AgentBatch => ({
  nodeName,
  podName: `cilium-${nodeName}`,
  flows,
  truncated,
  ...(error ? { error } : {}),
});

test("same packet at TO_STACK/TO_ENDPOINT and on the receiving node collapses to one", () => {
  const out = dedupeObservations([
    flow("2026-10-08T08:58:18.364Z"),
    flow("2026-10-08T08:58:18.364Z", { trafficDirection: "EGRESS" }),
    flow("2026-10-08T08:58:18.371Z", { nodeName: "node-b", trafficDirection: "INGRESS" }),
  ]);
  assert.equal(out.length, 1);
});

test("pre- and post-SNAT copies of a pod's egress packet collapse", () => {
  const out = dedupeObservations([
    flow("2026-10-08T09:00:00.000Z", { sourceIp: "192.168.0.41", destinationIp: "20.200.245.7", destination: ep("", ""), destinationPort: 443 }),
    // after SNAT: node IP, no namespace / pod name, same security identity
    flow("2026-10-08T09:00:00.001Z", { sourceIp: "10.224.0.5", source: ep("", ""), destinationIp: "20.200.245.7", destination: ep("", ""), destinationPort: 443 }),
  ]);
  assert.equal(out.length, 1);
});

test("reserved identities are told apart by IP, not merged", () => {
  const world = () => ({ ...ep("", ""), identity: 2, workloadName: "world" });
  const out = dedupeObservations([
    flow("2026-10-08T09:00:00.000Z", { source: world(), sourceIp: "20.41.67.112", sourcePort: 443 }),
    flow("2026-10-08T09:00:00.001Z", { source: world(), sourceIp: "52.1.2.3", sourcePort: 443 }),
  ]);
  assert.equal(out.length, 2);
});

test("parser fills namespace of a post-SNAT copy from identity labels", () => {
  const line = JSON.stringify({
    flow: {
      time: "2026-10-08T09:16:48.012Z",
      IP: { source: "10.224.0.5", destination: "20.194.59.86" },
      l4: { TCP: { source_port: 33000, destination_port: 5432, flags: { ACK: true, FIN: true } } },
      source: { identity: 24145, labels: ["k8s:app=cloud-domain-webapp", "k8s:io.kubernetes.pod.namespace=cloud-domain"] },
      destination: { identity: 2, labels: ["reserved:world"] },
      Type: "L3_L4",
    },
  });
  const [f] = parseHubbleJsonOutput(line);
  assert.equal(f!.source.namespace, "cloud-domain");
  assert.equal(f!.source.workloadName, "cloud-domain-webapp");
});

test("periodic packets on one connection are kept, reply is separate", () => {
  const out = dedupeObservations([
    flow("2026-10-08T08:58:18.364Z"),
    flow("2026-10-08T08:58:23.365Z"),
    flow("2026-10-08T08:58:18.364Z", { isReply: true, tcpFlags: "ACK" }),
  ]);
  assert.equal(out.length, 3);
  // newest first
  assert.equal(out[0]!.time, "2026-10-08T08:58:23.365Z");
});

test("a burst is not chained away — only copies within the window of the kept event drop", () => {
  const out = dedupeObservations([
    flow("2026-10-08T08:00:00.000Z"),
    flow("2026-10-08T08:00:00.040Z"), // copy
    flow("2026-10-08T08:00:00.080Z"), // 80ms after kept one → new packet
  ]);
  assert.equal(out.length, 2);
});

test("different TCP flags or verdicts are different events", () => {
  const out = dedupeObservations([
    flow("2026-10-08T08:00:00.000Z", { tcpFlags: "SYN" }),
    flow("2026-10-08T08:00:00.001Z", { tcpFlags: "ACK" }),
    flow("2026-10-08T08:00:00.001Z", { tcpFlags: "ACK", verdict: "DROPPED" }),
  ]);
  assert.equal(out.length, 3);
});

test("merge reports every node and the window all nodes cover", () => {
  const set = mergeAgentBatches(
    [
      // busy node: wrapped buffer, only 1 minute of history
      batch("node-a", [flow("2026-10-08T09:00:00Z"), flow("2026-10-08T08:59:00Z", { sourcePort: 1 })], true),
      // quiet node: wrapped too but goes back 3 minutes
      batch("node-b", [flow("2026-10-08T09:00:10Z", { sourcePort: 2 }), flow("2026-10-08T08:57:00Z", { sourcePort: 3 })], true),
      // idle node: buffer not full, complete history
      batch("node-c", [flow("2026-10-08T08:30:00Z", { sourcePort: 4 })], false),
    ],
    3,
    10_000,
  );
  const c = set.coverage;
  assert.equal(c.nodesObserved, 3);
  assert.equal(c.nodesTotal, 3);
  assert.equal(set.flows.length, 5);
  assert.equal(c.newest, "2026-10-08T09:00:10.000Z");
  // latest cut-off among wrapped buffers is node-a's 08:59:00
  assert.equal(c.commonSince, "2026-10-08T08:59:00.000Z");
  assert.equal(c.commonWindowMinutes, 1.2);
  assert.deepEqual(c.nodes.map((n) => [n.nodeName, n.events, n.bufferFull]), [
    ["node-a", 2, true],
    ["node-b", 2, true],
    ["node-c", 1, false],
  ]);
});

test("failed node counts as unobserved and does not shorten the window", () => {
  const set = mergeAgentBatches(
    [
      batch("node-a", [flow("2026-10-08T09:00:00Z"), flow("2026-10-08T08:58:00Z", { sourcePort: 1 })], false),
      batch("node-b", [], false, "exitCode=1, stderr=connection refused"),
    ],
    3, // one agent pod is not Running at all
    10_000,
  );
  assert.equal(set.coverage.nodesObserved, 1);
  assert.equal(set.coverage.nodesTotal, 3);
  assert.equal(set.coverage.nodes[1]!.error, "exitCode=1, stderr=connection refused");
  assert.equal(set.coverage.commonWindowMinutes, 2);
});

test("limit keeps the newest events and shortens the reported window", () => {
  const set = mergeAgentBatches(
    [batch("node-a", [
      flow("2026-10-08T09:00:00Z", { sourcePort: 1 }),
      flow("2026-10-08T08:59:00Z", { sourcePort: 2 }),
      flow("2026-10-08T08:50:00Z", { sourcePort: 3 }),
    ])],
    1,
    2,
  );
  assert.deepEqual(set.flows.map((f) => f.sourcePort), [1, 2]);
  assert.equal(set.coverage.commonSince, "2026-10-08T08:59:00.000Z");
  assert.equal(set.coverage.commonWindowMinutes, 1);
  assert.equal(set.coverage.rawEvents, 3);
});

test("duplicates across nodes are counted", () => {
  const set = mergeAgentBatches(
    [
      batch("node-a", [flow("2026-10-08T09:00:00.000Z")]),
      batch("node-b", [flow("2026-10-08T09:00:00.004Z", { nodeName: "node-b" })]),
    ],
    2,
    10_000,
  );
  assert.equal(set.flows.length, 1);
  assert.equal(set.coverage.duplicatesRemoved, 1);
});

test("parser reads IPs and TCP flags used for de-duplication", () => {
  const line = JSON.stringify({
    flow: {
      time: "2026-10-08T08:58:18.364Z",
      verdict: "FORWARDED",
      IP: { source: "10.244.1.5", destination: "10.244.2.9" },
      l4: { TCP: { source_port: 56530, destination_port: 4318, flags: { PSH: true, ACK: true } } },
      source: { namespace: "app", pod_name: "web-1", labels: [] },
      destination: { namespace: "obs", pod_name: "alloy-1", labels: [] },
      Type: "L3_L4",
      node_name: "node-a",
      traffic_direction: "EGRESS",
      is_reply: false,
    },
  });
  const [f] = parseHubbleJsonOutput(`${line}\n`);
  assert.equal(f!.sourceIp, "10.244.1.5");
  assert.equal(f!.destinationIp, "10.244.2.9");
  assert.equal(f!.tcpFlags, "ACK,PSH");
  assert.equal(f!.destinationPort, 4318);
});

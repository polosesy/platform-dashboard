import { test } from "node:test";
import assert from "node:assert/strict";
import { armTypeOf, describeChange, liveSpecOf, operationState, resolveLifecycle, type ChangeRow } from "../src/services/lifecycle.js";
import { parsePowerState, summarizeVmssInstances, type LiveRead } from "../src/services/metricsCollector.js";
// Pure web module (no React) — the web package is CommonJS-typed, so read the namespace
import * as lcNs from "../../web/src/lib/liveLifecycle.ts";

const W = ((lcNs as unknown as { default?: typeof lcNs }).default ?? lcNs) as typeof lcNs;
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers";
const PG = `${SUB}/Microsoft.DBforPostgreSQL/flexibleServers/pg1`;
const VMSS = `${SUB}/Microsoft.Compute/virtualMachineScaleSets/was1`;
const NOW = Date.parse("2026-10-21T10:00:00Z");
const read = (r: Partial<LiveRead>): LiveRead => ({ power: "unknown", asOf: "2026-10-21T10:00:00.000Z", ...r });

test("power: an operation word is not a power state (a scaling Redis is not stopping, an updating server not starting)", () => {
  assert.equal(parsePowerState("Updating"), "unknown");
  assert.equal(parsePowerState("Scaling"), "unknown");
  assert.equal(parsePowerState("Ready"), "running");
  assert.equal(parsePowerState("PowerState/deallocated"), "deallocated");
  assert.equal(parsePowerState("Resuming"), "starting");
});

test("scale set instances: counted as ARM lists them (Deleting not counted), by provisioning state and power", () => {
  const vm = (prov: string, power: string) => ({ properties: { provisioningState: prov, instanceView: { statuses: [{ code: `ProvisioningState/${prov.toLowerCase()}` }, { code: `PowerState/${power}` }] } } });
  const s = summarizeVmssInstances([vm("Succeeded", "running"), vm("Creating", "starting"), vm("Deleting", "stopping")]);
  assert.equal(s.actual, 2);
  assert.deepEqual(s.byProvisioning, { Succeeded: 1, Creating: 1, Deleting: 1 });
  assert.deepEqual(summarizeVmssInstances([]), { actual: 0, byProvisioning: {}, byPower: {} });
});

test("state: PostgreSQL's own word, scale set actual ≠ target = scaling, Succeeded = nothing in progress", () => {
  assert.deepEqual(operationState("postgres", read({ state: "Updating", provisioningState: "Succeeded" })), { state: "updating", raw: "Updating" });
  assert.equal(operationState("postgres", read({ state: "Ready", provisioningState: "Succeeded" })), null);
  const scaling = read({ provisioningState: "Succeeded", sku: { capacity: 2 }, instances: { actual: 1, byProvisioning: { Succeeded: 1 }, byPower: { running: 1 } } });
  assert.equal(operationState("vmss", scaling)?.state, "scaling");
  assert.equal(operationState("redis", read({ provisioningState: "Scaling" }))?.state, "scaling");
  assert.equal(operationState("aks", read({ provisioningState: "Upgrading" }))?.state, "updating", "AKS words are free strings: in progress, raw word kept");
  assert.equal(operationState("aks", read({ provisioningState: "Upgrading" }))?.raw, "Upgrading");
  assert.equal(operationState("vm", read({ provisioningState: "Failed" }))?.state, "failed");
  assert.equal(operationState("sql", read({ state: "Scaling" }))?.state, "scaling");
});

const change = (at: string, byType: string, changes: ChangeRow["changes"]): ChangeRow => ({ rid: PG.toLowerCase(), at, changeType: "Update", byType, changes });

test("cause: only from a record — user / app / platform change, planned maintenance, otherwise unknown", () => {
  const updating = read({ state: "Updating" });
  const userChange = change("2026-10-21T09:58:00.000Z", "User", { "sku.name": { previousValue: "Standard_D2ds_v5", newValue: "Standard_D4ds_v5" }, "properties.tags.x": { previousValue: "a", newValue: "b" } });
  const byUser = resolveLifecycle({ kind: "postgres", read: updating, changes: [userChange], now: NOW })!;
  assert.equal(byUser.state, "updating");
  assert.equal(byUser.cause, "user");
  assert.deepEqual(byUser.change?.items[0], { path: "sku.name", from: "Standard_D2ds_v5", to: "Standard_D4ds_v5" }, "size first, before → after");
  assert.equal(byUser.change?.count, 2);
  assert.equal(resolveLifecycle({ kind: "postgres", read: updating, changes: [change("2026-10-21T09:58:00.000Z", "Application", {})], now: NOW })!.cause, "app");
  assert.equal(resolveLifecycle({ kind: "postgres", read: updating, changes: [change("2026-10-21T09:58:00.000Z", "System", {})], now: NOW })!.cause, "platform", "System = a platform change, not 'maintenance'");
  assert.equal(resolveLifecycle({ kind: "postgres", read: updating, maintenance: true, now: NOW })!.cause, "maintenance");
  assert.equal(resolveLifecycle({ kind: "postgres", read: updating, now: NOW })!.cause, "unknown", "Updating alone names no cause");
  // A change older than the recent window does not explain what runs now
  assert.equal(resolveLifecycle({ kind: "postgres", read: updating, changes: [change("2026-10-21T06:00:00.000Z", "User", {})], now: NOW })!.cause, "unknown");
  // Nothing running, nothing changed → nothing to show; a recent change → "ready" with the change
  assert.equal(resolveLifecycle({ kind: "postgres", read: read({ state: "Ready" }), now: NOW }), undefined);
  assert.equal(resolveLifecycle({ kind: "postgres", read: read({ state: "Ready" }), changes: [userChange], now: NOW })?.state, "ready");
});

test("change record: newest first, key paths first, at most four items", () => {
  const c = describeChange([
    change("2026-10-21T08:00:00.000Z", "User", { "a": { previousValue: 1, newValue: 2 } }),
    change("2026-10-21T09:00:00.000Z", "Unspecified", { "properties.a": { newValue: "x" }, "properties.b": { newValue: "y" }, "properties.c": { newValue: "z" }, "properties.d": { newValue: "w" }, "sku.capacity": { previousValue: 1, newValue: 2 } }),
  ])!;
  assert.equal(c.at, "2026-10-21T09:00:00.000Z");
  assert.equal(c.by, "unknown");
  assert.deepEqual(c.items[0], { path: "sku.capacity", from: "1", to: "2" });
  assert.equal(c.items.length, 4);
  assert.equal(c.count, 5);
});

test("live spec: rebuilt from the body read now; a scale set's instances are the actual count, the target beside it", () => {
  assert.equal(armTypeOf(VMSS), "microsoft.compute/virtualmachinescalesets");
  const r = read({ sku: { name: "Standard_D2ds_v5", capacity: 3 }, row: { sku: { name: "Standard_D2ds_v5", capacity: 3 }, properties: { orchestrationMode: "Uniform" } },
    instances: { actual: 2, byProvisioning: { Succeeded: 1, Creating: 1 }, byPower: { running: 2 } } });
  const s = liveSpecOf(VMSS, r)!;
  assert.equal(s.facts.find((f) => f.k === "instances")?.v, 2, "actual, not sku.capacity");
  assert.equal(s.facts.find((f) => f.k === "size")?.v, "Standard_D2ds_v5");
  assert.equal(s.instancesTarget, 3);
  assert.deepEqual(s.instanceStates, { Creating: 1 });
  assert.equal(liveSpecOf(VMSS, read({})), undefined, "nothing read → the stored spec stays");
});

test("web: one neutral chip, the stored spec replaced by live values, the instance count chip", () => {
  assert.deepEqual(W.lifecycleChip({ state: "updating", cause: "user", asOf: "" }), { stateKey: "ld.lc.state.updating", causeKey: "ld.lc.causeShort.user", tone: "info" });
  assert.equal(W.lifecycleChip(undefined), null);
  assert.equal(W.lifecycleChip({ state: "ready", asOf: "" }), null);
  assert.equal(W.lifecycleChip({ state: "ready", change: { at: "", by: "user", items: [], count: 0 }, asOf: "" })?.stateKey, "ld.lc.recent");
  assert.equal(W.lifecycleChip({ state: "failed", asOf: "" })?.tone, "warn");
  const merged = W.mergeSpecFacts([{ k: "size", v: "Standard_D2ds_v5" }, { k: "instances", v: 1 }], { facts: [{ k: "instances", v: 2 }], asOf: "" });
  assert.deepEqual(merged, [{ k: "size", v: "Standard_D2ds_v5" }, { k: "instances", v: 2, live: true }]);
  assert.deepEqual(W.mergeSpecFacts([{ k: "instances", v: 1 }], undefined), [{ k: "instances", v: 1 }]);
  assert.deepEqual(W.instancesOf({ facts: [{ k: "instances", v: 2 }], instancesTarget: 3, asOf: "" }), { n: 2, target: 3 });
  assert.equal(W.instancesOf(undefined), null);
});

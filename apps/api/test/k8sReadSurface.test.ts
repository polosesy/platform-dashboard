// The Kubernetes role customers bind = what the code can call. Scans every @kubernetes/client-node call in src/,
// checks the generated manifests in docs/integrations/azure/templates/aks/ are current and never grant secrets,
// configmaps, exec or proxies (except the separate Hubble opt-in file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED_MANIFESTS,
  HUBBLE_EXEC_RULES,
  K8S_READ_SURFACE,
  NEVER_GRANTED,
  POD_LOG_RULE,
  readerManifest,
} from "../src/services/k8sReadSurface.js";

const SRC = join(import.meta.dirname, "../src");
const TEMPLATES = join(import.meta.dirname, "../../../docs/integrations/azure/templates/aks");

function k8sFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const text = readFileSync(p, "utf8");
        if (text.includes("@kubernetes/client-node")) out.push({ path: p, text });
      }
    }
  };
  walk(SRC);
  return out;
}

test("every Kubernetes API call in src/ is on the read surface (or the per-namespace pod-log grant)", () => {
  const allowed = new Set([...K8S_READ_SURFACE, POD_LOG_RULE].flatMap((r) => r.methods));
  const custom = new Set(K8S_READ_SURFACE.filter((r) => r.custom).map((r) => `${r.apiGroup}/${r.resource}`));
  const calls: string[] = [];
  for (const { path, text } of k8sFiles()) {
    for (const m of text.matchAll(/\.((?:list|read|create|patch|replace|delete|connect)[A-Z]\w*)\(/g)) {
      const method = m[1]!;
      if (/CustomObject/.test(method)) continue;
      calls.push(method);
      assert.ok(allowed.has(method), `${path}: ${method} is not in k8sReadSurface.ts`);
    }
    for (const m of text.matchAll(/(\w+CustomObject)\(\{\s*group:\s*"([^"]+)"[^}]*plural:\s*"([^"]+)"/g)) {
      assert.match(m[1]!, /^list/, `${path}: custom objects are only listed`);
      assert.ok(custom.has(`${m[2]}/${m[3]}`), `${path}: ${m[2]}/${m[3]} is not in k8sReadSurface.ts`);
    }
  }
  assert.ok(calls.length > 20, "the scan found the collectors' calls");
});

test("exec exists only in hubbleClient.ts, behind assertHubbleExecAllowed on every entry point", () => {
  for (const { path, text } of k8sFiles()) {
    const exec = /new k8s\.(Exec|Attach|PortForward)\(/.test(text);
    if (path.endsWith("hubbleClient.ts")) {
      assert.ok(exec);
      assert.equal((text.match(/assertHubbleExecAllowed\(env, azureResourceId\)/g) ?? []).length, 2, "flows and status are both gated");
    } else {
      assert.ok(!exec, `${path} opens exec / attach / port-forward`);
    }
  }
});

test("the reader role is list-only and never names secrets, configmaps, exec or proxies", () => {
  for (const r of K8S_READ_SURFACE) {
    assert.deepEqual(r.verbs, ["list"], r.resource);
    assert.ok(!NEVER_GRANTED.includes(r.resource), r.resource);
  }
  const rules = readerManifest().split("rules:\n")[1]!.split("---")[0]!;
  const granted = [...rules.matchAll(/resources: \[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(", "));
  assert.ok(granted.length === K8S_READ_SURFACE.length, "every surface resource is in the role");
  for (const bad of NEVER_GRANTED) assert.ok(!granted.includes(bad), bad);
  assert.ok(!rules.includes("*"), "no wildcard");
  assert.deepEqual(POD_LOG_RULE.verbs, ["get"]);
  assert.ok(HUBBLE_EXEC_RULES.every((r) => NEVER_GRANTED.includes(r.resource)), "the Hubble opt-in is exactly the never-granted exec/proxy pair");
});

test("generated manifests in docs/integrations/azure/templates/aks are current", () => {
  for (const [file, gen] of Object.entries(GENERATED_MANIFESTS)) {
    let onDisk = "";
    try { onDisk = readFileSync(join(TEMPLATES, file), "utf8").replace(/\r\n/g, "\n"); } catch { /* missing */ }
    assert.equal(onDisk, gen(), `${file} is stale — regenerate: npx tsx apps/api/scripts/gen-aks-rbac.ts`);
  }
});

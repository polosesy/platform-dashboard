// 앱 런타임 — the image's own configuration from the registry (2026-11-12: AcrPull granted on stg; 24 of 36 registry
// images state their runtime and exact version there, 30 of 36 run pinned by digest).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acrRef, factsOfImageConfig, readImageConfig } from "../src/services/imageConfig.js";
import * as ar from "../src/services/appRuntimes.js";

const D = (c: string) => "sha256:" + c.repeat(64);

test("image config: the runtime and version the image states — only the known variables are read", () => {
  const f = factsOfImageConfig({
    created: "2026-11-01T00:00:00Z",
    config: {
      Env: ["PATH=/usr/bin", "JAVA_HOME=/opt/java/openjdk", "JAVA_VERSION=jdk-21.0.12+7", "DB_PASSWORD=never-read", "SPRING_PROFILES_ACTIVE=stg"],
      Entrypoint: ["/__cacert_entrypoint.sh"], Cmd: ["java", "-jar", "/app.jar"],
      Labels: { "org.opencontainers.image.source": "https://example.com/team/app", "org.opencontainers.image.revision": "abc1234", other: "x" },
    },
  });
  assert.deepEqual(f.runtimes, [{ kind: "jvm", evidence: "image env: JAVA_VERSION", version: "21.0.12" }]);
  assert.equal(f.source, "https://example.com/team/app");
  assert.equal(f.revision, "abc1234");
  assert.ok(!JSON.stringify(f).includes("never-read") && !JSON.stringify(f).includes("SPRING"), "no other variable leaves");
  assert.deepEqual(factsOfImageConfig({ config: { Entrypoint: ["node", "server.js"] } }).runtimes, [{ kind: "nodejs", evidence: "entrypoint: node" }]);
  assert.deepEqual(factsOfImageConfig({ config: { Entrypoint: ["/app/server"], Cmd: ["java"] } }).runtimes, [], "Cmd after an Entrypoint is only arguments");
  assert.deepEqual(factsOfImageConfig({ config: { Env: ["NODE_VERSION=24.22.1"], Entrypoint: ["docker-entrypoint.sh"] } }).runtimes, [{ kind: "nodejs", evidence: "image env: NODE_VERSION", version: "24.22.1" }]);
  assert.deepEqual(factsOfImageConfig({}).runtimes, []);
  assert.equal(factsOfImageConfig({ config: { Labels: { "org.opencontainers.image.source": "https://user:pw@example.com/x" } } }).source, undefined, "a URL with credentials is dropped");
});

test("image config: only Azure Container Registry references; a digest-pinned pod's repository comes from imageID", () => {
  assert.deepEqual(acrRef("myreg1.azurecr.io/team/app:1.2", `myreg1.azurecr.io/team/app@${D("a")}`), { host: "myreg1.azurecr.io", repo: "team/app", ref: D("a") });
  assert.deepEqual(acrRef(D("b"), `myreg1.azurecr.io/team/app@${D("b")}`), { host: "myreg1.azurecr.io", repo: "team/app", ref: D("b") }, "status image = bare sha256 (stg: 30 of 36)");
  assert.deepEqual(acrRef("myreg1.azurecr.io/team/app:1.2"), { host: "myreg1.azurecr.io", repo: "team/app", ref: "1.2" });
  assert.equal(acrRef("mcr.microsoft.com/oss/x:1"), null);
  assert.equal(acrRef("evil.example/azurecr.io/x:1"), null);
  assert.equal(acrRef("myreg1.azurecr.io.evil.example/x:1"), null);
  assert.equal(acrRef(D("c"), D("c")), null, "no repository anywhere = not asked");
});

test("image config: manifest index → linux/amd64 → config blob; a redirect only to Azure, without the token", async () => {
  const seen: Array<{ url: string; auth: boolean }> = [];
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 307 ? null : JSON.stringify(body), { status, headers });
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, auth: !!(init?.headers as Record<string, string> | undefined)?.authorization });
    if (u.endsWith("/manifests/1.0")) return res(200, { manifests: [{ digest: D("1"), platform: { os: "linux", architecture: "arm64" } }, { digest: D("2"), platform: { os: "linux", architecture: "amd64" } }] });
    if (u.endsWith(`/manifests/${D("2")}`)) return res(200, { config: { digest: D("3") } });
    if (u.endsWith(`/blobs/${D("3")}`)) return res(307, null, { location: "https://myreg1.koreacentral.data.azurecr.io/blob?sig=x" });
    if (u.startsWith("https://myreg1.koreacentral.data.azurecr.io/")) return res(200, { config: { Env: ["PYTHON_VERSION=3.12.4"] } });
    return res(404, {});
  }) as typeof fetch;
  const f = await readImageConfig(fake, { host: "myreg1.azurecr.io", repo: "team/app", ref: "1.0" }, "tok");
  assert.deepEqual(f.runtimes, [{ kind: "python", evidence: "image env: PYTHON_VERSION", version: "3.12.4" }]);
  assert.deepEqual(seen.map((s) => s.auth), [true, true, true, false], "the pre-signed data endpoint gets no Authorization");
  const evil = (async (url: string | URL | Request) => (String(url).includes("/manifests/") ? res(200, { config: { digest: D("3") } }) : res(307, null, { location: "https://evil.example/x" }))) as typeof fetch;
  await assert.rejects(readImageConfig(evil, { host: "myreg1.azurecr.io", repo: "team/app", ref: "1.0" }, "tok"), /redirect outside Azure/);
});

test("app runtimes: the image config names a kind, and gives the version to a kind the metrics named without one", () => {
  const row = (metric: Record<string, string>, value = 1) => ({ metric, value });
  const id = `myreg1.azurecr.io/shop/api@${D("a")}`;
  const raw = {
    podOwners: [row({ namespace: "shop", pod: "api-0", owner_kind: "StatefulSet", owner_name: "api" }), row({ namespace: "shop", pod: "web-0", owner_kind: "StatefulSet", owner_name: "web" })],
    rsOwners: [],
    "detect:jvm": [row({ namespace: "shop", pod: "api-0" })],
    images: [row({ namespace: "shop", pod: "api-0", image: D("a"), image_id: id }), row({ namespace: "shop", pod: "web-0", image: "myreg1.azurecr.io/shop/web:2", image_id: `myreg1.azurecr.io/shop/web@${D("b")}` })],
  };
  const configs = new Map([
    [ar.imageKey(D("a"), id), { runtimes: [{ kind: "jvm" as const, evidence: "image env: JAVA_VERSION", version: "21.0.12" }] }],
    [ar.imageKey("myreg1.azurecr.io/shop/web:2", `myreg1.azurecr.io/shop/web@${D("b")}`), { runtimes: [{ kind: "nodejs" as const, evidence: "image env: NODE_VERSION", version: "24.22.1" }] }],
  ]);
  const by = Object.fromEntries(ar.aggregateApps(raw, new Set(), { configs }).workloads.map((w) => [w.workload, w]));
  assert.deepEqual(by.api!.kinds, [{ kind: "jvm", basis: "metrics", version: "21.0.12" }], "measured kind keeps its basis, gains the version");
  assert.deepEqual(by.web!.kinds, [{ kind: "nodejs", basis: "config", evidence: "image env: NODE_VERSION", version: "24.22.1" }]);
});

test("image config: opt-in per connection, ACR hosts only, registry FQDNs behind the chart flag", () => {
  const src = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  assert.match(src("apps/api/src/services/imageConfig.ts"), /if \(!conn\.connection\.aks\?\.imageConfig\) return empty\("off"\)/);
  assert.match(src("apps/api/src/infra/connectionRegistry.ts"), /imageConfig: z\.boolean\(\)\.optional\(\)/);
  assert.match(src("deploy/helm/aud-dashboard/templates/networkpolicy.yaml"), /if \.Values\.features\.imageConfig[\s\S]*\*\.azurecr\.io/);
  assert.match(src("deploy/helm/aud-dashboard/values.yaml"), /\n  imageConfig: false/);
});

test("image config state on screen: a badge only when something could not be read; the guide lists every source", async () => {
  const ns = await import("../../web/src/lib/workloadBlocks.ts");
  const wb = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;
  const ev = (state: "ok" | "off" | "forbidden" | "unreachable" | "failed" | "none", read = 0, pending = 0) =>
    ({ spec: "ok" as const, scan: "empty" as const, imageConfig: { state, read, pending } });
  assert.equal(wb.imageConfigBadge(ev("ok", 36, 0)), null);
  assert.equal(wb.imageConfigBadge(ev("off")), null, "not chosen is not a problem");
  assert.equal(wb.imageConfigBadge(ev("none")), null);
  assert.deepEqual(wb.imageConfigBadge(ev("forbidden")), { key: "ob.bl.cfgBadge.forbidden", hint: "ob.bl.ev.cfg.forbidden", tone: "medium" });
  assert.equal(wb.imageConfigBadge(ev("ok", 30, 6))?.key, "ob.bl.cfgBadge.pending");
  assert.deepEqual(wb.evidenceLines(ev("unreachable")).map((l) => [l.key, l.level]), [
    ["ob.bl.ev.spec.ok", "ok"], ["ob.bl.ev.scan.empty", "info"], ["ob.bl.ev.cfg.unreachable", "warn"],
  ]);
  assert.equal(wb.evidenceLines(ev("ok", 30, 6))[2]!.key, "ob.bl.ev.cfg.okPending");
  assert.deepEqual(wb.evidenceLines(undefined), []);
});

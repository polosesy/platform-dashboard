import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Minimum patched runtime / framework versions — raise them when a new security release lands:
// Node.js 24.x: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases (Brotli decoder RCE CVE-2026-111497,
// TLS hostname bypasses, dns NUL truncation …) → v24.22.1. Next.js 16.4.2 fixes request smuggling in rewrites
// (the web proxies /api through rewrites).
const MIN_NODE_24 = [24, 22, 1];
const MIN_NEXT = [16, 4, 2];

const ver = (s: string) => s.split(".").map(Number);
const atLeast = (v: number[], min: number[]) => {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  return true;
};

test("Dockerfile base images are at least the patched Node.js 24.x", () => {
  const df = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  const images = [...df.matchAll(/^ARG NODE_(?:BUILD|RUNTIME)_IMAGE=node:(\d+\.\d+\.\d+)/gm)].map((m) => m[1]!);
  assert.equal(images.length, 2);
  for (const v of images) assert.ok(atLeast(ver(v), MIN_NODE_24), `node:${v} is older than ${MIN_NODE_24.join(".")}`);
});

test("Next.js is at least the version that fixes request smuggling in rewrites", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const v = pkg.dependencies.next!.replace(/^[^\d]*/, "");
  assert.ok(atLeast(ver(v), MIN_NEXT), `next ${v} < ${MIN_NEXT.join(".")}`);
});

// Packages that run in the image, with the first fixed version (2026-11-04 — OSV over every package.json in the running
// image): zod < 4.6.6 GHSA-mrhx-c7xc-m3w5 (memory exhaustion on large arrays), @azure/msal-node < 7.1.0
// GHSA-xcx6-jx8p-x3h5 (auth code flow parameters), uuid 8.3.2 GHSA-w5hq-g745-h8pq via the retired @azure/ms-rest-js
// (gone with @azure/arm-resourcegraph 5). Checked in the lockfile — what `npm ci` installs, not the ranges.
const MIN_LOCKED: Record<string, number[]> = { zod: [4, 6, 6], "@azure/msal-node": [7, 1, 0], "@azure/identity": [4, 14, 1] };
const RETIRED = ["@azure/ms-rest-js", "uuid"];

test("locked API runtime packages are at least the fixed versions; retired packages are gone", () => {
  const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string; dev?: boolean }> };
  const prod = Object.entries(lock.packages).filter(([k, v]) => k.includes("node_modules/") && !v.dev);
  const nameOf = (k: string) => k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
  for (const [name, min] of Object.entries(MIN_LOCKED)) {
    const found = prod.filter(([k]) => nameOf(k) === name);
    assert.ok(found.length, `${name} not in the lockfile`);
    for (const [k, v] of found) assert.ok(atLeast(ver(v.version!), min), `${k} ${v.version} < ${min.join(".")}`);
  }
  for (const name of RETIRED) assert.deepEqual(prod.filter(([k]) => nameOf(k) === name).map(([k]) => k), [], `${name} is back in the runtime tree`);
});

test("the runtime is one flattened layer of the cleaned base (scanners read every layer), then drops to 65532", () => {
  const df = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const clean = readFileSync(new URL("../../../deploy/docker/runtime-clean.cjs", import.meta.url), "utf8");
  const base = df.slice(df.indexOf("AS runtime-base"), df.indexOf("AS runtime\n"));
  assert.match(base, /RUN \["node", "\/tmp\/runtime-clean\.cjs"\]/, "the base is cleaned with node (a hardened runtime has no shell)");
  // 2026-11-09: deleting on top of the base left npm's packages in the base layer — Defender still reported them
  const runtime = df.slice(df.indexOf("AS runtime\n") - "FROM scratch ".length);
  assert.match(runtime, /^FROM scratch AS runtime\n/, "the runtime starts empty");
  assert.match(runtime, /COPY --from=runtime-base \/ \//, "…and takes the cleaned file system as one layer");
  assert.match(runtime, /ENV PATH=\$\{RUNTIME_PATH\}/, "the base image's PATH is not inherited — set it");
  for (const p of ["/usr/local/lib/node_modules", "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn"]) assert.ok(clean.includes(`"${p}"`), `${p} is not removed`);
  assert.match(clean, /"dpkg", \["--purge", "apt", "libapt-pkg6\.0"\]/, "apt (and its library) is removed on Debian bases");
  assert.match(clean, /"upgrade"\]/, "Debian security updates are applied before");
  const check = runtime.indexOf("RUN [\"node\"");
  assert.ok(check > 0 && runtime.includes("'/usr/bin/apt-get'"), "the runtime verifies that nothing came back");
  const users = [...runtime.matchAll(/^USER (\S+)/gm)].map((m) => m[1]);
  assert.equal(users.at(-1), "65532:65532", "the image must end as the non-root user");
  assert.ok(runtime.lastIndexOf("USER 65532") > check, "USER 65532 comes after the check");
});

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

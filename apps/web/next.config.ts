import fs from "node:fs";
import path from "node:path";
import { processEnv, type LoadedEnvFiles } from "@next/env";
import type { NextConfig } from "next";

// Next.js reads .env files only from the app directory (apps/web), and its env loader
// caches the first result, so `loadEnvConfig(root)` from here is a no-op. The monorepo
// keeps one .env at the repository root: apply its files directly (existing values —
// shell or apps/web/.env* — win), then hand every NEXT_PUBLIC_* value to `env` so it is
// inlined into the browser bundle (MSAL client ID, tenant, API scope) by Turbopack and webpack.
const rootDir = path.resolve(process.cwd(), "../..");
const mode = process.env.NODE_ENV === "production" ? "production" : "development";
const rootEnvFiles: LoadedEnvFiles = [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"].flatMap((name) => {
  const file = path.join(rootDir, name);
  return fs.existsSync(file) ? [{ path: name, contents: fs.readFileSync(file, "utf8"), env: {} }] : [];
});
processEnv(rootEnvFiles, rootDir, { info: () => {}, error: console.error });

const publicEnv = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith("NEXT_PUBLIC_") && typeof e[1] === "string"),
);

// The API listens on loopback IPv4 (API_BIND_HOST=127.0.0.1); "localhost" may resolve to ::1 first on Node 24,
// so the server-side proxy targets 127.0.0.1 explicitly
const apiUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4000").replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, (_m, scheme: string) => `${scheme}127.0.0.1`);

const nextConfig: NextConfig = {
  env: publicEnv,
  // Container build (Dockerfile sets NEXT_OUTPUT=standalone): a self-contained server with only the traced files.
  // The trace root is the monorepo root so workspace packages (@aud/types) are found
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: rootDir } : {}),
  experimental: {
    // The /api rewrite proxy drops a request after 30 s by default ("ECONNRESET"): generating a live diagram for a
    // large subscription reads the whole topology first, so allow it longer (the API keeps snapshots within 20 s)
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

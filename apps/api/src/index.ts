// ── Global error guards — a dropped socket (ECONNRESET …) never stops the server; in production (container) any
// other uncaught exception exits so the orchestrator restarts a clean process (infra/lifecycle.ts) ──
import { SHUTDOWN, canKillPortHolder, healthBody, onUncaught } from "./infra/lifecycle.js";
process.on("uncaughtException", (err: Error) => {
  if (onUncaught(err, process.env.NODE_ENV) === "exit") {
    console.error("[api] Uncaught exception — exiting:", err);
    process.exit(1);
  }
  console.error("[api] Uncaught exception (server kept running):", err.message);
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[api] Unhandled rejection (server kept running):", reason);
});

import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// Load .env from monorepo root (cwd is apps/api/ in workspace mode). A container has no .env: its env comes from
// compose / the pod spec, and these calls find nothing
const _here = dirname(fileURLToPath(import.meta.url)); // → apps/api/src
dotenvConfig({ path: resolve(_here, "../../../.env") });
dotenvConfig(); // Also try local apps/api/.env if present

import cors from "cors";
import express from "express";
import { loadEnv } from "./env.js";
import { getConnections, platformCredentialKind } from "./infra/connectionRegistry.js";
import { initPlatformAccess } from "./infra/platformAccess.js";
import { createAuthorizeMiddleware } from "./middleware/authorize.js";
import { createAuthMiddleware, verifierFromEnv } from "./auth.js";
import { registerAllRoutes } from "./routes/index.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { setDebugLogging } from "./infra/logger.js";
import { registerNotifyHooks } from "./routes/notify.js";

const env = loadEnv(process.env);
// Fail fast on a bad connections file (schema, duplicate subscriptions, secrets in the file …)
const connections = getConnections(env);
initPlatformAccess(env);
console.log(`[auth] SSO roles (default role: ${env.AUD_DEFAULT_ROLE ?? (env.NODE_ENV === "production" ? "none" : "viewer")}) · Azure connections: ${connections.map((c) => `${c.key}:${c.mode}`).join(", ")} · platform credential: ${platformCredentialKind(env) ?? "none"}`);
setDebugLogging(env.AUD_DEBUG);

const app = express();
app.disable("x-powered-by");
// Liveness / readiness: before CORS and auth, outside /api (the web's /api rewrite never exposes it), no Azure call
app.get("/healthz", (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json(healthBody(env.AUD_VERSION));
});
app.use(requestIdMiddleware);
app.use(express.json({ limit: "1mb" }));
const allowedOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
    // Bearer tokens, no cookies
    credentials: false,
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
  })
);
// 알림 센터 receiver: outside /api (Azure action groups and Grafana carry a shared secret, not an SSO token)
registerNotifyHooks(app, env);
// Every Authorization header is verified before a route runs; no header = anonymous (sample data / 401)
app.use("/api", createAuthMiddleware(verifierFromEnv(env)));
// Platform role + connection access (403 before routes), audit line per signed-in request
app.use("/api", createAuthorizeMiddleware(env));
if (env.AUD_ANONYMOUS_SP) {
  console.warn("[auth] AUD_ANONYMOUS_SP=true — anonymous callers read Azure with the platform credential (local development only)");
  app.use("/api", (req, res, next) => {
    if (req.auth?.kind === "anonymous") res.setHeader("x-aud-principal", "sp-anonymous");
    next();
  });
}

registerAllRoutes(app, env);

// ── Port conflict auto-recovery (Windows zombie process cleanup) ──

function killPortHolder(port: number): boolean {
  try {
    const output = execSync("netstat -ano", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const pids = new Set<string>();
    for (const line of output.split("\n")) {
      // Columns: Proto  LocalAddress  ForeignAddress  State  PID — match the local port exactly (":4000", not ":40001")
      const parts = line.trim().split(/\s+/);
      if (parts[3] !== "LISTENING" || !parts[1]?.endsWith(`:${port}`)) continue;
      const pid = parts[parts.length - 1];
      if (pid && pid !== "0" && /^\d+$/.test(pid) && pid !== String(process.pid)) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      console.log(`[api] Killing zombie PID ${pid} on port ${port}`);
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" }); } catch { /* already dead */ }
    }
    return pids.size > 0;
  } catch {
    return false;
  }
}

const MAX_RETRIES = 2;
let retryCount = 0;

function startServer() {
  const server = app.listen(env.PORT, env.API_BIND_HOST, () => {
    console.log(`API listening on http://${env.API_BIND_HOST}:${env.PORT} (version ${env.AUD_VERSION ?? "dev"})`);
  });

  // SIGTERM (docker stop, pod deletion) / SIGINT: stop accepting, let open requests finish, then close long-lived
  // ones (SSE) — without this, node as PID 1 waits out the whole grace period
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[api] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => server.closeAllConnections(), SHUTDOWN.drainMs).unref();
    setTimeout(() => process.exit(0), SHUTDOWN.hardMs).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  server.on("error", (err: NodeJS.ErrnoException) => {
    // The zombie-killer is a Windows dev convenience only — in a container a busy port is a configuration error
    if (err.code === "EADDRINUSE" && !canKillPortHolder(process.platform, env.NODE_ENV)) {
      console.error(`[api] Port ${env.PORT} on ${env.API_BIND_HOST} is in use — exiting`);
      process.exit(1);
    }
    if (err.code === "EADDRINUSE" && retryCount < MAX_RETRIES) {
      retryCount++;
      console.error(`[api] Port ${env.PORT} in use — auto-killing holder (attempt ${retryCount}/${MAX_RETRIES})`);
      const killed = killPortHolder(env.PORT);
      if (killed) {
        // Wait for port release, then retry
        setTimeout(() => startServer(), 1500);
      } else {
        console.error(`[api] Could not find process on port ${env.PORT}. Exiting.`);
        process.exit(1);
      }
    } else if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${env.PORT} is still in use after ${MAX_RETRIES} retries.`);
      console.error(`   Run: netstat -ano | findstr :${env.PORT}`);
      console.error(`   Then: taskkill /PID <pid> /F\n`);
      process.exit(1);
    } else {
      console.error("Server error:", err);
      process.exit(1);
    }
  });
}

startServer();

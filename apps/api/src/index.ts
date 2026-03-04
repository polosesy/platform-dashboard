import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// Load .env from monorepo root (cwd is apps/api/ in workspace mode)
const _here = dirname(fileURLToPath(import.meta.url)); // → apps/api/src
dotenvConfig({ path: resolve(_here, "../../../.env") });
dotenvConfig(); // Also try local apps/api/.env if present

import cors from "cors";
import express from "express";
import { loadEnv } from "./env";
import { bearerTokenMiddleware } from "./auth";
import { registerAllRoutes } from "./routes/index";

const env = loadEnv(process.env);

const app = express();
app.use(express.json({ limit: "1mb" }));
const allowedOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
    credentials: true,
  })
);
app.use(bearerTokenMiddleware);

registerAllRoutes(app, env);

// ── Port conflict auto-recovery (Windows zombie process cleanup) ──

function killPortHolder(port: number): boolean {
  try {
    const output = execSync("netstat -ano", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const pids = new Set<string>();
    for (const line of output.split("\n")) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
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
  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
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

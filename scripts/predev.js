/**
 * predev.js — Cleanup before `npm run dev`
 *
 * 1. Detect a moved/renamed checkout: stale workspace symlinks and a Turbopack
 *    dev cache that still resolves packages from the old absolute path
 * 2. Remove stale Next.js dev lock file
 * 3. Kill zombie processes holding dev ports (3000, 4000)
 * 4. Wait until ports are actually released
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEB_NEXT_DIR = path.join(ROOT, "apps/web/.next");
const DEV_CACHE_DIR = path.join(WEB_NEXT_DIR, "dev");
const ROOT_MARKER = path.join(WEB_NEXT_DIR, ".project-root");

// 1a. Workspace symlinks (node_modules/@aud/*) must point into this checkout.
//     After moving the repo they still target the old path → `@aud/types` cannot be resolved.
for (const pkg of ["types", "api", "web"]) {
  const link = path.join(ROOT, "node_modules/@aud", pkg);
  let target = null;
  try {
    target = fs.realpathSync(link);
  } catch {
    /* missing or dangling */
  }
  const expected = fs.realpathSync(path.join(ROOT, pkg === "types" ? "packages/types" : `apps/${pkg}`));
  if (target !== expected) {
    console.warn(`[predev] node_modules/@aud/${pkg} does not point to ${expected} — run \`npm install\` to relink workspaces`);
  }
}

// 1b. Turbopack's persistent dev cache stores absolute paths (e.g. where `next` was resolved).
//     If the checkout moved, the cache makes HMR fail with "Next.js package not found" and the
//     browser reloads in an endless loop. Clear it when the recorded root differs.
let recordedRoot = null;
try {
  recordedRoot = fs.readFileSync(ROOT_MARKER, "utf8").trim();
} catch {
  /* first run — no marker yet */
}
if (recordedRoot && recordedRoot.toLowerCase() !== ROOT.toLowerCase() && fs.existsSync(DEV_CACHE_DIR)) {
  console.log(`[predev] Project moved (${recordedRoot} → ${ROOT}) — clearing stale Turbopack dev cache`);
  fs.rmSync(DEV_CACHE_DIR, { recursive: true, force: true });
}
try {
  fs.mkdirSync(WEB_NEXT_DIR, { recursive: true });
  fs.writeFileSync(ROOT_MARKER, ROOT);
} catch {
  /* best effort */
}

// 2. Remove stale Next.js dev lock
try {
  fs.unlinkSync(path.join(DEV_CACHE_DIR, "lock"));
  console.log("[predev] Removed stale Next.js lock file");
} catch {
  // File doesn't exist — fine
}

// 3. Kill zombie processes on dev ports
const WEB_PORT = 3000;
const API_PORT = process.env.PORT || 4000;

function getPortPids(port) {
  try {
    const output = execSync("netstat -ano", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pids = new Set();
    for (const line of output.split("\n")) {
      // Columns: Proto  LocalAddress  ForeignAddress  State  PID — match the local port exactly (":3000", not ":30001")
      const parts = line.trim().split(/\s+/);
      if (parts[3] !== "LISTENING" || !parts[1]?.endsWith(`:${port}`)) continue;
      const pid = parts[parts.length - 1];
      if (pid && pid !== "0" && /^\d+$/.test(pid)) {
        pids.add(pid);
      }
    }
    return pids;
  } catch {
    return new Set();
  }
}

function killPort(port) {
  const pids = getPortPids(port);
  if (pids.size === 0) return false;

  for (const pid of pids) {
    if (pid === String(process.pid) || pid === String(process.ppid)) continue;
    try {
      console.log(`[predev] Killing PID ${pid} on port ${port}`);
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "pipe" });
    } catch { /* already dead */ }
  }
  return true;
}

function waitForPort(port, maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (getPortPids(port).size === 0) return true;
    execSync(`node -e "setTimeout(()=>{},200)"`, { stdio: "pipe" });
  }
  return getPortPids(port).size === 0;
}

for (const port of [API_PORT, WEB_PORT]) {
  if (killPort(port)) {
    waitForPort(port);
    console.log(`[predev] Port ${port} freed`);
  }
}

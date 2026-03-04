/**
 * predev.js — Cleanup before `npm run dev`
 *
 * 1. Remove stale Next.js dev lock file
 * 2. Kill zombie processes holding dev ports (3000, 4000)
 * 3. Wait until ports are actually released
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// 1. Remove stale Next.js dev lock
try {
  fs.unlinkSync(path.join(__dirname, "../apps/web/.next/dev/lock"));
  console.log("[predev] Removed stale Next.js lock file");
} catch {
  // File doesn't exist — fine
}

// 2. Kill zombie processes on dev ports
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
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
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

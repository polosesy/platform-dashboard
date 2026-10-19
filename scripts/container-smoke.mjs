#!/usr/bin/env node
// Container smoke test — run on a host with a Docker engine (the on-prem server, CI). Builds the image (unless
// --no-build), starts the pod topology with docker run (a `pod` namespace holder + api + web sharing it — the same as
// deploy/docker/compose.yaml and the AKS pod), with dummy IDs and no Azure access, then asserts:
//   health / readiness, /healthz not exposed through /api, anonymous sample data, sign-in settings read at run time,
//   the API never published, user 65532, read-only root, no .env / config in the image, a fast SIGTERM stop.
// Cleans up whatever happens.   node scripts/container-smoke.mjs [--image aud-dashboard:smoke] [--no-build] [--port 3300]
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const IMAGE = arg("--image", "aud-dashboard:smoke");
const PORT = arg("--port", "3300");
const P = `aud-smoke-${process.pid}`;
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryDocker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const GUID = (d) => `${d.repeat(8)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(12)}`;
const harden = ["--user", "65532:65532", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:mode=1777,size=64m", "--init"];
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const get = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } };
const execIn = (name, js) => tryDocker("exec", name, "node", "-e", js);

try {
  if (!process.argv.includes("--no-build")) {
    console.log(`building ${IMAGE} …`);
    execFileSync("docker", ["build", "-t", IMAGE, "--build-arg", "AUD_VERSION=smoke", "."], { stdio: "inherit" });
  }
  docker("run", "-d", "--name", `${P}-pod`, ...harden, "-p", `127.0.0.1:${PORT}:3000`, IMAGE, "node", "-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},3.6e6)");
  docker("run", "-d", "--name", `${P}-api`, ...harden, "--network", `container:${P}-pod`,
    "-e", "PORT=4000", "-e", "API_BIND_HOST=127.0.0.1", "-e", `AZURE_AD_TENANT_ID=${GUID("1")}`, "-e", `AZURE_AD_CLIENT_ID=${GUID("2")}`,
    "-e", `AZURE_SUBSCRIPTION_IDS=${GUID("3")}`, "-e", "AZURE_AD_CLIENT_SECRET=not-a-real-secret", "-e", `CORS_ORIGIN=http://localhost:${PORT}`,
    IMAGE, "node", "/app/apps/api/dist/index.js");
  docker("run", "-d", "--name", `${P}-web`, ...harden, "--tmpfs", "/app/web/apps/web/.next/cache:mode=1777,size=64m", "--network", `container:${P}-pod`,
    "-e", "PORT=3000", "-e", "HOSTNAME=0.0.0.0", "-e", `AUD_WEB_TENANT_ID=${GUID("1")}`, "-e", "AUD_WEB_CLIENT_ID=runtime-client-id-check",
    "-e", "AUD_WEB_API_SCOPE=api://aud/Azure.Read.All", IMAGE);

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60 && (await get(`${base}/readyz`)).status !== 200; i++) await wait(1000);
  const rz = await get(`${base}/readyz`);
  check("web /readyz (web + API next to it)", rz.status === 200, rz.text.slice(0, 80));
  check("web /healthz", (await get(`${base}/healthz`)).status === 200);
  const viaProxy = await get(`${base}/api/healthz`);
  check("/healthz is not exposed through the /api proxy", viaProxy.status !== 200, `status ${viaProxy.status}`);
  const sample = await get(`${base}/api/health/summary`);
  check("anonymous /api → sample data", sample.status === 200 && sample.text.includes("signin_required"), `status ${sample.status}`);
  const page = await get(`${base}/`);
  check("sign-in settings read at run time", page.text.includes("runtime-client-id-check"));
  check("API healthy inside the pod", execIn(`${P}-api`, "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))").status === 0);
  const ports = docker("port", `${P}-pod`);
  check("only the web port is published", !/4000/.test(ports), ports.replace(/\s+/g, " "));
  check("runs as 65532", docker("exec", `${P}-web`, "node", "-e", "process.stdout.write(String(process.getuid()))") === "65532");
  check("read-only root filesystem", execIn(`${P}-web`, "require('fs').writeFileSync('/app/x','')").status !== 0);
  check("no .env or config in the image", execIn(`${P}-web`, "const fs=require('fs');process.exit(['/app/.env','/app/config','/app/apps/api/.env'].some(p=>fs.existsSync(p))?1:0)").status === 0);
  const t0 = Date.now();
  docker("stop", "-t", "15", `${P}-api`);
  const stopMs = Date.now() - t0;
  check("API stops on SIGTERM well before the grace period", stopMs < 8000, `${stopMs} ms`);
  for (let i = 0; i < 10 && (await get(`${base}/readyz`)).status === 200; i++) await wait(500);
  check("readiness drops when the API is down", (await get(`${base}/readyz`)).status === 503);
} catch (e) {
  check("smoke run", false, String(e?.stderr ?? e).slice(0, 400));
} finally {
  for (const n of ["web", "api", "pod"]) tryDocker("rm", "-f", `${P}-${n}`);
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exitCode = failed ? 1 : 0;
}

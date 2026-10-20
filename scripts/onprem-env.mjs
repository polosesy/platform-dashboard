#!/usr/bin/env node
// Builds api.env / web.env for the on-prem containers from the workstation's .env — values are written to files
// only, never printed. Run by scripts/onprem.sh env; usable alone:
//   node scripts/onprem-env.mjs <out-dir> [--local-port 3000] [--test]
// Kept out on purpose:
//   NEXT_PUBLIC_*            build-time names — the web reads AUD_WEB_* at run time instead
//   AZURE_PROMETHEUS_ENDPOINT one fixed workspace for every cluster (the container finds each cluster's own)
//   AUD_DEFAULT_ROLE          refused in production (users need app roles) — only with --test (NODE_ENV=development)
//   PORT, API_BIND_HOST, ARGOCD_*, anything else not listed below
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) { console.error("usage: node scripts/onprem-env.mjs <out-dir> [--local-port 3000] [--test]"); process.exit(2); }
const flag = (n) => process.argv.includes(n);
const opt = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const localPort = opt("--local-port", "3000");
const test = flag("--test");

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (!fs.existsSync(envFile)) { console.error("no .env at the repository root"); process.exit(1); }
const env = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}

const API_KEYS = [
  "AZURE_AD_TENANT_ID", "AZURE_AD_CLIENT_ID", "AZURE_AD_CLIENT_SECRET", "AUD_AUTH_AUDIENCES", "AUD_AUTH_SCOPES",
  "AZURE_SUBSCRIPTION_IDS", "AUD_HOME_CONNECTION_MODE",
  "AZURE_LOG_ANALYTICS_WORKSPACE_ID", "AZURE_LOG_ANALYTICS_TABLE",
  "AZURE_LIVE_DIAGRAM_ENABLED", "AZURE_TRAFFIC_ANALYTICS_ENABLED", "AZURE_CONNECTION_MONITOR_ENABLED",
  "AZURE_SECURITY_ENABLED", "AZURE_HEALTH_ENABLED", "AZURE_TRANSLATOR_KEY", "AZURE_TRANSLATOR_REGION",
];
const lines = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

const api = [
  ["NODE_ENV", test ? "development" : "production"],
  ...API_KEYS.map((k) => [k, env[k]]),
  // servicePrincipal connection secrets named by the connections file (AUD_CONN_<KEY>_SECRET)
  ...Object.keys(env).filter((k) => /^AUD_CONN_[A-Z0-9_]+_SECRET$/.test(k)).sort().map((k) => [k, env[k]]),
  ["CORS_ORIGIN", `http://localhost:${localPort}`],
  ["AUD_AUDIT_LOG", "stdout"],
  ...(test && env.AUD_DEFAULT_ROLE ? [["AUD_DEFAULT_ROLE", env.AUD_DEFAULT_ROLE]] : []),
];
const connections = env.AUD_CONNECTIONS_FILE ? path.resolve(root, env.AUD_CONNECTIONS_FILE) : null;
if (connections && fs.existsSync(connections)) api.push(["AUD_CONNECTIONS_FILE", "/etc/aud/connections.json"]);

const web = [
  ["AUD_WEB_TENANT_ID", env.NEXT_PUBLIC_AZURE_AD_TENANT_ID],
  ["AUD_WEB_CLIENT_ID", env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID],
  ["AUD_WEB_API_SCOPE", env.NEXT_PUBLIC_AZURE_AD_API_SCOPE],
  // Opened through the tunnel: the page origin is http://localhost:<port> — the same redirect local development uses
  ["AUD_WEB_REDIRECT_URI", `http://localhost:${localPort}`],
];

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "api.env"), lines(api), { mode: 0o600 });
fs.writeFileSync(path.join(out, "web.env"), lines(web), { mode: 0o600 });
if (connections && fs.existsSync(connections)) fs.copyFileSync(connections, path.join(out, "connections.json"));

// Names only — never values
const names = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== "").map(([k]) => k).join(", ");
console.log(`api.env: ${names(api)}`);
console.log(`web.env: ${names(web)}`);
console.log(`connections.json: ${connections && fs.existsSync(connections) ? "included" : "none (one home connection)"}`);
const skipped = Object.keys(env).filter((k) => !api.some(([a]) => a === k) && !k.startsWith("NEXT_PUBLIC_AZURE_AD_") && k !== "AUD_CONNECTIONS_FILE");
if (skipped.length) console.log(`left out: ${skipped.sort().join(", ")}`);
if (test) console.log("TEST MODE: NODE_ENV=development (AUD_DEFAULT_ROLE allowed — not for production)");

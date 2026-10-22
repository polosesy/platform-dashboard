// The Kubernetes deployment: the Helm chart (deploy/helm/aud-dashboard) is the source, deploy/kubernetes/
// aud-dashboard.yaml its rendering. Checks the rendering is current (when helm is installed), the pod stays hardened,
// every env name the chart sets is one the code reads, one federation subject everywhere, and no tenant data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r/g, "");
const CHART = "deploy/helm/aud-dashboard";
const RENDERED = "deploy/kubernetes/aud-dashboard.yaml";
const SUBJECT = "system:serviceaccount:aud-dashboard:aud-dashboard";

function chartFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(join(ROOT, d))) {
      const p = `${d}/${f}`;
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(CHART);
  return out;
}

test("deploy/kubernetes/aud-dashboard.yaml is the current rendering of the chart (scripts/render-k8s.sh)", (t) => {
  const helm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
  if (helm.status !== 0) {
    t.skip("helm not installed");
    return;
  }
  const r = spawnSync("helm", ["template", "aud-dashboard", CHART, "--namespace", "aud-dashboard",
    "--set", "gateway.enabled=true", "--set", "healthCheckPolicy.enabled=true", "--set", "networkPolicy.enabled=true"],
  { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const body = r.stdout.replace(/\r/g, "").split("\n").filter((l) => !l.startsWith("# Source: ")).join("\n");
  const committed = read(RENDERED).split("\n").filter((l) => !l.startsWith("# GENERATED") && !l.startsWith("# Optional pieces")).join("\n");
  assert.equal(committed, body, "chart changed — run scripts/render-k8s.sh");
});

test("the pod is hardened: non-root, read-only root, no escalation, no capabilities, no API token, no CPU limit", () => {
  const y = read(RENDERED);
  for (const s of ["runAsNonRoot: true", "runAsUser: 65532", "type: RuntimeDefault", "automountServiceAccountToken: false"]) {
    assert.ok(y.includes(s), s);
  }
  for (const s of ["readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", "drop: [ALL]"]) {
    assert.equal(y.split(s).length - 1, 2, `${s} on both containers`);
  }
  assert.doesNotMatch(y, /limits:\n\s+cpu:/, "no CPU limit");
  assert.match(y, /azure\.workload\.identity\/skip-containers: web/, "the token goes to the api container only");
  assert.match(read("deploy/kubernetes/namespace.yaml"), /pod-security\.kubernetes\.io\/enforce: restricted/, "namespace PSA restricted");
});

test("every env name the chart sets is read by the code", () => {
  const y = read(RENDERED);
  const names = [...y.matchAll(/- \{ name: ([A-Z_]+), value:/g)].map((m) => m[1]!);
  assert.ok(names.length > 15);
  const code = read("apps/api/src/env.ts") + read("apps/web/src/lib/runtimeConfig.ts");
  const runtime = new Set(["PORT", "HOSTNAME", "NODE_ENV", "NODE_OPTIONS"]);
  for (const n of names) if (!runtime.has(n)) assert.ok(code.includes(n), `${n} is not read by env.ts / runtimeConfig.ts`);
});

test("one federation subject: chart, service-account template, FIC template, .env.example", () => {
  const y = read(RENDERED);
  assert.match(y, new RegExp(`name: AUD_PLATFORM_FEDERATION_SUBJECT, value: "${SUBJECT}"`));
  assert.match(y, /kind: ServiceAccount\nmetadata:\n  name: aud-dashboard\n  namespace: aud-dashboard/);
  assert.ok(read("docs/integrations/azure/templates/aks/aud-dashboard-serviceaccount.yaml").includes(SUBJECT));
  assert.equal(JSON.parse(read("docs/integrations/azure/templates/service-principal/fic-kubernetes.json")).subject, SUBJECT);
  assert.ok(read(".env.example").includes(SUBJECT));
  assert.match(read("deploy/kubernetes/namespace.yaml"), /name: aud-dashboard/);
});

test("no tenant data in the chart or its rendering: placeholders only", () => {
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const PRIVATE_IP = /\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+/;
  // The local, gitignored connections file (absent in CI): none of its names or IDs may appear
  const conn = join(ROOT, "config/connections.json");
  const local = existsSync(conn)
    ? [...readFileSync(conn, "utf8").matchAll(/"(?:key|displayName|tenantName|tenantId|clientId)"\s*:\s*"([^"]{4,})"/g)].map((m) => m[1]!.toLowerCase())
    : [];
  for (const f of [...chartFiles(), RENDERED, "deploy/kubernetes/namespace.yaml"]) {
    const text = read(f);
    assert.doesNotMatch(text, GUID, `${f}: GUID`);
    assert.doesNotMatch(text, PRIVATE_IP, `${f}: private IP`);
    const lower = text.toLowerCase();
    local.forEach((v, i) => assert.ok(v === "home" || !lower.includes(v), `${f}: contains local connection value #${i}`));
  }
});

test(".dockerignore keeps local secrets and notes out of any build context (docker build . / az acr build .)", () => {
  const lines = new Set(read(".dockerignore").split("\n").map((l) => l.trim()));
  for (const must of [".env", ".env.*", "config/", ".secrets/", "onprem.txt", "**/*.pem", "**/*.key", ".claude/", "apps/api/.probe/", "deploy/docker/*.env", "deploy/docker/tls/"]) {
    assert.ok(lines.has(must), `.dockerignore lacks ${must}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImageVuln } from "@aud/types";
import { DEFENDER_IMAGE_QUERY, defenderVulns, imageParts, mergeVulns, sbomVulns, vulnWeight, type DefenderImageRow } from "../src/services/imageVulns.js";
import type { OsvVuln } from "../src/services/vulnDb.js";

const ACR = "registry.example.azurecr.io";
const row = (over: Partial<DefenderImageRow>): DefenderImageRow => ({
  registry: ACR, repo: "team/app", digest: "sha256:aaa", tags: '["1.2.0"]', critical: 0, high: 0, medium: 0, low: 0, exploited: 0, fixable: 0, top: [], ...over,
});

test("imageParts: registry, Docker Hub default, tag and digest", () => {
  assert.deepEqual(imageParts(`${ACR}/team/app:1.2.0@sha256:aaa`), { registry: ACR, repo: "team/app", tag: "1.2.0", digest: "sha256:aaa" });
  assert.deepEqual(imageParts("nginx:1.27"), { registry: "docker.io", repo: "library/nginx", tag: "1.27", digest: "" });
  assert.deepEqual(imageParts("grafana/loki:3.1.0"), { registry: "docker.io", repo: "grafana/loki", tag: "3.1.0", digest: "" });
  assert.deepEqual(imageParts("localhost:5000/x:1"), { registry: "localhost:5000", repo: "x", tag: "1", digest: "" });
});

test("Defender: tied to the pod image by digest first, else by tag; another repo or tag is not this image", () => {
  const rows = [
    row({ digest: "sha256:aaa", critical: 1, high: 2, exploited: 1, fixable: 2, top: [{ cve: "CVE-2026-0001", sev: "Critical", pkg: "openssl", ver: "3.0.1", fixed: "3.0.9", ex: true }, { cve: "CVE-2026-0002", sev: "High", pkg: "zlib", ver: "1.2", fixed: "" }] }),
    row({ digest: "sha256:bbb", tags: '["1.2.0","latest"]', high: 5 }),
    row({ repo: "team/other", high: 9 }),
  ];
  const [byDigest] = defenderVulns([`${ACR}/team/app:1.2.0@sha256:aaa`], rows);
  assert.equal(byDigest!.basis, "digest");
  assert.deepEqual(byDigest!.counts, { critical: 1, high: 2, medium: 0, low: 0 });
  assert.equal(byDigest!.exploited, "poc", "Defender's 'exploit published' is a proof of concept, not KEV");
  assert.deepEqual(byDigest!.top.map((t) => [t.cve, t.severity, t.fixed]), [["CVE-2026-0001", "critical", "3.0.9"], ["CVE-2026-0002", "high", null]]);
  // By tag: two digests carry 1.2.0 → the worse one (the pod may run either) — critical outranks any number of highs
  const [byTag] = defenderVulns([`${ACR}/team/app:1.2.0`], rows);
  assert.equal(byTag!.basis, "tag");
  assert.deepEqual([byTag!.counts.critical, byTag!.counts.high], [1, 2]);
  const [latest] = defenderVulns([`${ACR}/team/app:latest`], rows);
  assert.deepEqual([latest!.basis, latest!.counts.high], ["tag", 5], "only the digest that carries 'latest'");
  assert.deepEqual(defenderVulns([`${ACR}/team/app:9.9.9`, "docker.io/team/app:1.2.0"], rows), [], "no tag/digest match, other registry → no result (not 'clean')");
});

const osv = (id: string, cve: string, severity: OsvVuln["severity"], fixed: string): OsvVuln =>
  ({ id, aliases: [cve], summary: null, severity, affected: [{ ecosystem: "Go", name: "github.com/argoproj/argo-cd/v2", fixed: [fixed] }] } as unknown as OsvVuln);

test("SBOM: known image at an exact tag → OSV advisories, KEV beats CVE.org 'active', mirrors and rebuilds are not guessed", () => {
  const image = "quay.io/argoproj/argocd:v2.9.3";
  const key = "Go|github.com/argoproj/argo-cd/v2|2.9.3";
  const byCoord = new Map([[key, { coord: { ecosystem: "Go", name: "github.com/argoproj/argo-cd/v2", version: "2.9.3" }, vulns: [osv("GHSA-1", "CVE-2026-1111", "high", "2.9.4"), osv("GHSA-2", "CVE-2026-2222", "medium", "2.9.5")] }]]);
  const records = new Map([["CVE-2026-2222", { title: null, cna: null, published: null, description: null, cvss: null, exploitation: "active" as const }]]);
  const [v] = sbomVulns([image, "mirror.example/common/argocd-dhi:v2.9.3"], byCoord, records, new Set(["CVE-2026-1111"]));
  assert.equal(v!.image, image);
  assert.equal(v!.source, "sbom");
  assert.equal(v!.exploited, "kev");
  assert.deepEqual(v!.counts, { critical: 0, high: 1, medium: 1, low: 0 });
  assert.equal(v!.top[0]!.cve, "CVE-2026-1111", "the KEV one first");
  assert.equal(sbomVulns(["mirror.example/common/argocd-dhi:v2.9.3"], byCoord, records, new Set()).length, 0, "a rebuilt mirror is not mapped");
  // Mapped and looked up with nothing found = a real 'no known advisories' (counts 0), not missing
  const clean = sbomVulns([image], new Map([[key, { coord: byCoord.get(key)!.coord, vulns: [] }]]), new Map(), new Set());
  assert.deepEqual(clean[0]!.counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(vulnWeight(clean[0]!), null);
});

test("merge and weight: Defender's scan of the image wins, the stronger exploitation signal is kept", () => {
  const base = { image: "x", basis: "tag" as const, fixable: 0, top: [] };
  const d: ImageVuln = { ...base, source: "defender", counts: { critical: 0, high: 2, medium: 0, low: 0 }, exploited: null };
  const s: ImageVuln = { ...base, source: "sbom", basis: "version", counts: { critical: 0, high: 1, medium: 0, low: 0 }, exploited: "kev" };
  const [m] = mergeVulns([d], [s]);
  assert.equal(m!.source, "defender");
  assert.equal(m!.exploited, "kev");
  assert.equal(vulnWeight(m!), "crit");
  assert.equal(vulnWeight({ ...d, exploited: null }), "warn");
  assert.equal(vulnWeight({ ...d, counts: { critical: 0, high: 0, medium: 1, low: 0 } }), "low");
});

test("Defender query: per image, unhealthy only, no tenant data", () => {
  assert.match(DEFENDER_IMAGE_QUERY, /subassessments/);
  assert.match(DEFENDER_IMAGE_QUERY, /=~ "Unhealthy"/);
  assert.match(DEFENDER_IMAGE_QUERY, /by registry = .*repo = .*digest = .*tags = /);
  assert.doesNotMatch(DEFENDER_IMAGE_QUERY, /[0-9a-f]{8}-[0-9a-f]{4}-/);
});

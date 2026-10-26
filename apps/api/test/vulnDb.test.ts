import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyFinding } from "@aud/types";
import { clusterSbom, imageCoord, osEcosystem, parseApkInstalled, parseDpkgStatus, scanNodeModules } from "../src/services/sbom.js";
import { compareDebian, compareSemverish, fixedFor, parseCveRecord, parseOsvVuln } from "../src/services/vulnDb.js";
import { fetchOfficial } from "../src/services/advisoryFeeds.js";
import * as av from "../../web/src/lib/advisoryView.ts";

const view = ((av as { default?: typeof av }).default ?? av) as typeof av;

test("SBOM: OS ecosystem, Debian packages by source name+version, Alpine by origin", () => {
  assert.equal(osEcosystem('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n'), "Debian:12");
  assert.equal(osEcosystem("ID=alpine\nVERSION_ID=3.20.3\n"), "Alpine:v3.20");
  assert.equal(osEcosystem('ID=ubuntu\nVERSION_ID="24.04"\n'), null, "only ecosystems we can name exactly");
  const dpkg = [
    "Package: libssl3\nStatus: install ok installed\nSource: openssl\nVersion: 3.0.15-1~deb12u1",
    "Package: libc6\nStatus: install ok installed\nSource: glibc (2.36-9+deb12u9)\nVersion: 2.36-9+deb12u9+b1",
    "Package: removed\nStatus: deinstall ok config-files\nVersion: 1.0",
  ].join("\n\n");
  assert.deepEqual(parseDpkgStatus(dpkg), [{ name: "openssl", version: "3.0.15-1~deb12u1" }, { name: "glibc", version: "2.36-9+deb12u9" }]);
  assert.deepEqual(parseApkInstalled("P:libcrypto3\nV:3.3.2-r1\no:openssl\n\nP:musl\nV:1.2.5-r0\n"), [{ name: "openssl", version: "3.3.2-r1" }, { name: "musl", version: "1.2.5-r0" }]);
});

test("SBOM: deployed node_modules — scoped and nested packages, components merged", () => {
  const root = mkdtempSync(join(tmpdir(), "aud-sbom-"));
  const pkg = (dir: string, name: string, version: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version })); };
  pkg(join(root, "next"), "next", "16.4.2");
  pkg(join(root, "@azure", "identity"), "@azure/identity", "4.14.0");
  pkg(join(root, "express", "node_modules", "qs"), "qs", "6.15.4");
  const acc = scanNodeModules(root, "API");
  scanNodeModules(root, "web", acc);
  assert.deepEqual([...acc.keys()].sort(), ["@azure/identity@4.14.0", "next@16.4.2", "qs@6.15.4"]);
  assert.deepEqual(acc.get("next@16.4.2")!.components, ["API", "web"]);
});

test("cluster: known open-source images map to Go modules (/vN for N >= 2); app images are never guessed", () => {
  assert.deepEqual(imageCoord("mcr.microsoft.com/oss/cilium/cilium:v1.17.3-250501"), { ecosystem: "Go", name: "github.com/cilium/cilium", version: "1.17.3" });
  assert.deepEqual(imageCoord("quay.io/argoproj/argocd:v3.1.2"), { ecosystem: "Go", name: "github.com/argoproj/argo-cd/v3", version: "3.1.2" });
  assert.deepEqual(imageCoord("grafana/loki:3.4.2"), { ecosystem: "Go", name: "github.com/grafana/loki/v3", version: "3.4.2" });
  assert.equal(imageCoord("demoacr.azurecr.io/team/signal-service:3.4.1"), null);
  assert.equal(imageCoord("quay.io/argoproj/argocd:latest"), null);
  const c = clusterSbom("1.33.8", [{ image: "quay.io/cilium/cilium:v1.17.3", workloads: ["kube-system/cilium"] }, { image: "app:1.0.0", workloads: ["a/b"] }]);
  assert.deepEqual(c.entries.map((e) => `${e.kind}:${e.name}@${e.version}`), ["k8s:k8s.io/kubernetes@1.33.8", "image:github.com/cilium/cilium@1.17.3"]);
  assert.equal(c.unmapped, 1);
});

test("versions: Debian ordering (epoch, tilde, revision) and semver with pre-releases", () => {
  assert.ok(compareDebian("3.0.15-1~deb12u1", "3.0.15-1") < 0, "tilde sorts first");
  assert.ok(compareDebian("1:1.0-1", "2.0-1") > 0, "epoch wins");
  assert.ok(compareDebian("2.36-9+deb12u9", "2.36-9+deb12u10") < 0);
  assert.ok(compareSemverish("16.4.2", "16.4.10") < 0);
  assert.ok(compareSemverish("1.0.0-rc1", "1.0.0") < 0);
});

test("CVE.org record: CNA title/score, CISA ADP score as fallback, SSVC exploitation", () => {
  const php = parseCveRecord({ cveMetadata: { assignerShortName: "php", datePublished: "2026-10-21T13:48:34Z", state: "PUBLISHED" }, containers: {
    cna: { title: "RCE via OOM corruption", descriptions: [{ lang: "en", value: "PHP uses longjmp()" }], metrics: [{ cvssV4_0: { baseScore: 9.2, baseSeverity: "CRITICAL", version: "4.0" } }] },
    adp: [{ providerMetadata: { shortName: "CISA-ADP" }, metrics: [{ other: { type: "ssvc", content: { options: [{ Exploitation: "none" }, { Automatable: "no" }] } } }] }],
  } });
  assert.deepEqual([php?.title, php?.cna, php?.cvss?.score, php?.exploitation], ["RCE via OOM corruption", "php", 9.2, "none"]);
  const log4j = parseCveRecord({ cveMetadata: { assignerShortName: "apache", state: "PUBLISHED" }, containers: { cna: { metrics: [] },
    adp: [{ metrics: [{ cvssV3_1: { baseScore: 10, baseSeverity: "CRITICAL", version: "3.1" } }, { other: { type: "ssvc", content: { options: [{ Exploitation: "active" }] } } }] }] } });
  assert.deepEqual([log4j?.cvss?.score, log4j?.exploitation], [10, "active"]);
  assert.equal(parseCveRecord({ cveMetadata: { state: "REJECTED" } }), null);
});

test("OSV: severity from the GitHub advisory, smallest fixed version above ours for our package only", () => {
  const v = parseOsvVuln({ id: "GHSA-2464-fhr4-w9xw", aliases: ["CVE-2026-1234"], summary: "Next.js RCE", database_specific: { severity: "CRITICAL" },
    affected: [{ package: { ecosystem: "npm", name: "next" }, ranges: [{ events: [{ introduced: "10.0.0" }, { fixed: "15.5.28" }] }, { events: [{ introduced: "16.0.0" }, { fixed: "16.4.1" }] }] },
      { package: { ecosystem: "npm", name: "other" }, ranges: [{ events: [{ fixed: "16.2.0" }] }] }] })!;
  assert.equal(v.severity, "critical");
  assert.equal(fixedFor(v, { ecosystem: "npm", name: "next", version: "16.1.6" }), "16.4.1");
  assert.equal(fixedFor(v, { ecosystem: "npm", name: "next", version: "16.4.2" }), null, "nothing above ours");
  const deb = parseOsvVuln({ id: "DEBIAN-CVE-2025-1", affected: [{ package: { ecosystem: "Debian:12", name: "openssl" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "3.0.17-1~deb12u2" }] }] }] })!;
  assert.equal(deb.severity, "unknown");
  assert.equal(fixedFor(deb, { ecosystem: "Debian:12", name: "openssl", version: "3.0.15-1~deb12u1" }), "3.0.17-1~deb12u2");
});

test("feed hosts: CVE.org and OSV are on the allow-list over https only, nothing else", async () => {
  await assert.rejects(fetchOfficial("https://example.org/api/cve/CVE-2026-10001"), /not an allowed feed host/);
  await assert.rejects(fetchOfficial("http://api.osv.dev/v1/querybatch", { json: {} }), /not an allowed feed host/);
});

test("view: severe filter keeps critical/high and anything exploited; place filter", () => {
  const f = (over: Partial<DependencyFinding>): DependencyFinding => ({ id: "x", cves: [], summary: null, severity: "medium", cvss: null, exploited: null, kind: "npm", ecosystem: "npm", pkg: "p", version: "1.0.0", fixed: null, where: "platform", components: [], image: null, url: "", ...over });
  const list = [f({ id: "a", severity: "critical" }), f({ id: "b", exploited: "poc" }), f({ id: "c" }), f({ id: "d", severity: "high", where: "cluster" })];
  assert.deepEqual(view.filterFindings(list, { severe: true, where: "all" }).map((x) => x.id), ["a", "b", "d"]);
  assert.deepEqual(view.filterFindings(list, { severe: false, where: "cluster" }).map((x) => x.id), ["d"]);
  assert.deepEqual(view.findingCounts(list), { all: 4, severe: 3, platform: 3, cluster: 1, noFix: 4 });
  assert.equal(view.cveOrgUrl("CVE-2026-109618"), "https://www.cve.org/CVERecord?id=CVE-2026-109618");
});

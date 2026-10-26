import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCves, fetchOfficial, parseKev, parseNodeIndex, parseNodeRss, parseNvd, parsePhpAtom, parsePhpReleases,
} from "../src/services/advisoryFeeds.js";
import {
  buildItem, compareVersions, fixesFor, imageRuntime, recentKev, vendorBases, type MatchContext,
} from "../src/services/advisories.js";
import { defenderQuery } from "../src/services/advisoriesCollector.js";
import type { AdvisoryCve } from "@aud/types";

// Samples shaped like the real feeds (2026-10-23)
const PHP_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>PHP.net news &amp; announcements</title>
<entry xmlns="http://www.w3.org/2005/Atom" xml:base="entries/2026-10-21-5.xml">
  <title>Security advisory: Critical remote code execution vulnerabilities, update now</title>
  <id>https://www.php.net/archive/2026.php#2026-10-21-5</id><updated>2026-10-21T00:35:26+00:00</updated>
  <link href="https://www.php.net/index.php#2026-10-21-5" rel="alternate" type="text/html"/>
  <content type="xhtml"><div>PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35 fix two critical vulnerabilities. CVE-2026-109618 (GHSA-w8hw) … CVE-2026-109619 …</div></content>
</entry>
<entry xmlns="http://www.w3.org/2005/Atom"><title>PHP 8.5.12 Released!</title><id>https://www.php.net/archive/2026.php#2026-10-21-1</id>
  <updated>2026-10-21T00:10:00+00:00</updated><content type="xhtml"><div>Fixes CVE-2026-109618 and CVE-2026-109619.</div></content></entry>
<entry xmlns="http://www.w3.org/2005/Atom"><title>PHP 8.6.0 Alpha 1 available</title><id>https://www.php.net/archive/2026.php#x</id><updated>2026-10-01T00:00:00+00:00</updated><content>new features</content></entry>
</feed>`;
const NODE_RSS = `<rss version="2.0"><channel><item><title><![CDATA[Wednesday, October 21, 2026 Security Releases]]></title>
<link>https://nodejs.org/en/blog/vulnerability/october-2026-security-releases</link><pubDate>Wed, 21 Oct 2026 22:00:00 GMT</pubDate></item>
<item><title>Evil</title><link>https://evil.example/x</link><pubDate>Wed, 21 Oct 2026 22:00:00 GMT</pubDate></item></channel></rss>`;
const NODE_INDEX = [
  { version: "v26.12.1", date: "2026-10-21", security: true }, { version: "v24.22.1", date: "2026-10-20", security: true },
  { version: "v24.22.0", date: "2026-10-01", security: false }, { version: "v24.18.1", date: "2026-07-29", security: true },
  { version: "v22.23.4", date: "2026-10-20", security: true }, { version: "v23.11.1", date: "2025-05-14", security: true },
];
const PHP_REL = { "8.5.12": { date: "21 Oct 2026", tags: ["security"] }, "8.4.27": { date: "21 Oct 2026", tags: ["security"] }, "8.3.36": { date: "21 Oct 2026", tags: ["security"] }, "8.3.35": { date: "24 Sep 2026", tags: ["security"] }, "8.1.33": { date: "03 Jul 2025", tags: ["security"] } };

test("feeds parse: PHP Atom (namespaced entries, archive link, CVEs), Node RSS (nodejs.org only), release indexes, KEV, NVD", () => {
  const php = parsePhpAtom(PHP_ATOM);
  assert.deepEqual(php.map((p) => [p.url, p.cves.length]), [["https://www.php.net/archive/2026.php#2026-10-21-5", 2], ["https://www.php.net/archive/2026.php#2026-10-21-1", 2]]);
  const node = parseNodeRss(NODE_RSS);
  assert.deepEqual(node.map((p) => p.url), ["https://nodejs.org/en/blog/vulnerability/october-2026-security-releases"]);
  assert.equal(node[0]!.date, "2026-10-21T22:00:00.000Z");
  assert.equal(parseNodeIndex(NODE_INDEX).find((r) => r.version === "24.22.1")!.security, true);
  assert.deepEqual(parsePhpReleases(PHP_REL).find((r) => r.version === "8.3.36"), { line: "8.3", version: "8.3.36", date: "2026-10-21", security: true });
  assert.deepEqual(extractCves("a CVE-2026-111497, b CVE-2026-111497 c CVE-2026-105482"), ["CVE-2026-111497", "CVE-2026-105482"]);
  const kev = parseKev({ vulnerabilities: [{ cveID: "CVE-2021-44228", vendorProject: "Apache", product: "Log4j2", vulnerabilityName: "Log4Shell", dateAdded: "2021-12-10", dueDate: "2021-12-24", requiredAction: "Apply updates", knownRansomwareCampaignUse: "Known" }, { cveID: "bad" }] });
  assert.equal(kev.length, 1);
  assert.equal(kev[0]!.ransomware, true);
  const nvd = parseNvd({ vulnerabilities: [{ cve: { published: "2026-10-21T00:00:00", descriptions: [{ lang: "en", value: "Brotli decoder overflow" }], metrics: { cvssMetricV40: [{ type: "Secondary", cvssData: { version: "4.0", baseScore: 9.2, baseSeverity: "CRITICAL" } }] } } }] });
  assert.deepEqual(nvd?.cvss, { score: 9.2, version: "4.0", severity: "CRITICAL" });
});

test("only the fixed feed hosts over https are fetched", async () => {
  await assert.rejects(fetchOfficial("https://evil.example/x.json"), /not an allowed feed host/);
  await assert.rejects(fetchOfficial("http://nodejs.org/dist/index.json"), /not an allowed feed host/);
});

test("fixed version per line = the vendor's first security release on/after the advisory; old lines are end of life", () => {
  const fixes = fixesFor(parseNodeIndex(NODE_INDEX), "2026-10-21T22:00:00Z");
  assert.deepEqual(fixes.map((f) => `${f.line}:${f.version}`), ["26:26.12.1", "24:24.22.1", "22:22.23.4"]);
  assert.deepEqual(fixesFor(parsePhpReleases(PHP_REL), "2026-10-21T00:35:26Z").map((f) => f.version), ["8.5.12", "8.4.27", "8.3.36"]);
  assert.ok(compareVersions("24.9.0", "24.22.1") < 0, "numeric, not string, comparison");
});

test("image names: official runtime repos only; tags without a patch version stay unknown", () => {
  assert.deepEqual(imageRuntime("node:24.13.0-bookworm-slim"), { product: "nodejs", line: "24", version: "24.13.0", reason: "exact" });
  assert.deepEqual(imageRuntime("myacr.azurecr.io/common/dhi-node:24.22.1-dev@sha256:abc"), { product: "nodejs", line: "24", version: "24.22.1", reason: "exact" });
  assert.deepEqual(imageRuntime("php:8.3.12-fpm-alpine"), { product: "php", line: "8.3", version: "8.3.12", reason: "exact" });
  assert.deepEqual(imageRuntime("bitnami/php-fpm:8.2"), { product: "php", line: "8.2", version: null, reason: "lineOnly" });
  assert.deepEqual(imageRuntime("node:lts-alpine"), { product: "nodejs", line: null, version: null, reason: "noVersion" });
  assert.equal(imageRuntime("acr.io/team/signal-service:1.4.2"), null, "app images are not guessed");
  assert.equal(imageRuntime("acr.io/team/node-exporter:1.8.0"), null);
});

const cveOf = (id: string): AdvisoryCve => ({ id, cvss: null, description: null, published: null, kev: null });
const NODE_POST = [{ title: "Oct 2026", url: "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases", date: "2026-10-21T22:00:00Z", cves: ["CVE-2026-111497", "CVE-2026-105482"] }];

test("matching: runtime version decides (24.22.1 is fixed although its bundled Brotli still says 1.2.0), tags, eol, Defender", () => {
  const ctx: MatchContext = {
    runtimes: [{ product: "nodejs", version: "24.22.1", where: "dashboard", evidence: "runtime" }],
    clusterImages: [
      { image: "node:24.13.0-bookworm-slim", workloads: ["app/web"] },
      { image: "node:24-alpine", workloads: ["app/batch"] },
      { image: "node:23.11.0", workloads: ["app/old"] },
      { image: "acr.io/team/api:2.0", workloads: ["app/api"] },
    ],
    defender: [{ cve: "CVE-2026-111497", image: "acr.io/team/api:2.0", pkg: "nodejs", version: "24.10.0", fixed: "24.22.1" }],
    workloadsOf: (img) => (img.includes("team/api") ? ["app/api"] : []),
  };
  const [base] = vendorBases("nodejs", NODE_POST, parseNodeIndex(NODE_INDEX), cveOf);
  const item = buildItem(base!, ctx);
  const st = Object.fromEntries(item.targets.map((t) => [t.image ?? t.where, t.status]));
  assert.equal(st.dashboard, "fixed");
  assert.equal(st["node:24.13.0-bookworm-slim"], "affected");
  assert.equal(st["node:24-alpine"], "unknown");
  assert.equal(st["node:23.11.0"], "eol");
  assert.equal(st["acr.io/team/api:2.0"], "affected");
  assert.equal(item.status, "affected");
  assert.equal(item.targets[0]!.status, "affected", "worst first");
  assert.ok(item.actions.some((a) => a.includes("24.22.1")));
  assert.ok(item.actions.some((a) => /node:24|latest/.test(a)), "asks to pin unknown tags");
});

test("verdicts never claim 'clear' from a source that wasn't read", () => {
  const [base] = vendorBases("php", parsePhpAtom(PHP_ATOM), parsePhpReleases(PHP_REL), cveOf);
  const none = (over: Partial<MatchContext>): MatchContext => ({ runtimes: [], clusterImages: [], defender: [], workloadsOf: () => [], ...over });
  assert.equal(buildItem(base!, none({})).status, "notDetected", "cluster read, Defender read, no PHP found");
  assert.equal(buildItem(base!, none({ defender: null })).status, "unknown");
  assert.equal(buildItem(base!, none({ clusterImages: null })).status, "unknown");
  assert.equal(buildItem(base!, none({ clusterImages: [{ image: "php:8.3.36-fpm", workloads: ["web/php"] }] })).status, "clear");
});

test("release notes repeating an advisory's CVEs fold into it; KEV keeps the last 30 days; Defender query is CVE-only", () => {
  assert.equal(vendorBases("php", parsePhpAtom(PHP_ATOM), parsePhpReleases(PHP_REL), cveOf).length, 1);
  const kev = parseKev({ vulnerabilities: [
    { cveID: "CVE-2026-10001", dateAdded: "2026-10-20" }, { cveID: "CVE-2026-10002", dateAdded: "2026-08-01" }, { cveID: "CVE-2026-10003", dateAdded: "2026-10-22" },
  ] });
  assert.deepEqual(recentKev(kev, new Date("2026-10-23T00:00:00Z")).map((k) => k.cve), ["CVE-2026-10003", "CVE-2026-10001"]);
  const q = defenderQuery(["CVE-2026-111497", "x\" or 1==1"]);
  assert.match(q, /in~ \("CVE-2026-111497"\)/);
  assert.doesNotMatch(q, /1==1/);
});

test("anonymous callers never see the dashboard's runtime version", async () => {
  const { collectAdvisories } = await import("../src/services/advisoriesCollector.js");
  const r = await collectAdvisories({ AUD_ADVISORY_FEEDS: false } as never, undefined, { clusterId: null, watch: [], lang: "en" });
  assert.deepEqual(r.runtimes, []);
  assert.equal(r.sources.find((s) => s.id === "platform")!.state, "signin");
  assert.ok(!JSON.stringify(r).includes(process.versions.node));
});

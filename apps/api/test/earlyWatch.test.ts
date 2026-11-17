// 긴급 취약점 › 선제 감시 (2026-11-17). Fixtures copy the structure of the real pages (Oracle CSPU November 2026
// pre-release announcement, an Oracle CPU risk matrix row, the OpenJDK advisory index and risk matrix, KISA's RSS) with
// shortened content; checked against the live pages on 2026-11-17 (see docs/security/security-operations-guide.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEnv } from "../src/env.js";
import {
  CVE_ID_API, KISA_RSS, OPENJDK_INDEX, ORACLE_BASE, checkOnce, clearEarlyWatchMemory, earlyWatchResponse, eventAlert, inFastWindow, javaVerdict, kisaMatches,
  oracleCycle, oracleCycles, parseKisaRss, parseOpenJdkAdvisory, parseOpenJdkIndex, parseOracleAlerts, parseOraclePage, setWatch, thirdTuesday,
} from "../src/services/earlyWatch.js";

import * as evNs from "../../web/src/lib/earlyWatchView.ts";

const EV = ((evNs as unknown as { default?: typeof evNs }).default ?? evNs) as typeof evNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const PRE = `<html><head><title>Oracle Critical Security Patch Update Advisory - November 2026</title>
<script>pageData.pageInfo.updatedDate = "2026-11-12T18:40:25Z";</script></head><body>
<h2>Oracle Critical Security Patch Update Pre-Release Announcement - November 2026</h2>
<h4 id="AppendixHYP">Oracle Hyperion Executive Summary</h4><p>This Critical Security Patch Update contains 267 new security patches for Oracle Hyperion.</p>
<h4 id="AppendixJAVA">Oracle Java SE Executive Summary</h4>
<p>This Critical Security Patch Update contains 11 new security patches for Oracle Java SE.&nbsp; All of these vulnerabilities may be remotely exploitable without authentication, i.e., may be exploited over a network without requiring user credentials.&nbsp;</p>
<p>The highest CVSS v3.1 Base Score of vulnerabilities affecting Oracle Java SE is 8.1.</p>
<p>The Oracle Java SE products and versions affected by vulnerabilities that are addressed in this Critical Security Patch Update are:</p>
<ul><li>Oracle GraalVM for JDK, versions 17.0.21, 21.0.13</li><li>Oracle Java SE, versions 8u511, 8u511-perf, 11.0.33, 17.0.21, 21.0.13, 25.0.5, 27.0.1</li><li>Oracle JavaFX, versions 21.0.13, 25.0.5, 27.0.1</li></ul>
<h4 id="AppendixJDE">Oracle JD Edwards Executive Summary</h4><p>Oracle Java SE, versions 99.0.1</p></body></html>`;

const FINAL = `<title>Oracle Critical Patch Update Advisory - October 2026</title><script>pageData.pageInfo.updatedDate = "2026-10-15T17:20:09Z";</script>
<h2>Oracle Critical Patch Update Advisory - October 2026</h2>
<h4 id="AppendixJAVA">Oracle Java SE Risk Matrix</h4><p>This Critical Patch Update contains 55 new security patches for Oracle Java SE.&nbsp; 49 of these vulnerabilities may be remotely exploitable without authentication.</p>
<table><tr><th>CVE ID</th><th>Product</th></tr><tr><th colspan="2">CVSS VERSION 3.1 RISK (see Risk Matrix Definitions)</th></tr>
<tr><th class="otable-col-sticky">CVE-2026-91484</th><td>Oracle Java SE</td><td>Java plugin</td><td>None</td><td>No</td><td>7.5</td><td>Local</td><td>Oracle Java SE: 8u503, 8u503-perf</td></tr>
<tr><th class="otable-col-sticky">CVE-2026-90001</th><td>Oracle Java SE</td><td>Hotspot</td><td>Multiple</td><td>Yes</td><td>8.3</td><td>Network</td><td>Oracle Java SE: 8u503, 11.0.29, 17.0.17, 21.0.9, 25.0.1; Oracle GraalVM for JDK: 21.0.9</td></tr>
</table><h4 id="AppendixJDE">Oracle JD Edwards Risk Matrix</h4><tr><th>CVE-2026-1111</th><td>x</td><td>x</td><td>x</td><td>Yes</td><td>9.8</td></tr>`;

const OJ_INDEX = `<p>Advisories</p><p><a href="2026-10-24">2026/10/24</a> (latest)</p><p><a href="2026-10-21">2026/10/21</a></p><p><a href="2026-08-18">2026/08/18</a></p>`;
const OJ = `<p>The following vulnerabilities in OpenJDK source code were fixed in this release. The affected versions are 27.0.1.0.2, 25.0.5.0.2,
21.0.13.0.2, 17.0.21.0.2, 11.0.32.1, 8u504, and earlier. Please note …</p>
<table class="risk-matrix" summary="Risk matrix"><tr><th></th><th></th><th></th><th colspan="6">Affects ...</th></tr><tr><th nowrap="nowrap">CVE ID</th><th nowrap="nowrap">Component</th><th><a href="https://www.first.org/cvss/">CVSSv3.1</a><br />Vector</th><th>8</th><th>11</th><th>17</th><th>21</th><th>25</th><th>27</th></tr>
<tr><td nowrap="nowrap"><a href="https://nvd.nist.gov/vuln/detail/CVE-2026-114820">CVE-2026-114820</a></td><td>security-libs/<br />java.security</td><td>9.1<br />NLNNUHHN</td><td></td><td>&#8226;</td><td>&#8226;</td><td>&#8226;</td><td>&#8226;</td><td>&#8226;</td></tr></table>
<h2 id="jfx-risk-matrix">OpenJFX Risk matrix</h2><table class="risk-matrix"><tr><td>None</td></tr></table>`;

const KISA = `<rss version="2.0"><channel><title><![CDATA[보호나라>알림마당>보안공지]]></title>
<item><title><![CDATA[ Oracle 제품 보안 업데이트 권고 ]]></title><link><![CDATA[https://www.boho.or.kr/kr/bbs/view.do?bbsId=B0000133&nttId=1]]></link><pubDate><![CDATA[Wed, 18 Nov 2026 09:00:00 +0900]]></pubDate></item>
<item><title><![CDATA[ Citrix 제품 보안 업데이트 권고 ]]></title><link><![CDATA[https://evil.example/x]]></link><pubDate></pubDate></item>
<item><title><![CDATA[ Javascript 라이브러리 CVE-2026-114938 관련 ]]></title><link></link><pubDate></pubDate></item>
</channel></rss>`;

test("Oracle schedule: third Tuesday 13:00 Los Angeles (PST/PDT), pre-release the Thursday before; CPU in Jan·Apr·Jul·Oct, CSPU the other months", () => {
  assert.equal(thirdTuesday(2026, 10), 17);
  assert.equal(thirdTuesday(2027, 0), 19, "Oracle's index: 19 January 2027");
  assert.deepEqual(oracleCycle(2026, 10), { kind: "cspu", month: "2026-11", releaseAt: "2026-11-17T21:00:00.000Z", preReleaseDate: "2026-11-12", url: `${ORACLE_BASE}cspunov2026.html` },
    "the internal mail: 11/18 (Wed) 06:00 KST = 2026-11-17T21:00Z; the pre-release went up 2026-11-12");
  assert.equal(oracleCycle(2027, 3).releaseAt, "2027-04-20T20:00:00.000Z", "PDT in April: 13:00 = 20:00Z (Oracle: 20 April 2027)");
  assert.equal(oracleCycle(2026, 9).url, `${ORACLE_BASE}cpuoct2026.html`);
  // the current cycle stays until a week after its release, then the next
  assert.deepEqual(oracleCycles(new Date("2026-11-17T08:30:00Z")).map((c) => c.month), ["2026-11", "2026-12"]);
  assert.deepEqual(oracleCycles(new Date("2026-11-25T00:00:00Z")).map((c) => c.month), ["2026-12", "2027-01"]);
  const c = oracleCycles(new Date("2026-11-17T08:30:00Z"));
  assert.equal(inFastWindow(new Date("2026-11-17T08:30:00Z"), c), false);
  assert.equal(inFastWindow(new Date("2026-11-17T20:50:00Z"), c), true, "15 min before the release");
  assert.equal(inFastWindow(new Date("2026-11-12T19:00:00Z"), c), true, "the pre-release Thursday (Los Angeles day)");
});

test("Oracle pages: pre-release vs advisory, Oracle's update time, the Java SE section only (patches · remote · score · versions · CVEs)", () => {
  const p = parseOraclePage(PRE);
  assert.deepEqual(p, { preRelease: true, updatedAt: "2026-11-12T18:40:25.000Z", java: { patches: 11, remoteUnauth: "all", maxScore: 8.1, scoreVersion: "3.1", versions: ["8u511", "11.0.33", "17.0.21", "21.0.13", "25.0.5", "27.0.1"], cves: [] } },
    "the score's full stop is not part of the number (8.1. read as NaN); GraalVM / JavaFX and the next appendix are not Java SE");
  const f = parseOraclePage(FINAL);
  assert.equal(f.preRelease, false);
  assert.deepEqual([f.java!.patches, f.java!.remoteUnauth, f.java!.maxScore, f.java!.scoreVersion, f.java!.cves], [55, 49, 8.3, "3.1", ["CVE-2026-91484", "CVE-2026-90001"]],
    "the CVE sits in a <th>; the next appendix's 9.8 is not Java's");
  assert.deepEqual(f.java!.versions, ["8u503", "11.0.29", "17.0.17", "21.0.9", "25.0.1"]);
  assert.equal(parseOraclePage("<h2>Something else</h2>").java, null);
  assert.deepEqual(parseOracleAlerts(`<a href="/security-alerts/alert-CVE-2026-114820.html">x</a><a href="/security-alerts/alert-cve-2021-44228.html">y</a><a href="/security-alerts/alert-CVE-2026-114820.html">z</a>`), ["cve-2026-114820", "cve-2021-44228"]);
});

test("OpenJDK: the index's relative links; an advisory's affected versions and per-line marks", () => {
  assert.deepEqual(parseOpenJdkIndex(OJ_INDEX), ["2026-10-24", "2026-10-21", "2026-08-18"]);
  assert.deepEqual(parseOpenJdkAdvisory(OJ, "2026-10-24"), {
    date: "2026-10-24", url: `${OPENJDK_INDEX}2026-10-24`, affected: ["27.0.1.0.2", "25.0.5.0.2", "21.0.13.0.2", "17.0.21.0.2", "11.0.32.1", "8u504"],
    cves: [{ id: "CVE-2026-114820", score: 9.1, lines: [11, 17, 21, 25, 27] }],
  });
});

test("KISA RSS: CDATA items, links kept on boho/krcert only; a title names a watched product (word) or CVE", () => {
  const items = parseKisaRss(KISA);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { title: "Oracle 제품 보안 업데이트 권고", url: "https://www.boho.or.kr/kr/bbs/view.do?bbsId=B0000133&nttId=1", date: "2026-11-18T00:00:00.000Z" });
  assert.match(items[1]!.url, /^https:\/\/www\.boho\.or\.kr\//, "a link off KISA's hosts is never kept");
  assert.deepEqual(kisaMatches(items[0]!.title, []), ["oracle"]);
  assert.deepEqual(kisaMatches(items[1]!.title, []), []);
  assert.deepEqual(kisaMatches(items[2]!.title, ["CVE-2026-114938"]), ["CVE-2026-114938"], "Javascript is not Java");
});

test("Java versions against a 'newest affected per line' list — Oracle (8u511 · 21.0.13) and OpenJDK (21.0.13.0.2 · 8u504) forms", () => {
  const oracle = ["8u511", "11.0.33", "17.0.21", "21.0.13", "25.0.5", "27.0.1"];
  const openjdk = ["27.0.1.0.2", "25.0.5.0.2", "21.0.13.0.2", "17.0.21.0.2", "11.0.32.1", "8u504"];
  const cases: Array<[string, string, string]> = [
    ["21.0.12+7-LTS", "affected", "affected"], ["jdk-21.0.12+7", "affected", "affected"], ["21.0.13", "affected", "affected"],
    ["21.0.14", "newer", "newer"], ["1.8.0_412", "affected", "affected"], ["8u521", "newer", "newer"], ["8u505", "affected", "newer"],
    ["22.0.2", "lineNotListed", "lineNotListed"], ["25", "affected", "affected"], ["unknown", "unknown", "unknown"],
  ];
  for (const [v, o, j] of cases) assert.deepEqual([javaVerdict(v, oracle), javaVerdict(v, openjdk)], [o, j], v);
  // the web's copy (lib/earlyWatchView.ts) answers the same for every case
  for (const [v] of cases) assert.deepEqual([EV.javaVerdict(v, oracle), EV.javaVerdict(v, openjdk)], [javaVerdict(v, oracle), javaVerdict(v, openjdk)], `web ${v}`);
  // a workload table: jvm workloads only, affected first; no version = "unknown", no list = null
  const rows = EV.javaExposure([
    { namespace: "a", workload: "new", kinds: [{ kind: "jvm", basis: "metrics", version: "21.0.14+7" }], values: {} },
    { namespace: "a", workload: "old", kinds: [{ kind: "jvm", basis: "config", version: "21.0.12+7" }], values: {} },
    { namespace: "a", workload: "node", kinds: [{ kind: "nodejs", basis: "metrics", version: "24.22.1" }], values: {} },
    { namespace: "b", workload: "nover", kinds: [{ kind: "jvm", basis: "spec" }], values: {} },
  ], { oracle: { current: { java: { versions: oracle } }, next: {}, alerts: [] }, openjdk: null } as never);
  assert.deepEqual(rows.map((r) => [r.workload, r.oracle, r.openjdk]), [["old", "affected", null], ["nover", "unknown", null], ["new", "newer", null]]);
  assert.deepEqual(EV.exposureCounts(rows), { total: 3, oracle: 1, openjdk: 0, noVersion: 1, versions: ["21.0.12+7", "21.0.14+7"] });
});

test("a check: new things become events with the time first seen and go to the alert center; the first check without a state file is quiet; CVE.org RESERVED → PUBLISHED", async () => {
  clearEarlyWatchMemory();
  const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: "00000000-0000-0000-0000-0000000000aa" });
  let cveState = "RESERVED", nov = 404, alerts = `<a href="/security-alerts/alert-cve-2026-114820.html">`;
  const pages = (u: string): { status: number; body: string } => {
    if (u.endsWith("cspunov2026.html")) return nov === 404 ? { status: 404, body: "" } : { status: 200, body: PRE };
    if (u.endsWith("cspudec2026.html")) return { status: 404, body: "" };
    if (u === ORACLE_BASE) return { status: 200, body: alerts };
    if (u === OPENJDK_INDEX) return { status: 200, body: OJ_INDEX };
    if (u === `${OPENJDK_INDEX}2026-10-24`) return { status: 200, body: OJ };
    if (u === KISA_RSS) return { status: 200, body: KISA };
    if (u === `${CVE_ID_API}CVE-2026-114938`) return { status: 200, body: JSON.stringify({ cve_id: "CVE-2026-114938", state: cveState }) };
    if (u.endsWith("/api/cve/CVE-2026-114938")) return { status: 200, body: JSON.stringify({ cveMetadata: { state: "PUBLISHED", assignerShortName: "oracle", datePublished: "2026-11-17T21:00:00Z" }, containers: { cna: { title: "Java SE: Hotspot", metrics: [{ cvssV4_0: { baseScore: 9.2, baseSeverity: "CRITICAL", version: "4.0" } }] } } }) };
    return { status: 500, body: "" };
  };
  const sent: Array<{ id: string; severity: string; title: string; source: string; category: string }> = [];
  const deps = (at: string) => ({ fetch: async (u: string) => pages(u), deliver: async (a: Array<{ id: string; severity: string; title: string; source: string; category: string }>) => { sent.push(...a); }, now: () => new Date(at) });

  assert.equal((await setWatch(env, [{ id: "cve-2026-114938", note: "사내 공지" }], 0, "op")).ok, true);
  assert.deepEqual(await setWatch(env, [{ id: "CVE-2026-114938" }], 0, "op"), { ok: false, error: "conflict" });
  assert.deepEqual(await setWatch(env, [{ id: "not-a-cve" }], 1, "op"), { ok: false, error: "invalid" });
  // first check (nothing remembered, no state file): what is already out is recorded quietly
  const first = await checkOnce(env, deps("2026-11-11T00:00:00Z"));
  assert.ok(first.events.length >= 3 && first.events.every((e) => !e.notified));
  assert.equal(sent.length, 0);
  // the pre-release appears: one event, sent, with the time first seen
  nov = 200;
  const second = await checkOnce(env, deps("2026-11-12T18:45:00Z"));
  assert.deepEqual(second.events.map((e) => [e.kind, e.firstSeenAt, e.notified]), [["preRelease", "2026-11-12T18:45:00.000Z", true]]);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.source, sent[0]!.category, sent[0]!.severity], ["advisory", "security", "sev2"], "highest 8.1 → sev2");
  assert.match(sent[0]!.title, /사전 공지.*Java SE 11건.*2026-11-17 21:00 UTC/);
  // nothing new → nothing sent; a new Oracle Security Alert and the watched CVE published → two
  assert.equal((await checkOnce(env, deps("2026-11-12T19:00:00Z"))).events.length, 0);
  cveState = "PUBLISHED"; alerts += `<a href="/security-alerts/alert-cve-2026-200001.html">`;
  const third = await checkOnce(env, deps("2026-11-17T21:02:00Z"));
  assert.deepEqual(third.events.map((e) => e.kind).sort(), ["cvePublished", "securityAlert"]);
  const pub = sent.find((a) => /CVE 공개/.test(a.title))!;
  assert.equal(pub.severity, "sev1", "CVSS 9.2 → sev1");
  const r = await earlyWatchResponse(env, true);
  assert.deepEqual([r.oracle.current.state, r.oracle.current.firstSeenAt, r.oracle.current.updatedAt], ["preRelease", "2026-11-12T18:45:00.000Z", "2026-11-12T18:40:25.000Z"]);
  assert.deepEqual([r.watch[0]!.id, r.watch[0]!.state, r.watch[0]!.publishedSeenAt, r.watch[0]!.cvss?.score, r.watch[0]!.note], ["CVE-2026-114938", "PUBLISHED", "2026-11-17T21:02:00.000Z", 9.2, "사내 공지"]);
  assert.deepEqual(r.kisa.map((k) => k.matched), [["oracle"], ["CVE-2026-114938"]]);
  assert.equal(r.openjdk?.date, "2026-10-24");
  assert.equal(r.durable, false);
  clearEarlyWatchMemory();
});

test("alert: stable id per event, links to the source and the page; severity from the score", () => {
  const e = { key: "oracle:2026-11:preRelease", source: "oracle" as const, kind: "preRelease" as const, title: "t", url: "https://www.oracle.com/security-alerts/cspunov2026.html", firstSeenAt: "2026-11-12T18:45:00Z", cves: [], maxScore: null, notified: true };
  const a = eventAlert(e, { patches: 11, remoteUnauth: "all", maxScore: 9.8, scoreVersion: "3.1", versions: ["21.0.13"], cves: [] });
  assert.equal(a.id, eventAlert(e, null).id);
  assert.equal(a.severity, "sev1");
  assert.match(a.summary ?? "", /Java SE 패치 11건 · 모두 인증 없이 원격 악용 가능 · 최고 CVSS v3\.1 9\.8 · 대상 21\.0\.13 이하/);
  assert.deepEqual(a.links.map((l) => l.kind), ["source", "dashboard"]);
});

test("wiring: allow-listed hosts, env, the watcher starts with the alert center, routes (signed in / operator), the page", () => {
  assert.match(read("../src/services/advisoryFeeds.ts"), /"www\.oracle\.com", "openjdk\.org", "www\.boho\.or\.kr"/);
  assert.match(read("../src/env.ts"), /AUD_ADVISORY_WATCH_INTERVAL_SEC: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(86_400\)\.default\(900\)/);
  assert.match(read("../src/routes/notify.ts"), /startEarlyWatch\(env, \(alerts\) => deliverAlerts\(env, alerts\)\)/);
  const sec = read("../src/routes/security.ts");
  assert.match(sec, /router\.get\("\/api\/security\/early-watch"[\s\S]{0,200}signin_required/);
  assert.match(sec, /router\.put\("\/api\/security\/early-watch", requireRole\(env, "operator"\)/);
  assert.match(sec, /router\.post\("\/api\/security\/early-watch\/check", requireRole\(env, "operator"\)/);
  assert.match(read("../../web/src/app/security/advisories/page.tsx"), /<EarlyWatchPanel /);
});

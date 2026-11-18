// 사례·런북 §10 B·C·D and §11 (2026-11-17): change correlation, evidence snapshots, the alert centre's recurrence line,
// the public case library and the blog watch. Synthetic names; the library's facts are checked against the docs page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KubeEvent, NodeMaintEpisode, Rollout } from "@aud/types";
import { loadEnv } from "../src/env.js";
import { correlateChanges, getChanges, ownedBy } from "../src/services/opsChanges.js";
import { changeLines, podLines, takeEvidence } from "../src/services/opsEvidence.js";
import { CaseBody, OPS_ID, attachEvidence, clearOpsMemory, readKnowledge, writeOps } from "../src/services/opsKnowledgeStore.js";
import { LIBRARY } from "../src/services/opsLibrary.js";
import { FEED_PRESETS, candidateFor, candidateOf, extractAwsPes, extractAzurePir, isIncidentUrl, statusItem, checkFeeds, clearFeedsMemory, decideItem, feedUrlProblem, feedsResponse, incidentWords, isPublicAddress, parseFeed, setFeeds } from "../src/services/opsFeeds.js";
import * as okNs from "../../web/src/lib/opsKnowledge.ts";

const OK = ((okNs as unknown as { default?: typeof okNs }).default ?? okNs) as typeof okNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUB = "00000000-0000-0000-0000-0000000000aa";
const CLUSTER = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks1`;
const env = loadEnv({ AZURE_AD_TENANT_ID: "11111111-1111-1111-1111-111111111111", AZURE_AD_CLIENT_ID: "c", AZURE_AD_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_IDS: SUB });
const AT = "2026-11-17T10:00:00.000Z";
const ro = (ns: string, d: string, at: string): Rollout => ({ namespace: ns, deployment: d, replicaset: `${d}-abc`, at, images: [{ container: "app", image: `reg.example/${d}:1.2` }], previousImages: null, service: null, before: null, after: null, afterMinutes: 0 });
const ep = (start: string, end: string | null): NodeMaintEpisode => ({ id: "e", kind: "nodeImageUpgrade", start, end, status: "succeeded", initiator: "aks", pools: ["user"], operations: [], failedOps: 0, resourceHealth: 0, nodes: [], podsRestarted: 4 });
const ev = (ns: string, name: string, reason: string, first: string, last: string): KubeEvent => ({ time: last, firstTime: first, type: "Warning", reason, kind: "Pod", namespace: ns, name, count: 3, component: "kubelet" });

test("change correlation: [at − 120 min, at + 10 min], the same workload before the namespace before the cluster's nodes, then nearest", () => {
  const r = correlateChanges({
    at: AT, scope: { namespace: "shop", workload: "orders" },
    rollouts: [ro("shop", "orders", "2026-11-17T09:42:00Z"), ro("shop", "cart", "2026-11-17T09:55:00Z"), ro("other", "orders", "2026-11-17T09:58:00Z"), ro("shop", "orders", "2026-11-17T07:30:00Z")],
    episodes: [ep("2026-11-17T08:30:00Z", "2026-11-17T09:20:00Z"), ep("2026-11-17T05:00:00Z", "2026-11-17T06:00:00Z")],
    events: [ev("shop", "orders-7d9f6c8b4-x2k9p", "OOMKilling", "2026-11-17T09:50:00Z", "2026-11-17T10:04:00Z"), ev("shop", "orders-db-0", "BackOff", "2026-11-17T09:59:00Z", "2026-11-17T09:59:00Z")],
  });
  assert.deepEqual(r.changes.map((c) => [c.kind, c.match, c.minutesBefore]), [
    ["warningEvent", "workload", -4], ["rollout", "workload", 18], ["warningEvent", "namespace", 1], ["rollout", "namespace", 5], ["nodeMaintenance", "cluster", 90],
  ], "another namespace's rollout and changes outside the window are not listed; orders-db is not the orders workload");
  assert.deepEqual(r.counts, { rollouts: 2, nodeMaintenance: 1, warningEvents: 2 });
  assert.equal(correlateChanges({ at: AT, scope: {}, rollouts: [ro("x", "y", "2026-11-17T09:00:00Z")], episodes: null, events: null }).changes[0]!.match, "cluster", "no scope: the whole cluster");
});

test("a workload's own objects: the ReplicaSet, Deployment / StatefulSet / DaemonSet pods — not another workload sharing the prefix", () => {
  for (const n of ["orders", "orders-7d9f6c8b4", "orders-7d9f6c8b4-x2k9p", "orders-0", "orders-12", "orders-x2k9p", "orders-bcdfg"]) assert.equal(ownedBy(n, "orders"), true, n);
  for (const n of ["orders-db-0", "orders-db", "orders-api-7d9f6c8b4-x2k9p", "ordersx", "orders-worker"]) assert.equal(ownedBy(n, "orders"), false, n);
});

test("change sources: events older than AKS keeps them = expired, a failed read = failed — never 'no change'", async () => {
  const fail = async () => { throw new Error("ARM 403"); };
  const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const r = await getChanges(env, "t", CLUSTER, old, { namespace: "shop" }, { rollouts: fail as never, maintenance: async () => ({ episodes: [] }) as never, events: fail as never });
  assert.deepEqual(r.sources, { rollouts: "failed", nodeMaintenance: "ok", warningEvents: "expired" });
  const ancient = await getChanges(env, "t", CLUSTER, "2026-01-01T00:00:00Z", {}, { rollouts: fail as never, maintenance: fail as never, events: fail as never });
  assert.deepEqual([ancient.sources.rollouts, ancient.sources.nodeMaintenance], ["notRead", "notRead"]);
  assert.equal(changeLines(r).state, "failed", "nothing listed and sources unread: failed, not empty");
});

test("evidence: every section says its state; pods of the workload only; event messages masked; logs only where allowed", async () => {
  const pods = [
    { metadata: { name: "orders-7d9f6c8b4-x2k9p" }, status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, restartCount: 5, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-11-17T09:58:00Z" } }, state: { waiting: { reason: "CrashLoopBackOff" } } }] } },
    { metadata: { name: "orders-db-0" }, status: { phase: "Running", containerStatuses: [] } },
  ];
  assert.deepEqual(podLines(pods, "orders"), ["orders-7d9f6c8b4-x2k9p Running ready 0/1 restarts 5 waiting CrashLoopBackOff last OOMKilled(exit 137) at 2026-11-17T09:58:00.000Z"]);
  const e = await takeEvidence(env, "t", { clusterId: CLUSTER, clusterName: "aks1", namespace: "shop", workload: "orders" }, AT, "op", {
    changes: async () => ({ at: AT, windowMinutes: 120, scope: {}, sources: { rollouts: "ok", nodeMaintenance: "ok", warningEvents: "ok" }, changes: [{ kind: "rollout", at: AT, title: "shop/orders", match: "workload", minutesBefore: 18 }], counts: { rollouts: 1, nodeMaintenance: 0, warningEvents: 0 } }),
    pods: async () => pods,
    events: async () => ({ clusterId: CLUSTER, generatedAt: AT, source: "k8sApi", messages: true, events: [{ ...ev("shop", "orders-7d9f6c8b4-x2k9p", "Unhealthy", AT, AT), message: "probe failed Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl" }] }),
    logs: async () => ({ clusterId: CLUSTER, generatedAt: AT, state: "ok", namespace: "shop", windowMinutes: 60, errors: 12, warns: 3, services: [{ workload: "orders", errors: 12, warns: 3 }], exceptions: [{ workload: "orders", cls: "java.lang.OutOfMemoryError", count: 4 }], exceptionClasses: 1, timeline: null }) as never,
  });
  assert.deepEqual(e.sections.map((x) => [x.kind, x.state]), [["changes", "ok"], ["pods", "ok"], ["events", "ok"], ["logErrors", "ok"]]);
  assert.deepEqual(e.sections[3]!.lines, ["ERROR 12 · WARN 3 (60m)", "orders: ERROR 12 · WARN 3", "orders java.lang.OutOfMemoryError ×4"]);
  assert.match(read("../src/services/opsEvidence.ts"), /if \(!podLogNamespaceAllowed\(env, clusterId, ns!\)\) return \{ kind: "logErrors", state: "notAllowed"/, "logs only where pod logs may be read");
  assert.match(e.sections[0]!.lines[0]!, /^-18m \[rollout\] shop\/orders \(workload\)$/);
  assert.doesNotMatch(e.sections[2]!.lines.join("\n"), /eyJhbGci/, "a token in an event message is masked");
  const noScope = await takeEvidence(env, "t", { clusterId: CLUSTER }, AT, "op", { changes: async () => { throw new Error("x"); } });
  assert.deepEqual(noScope.sections.map((x) => x.state), ["failed", "notApplicable", "notApplicable", "notApplicable"]);
});

test("evidence is kept apart: attaching doesn't bump the revision (an open editor still saves), at most 5, and an edit keeps it", async () => {
  clearOpsMemory();
  const body = CaseBody.parse({ title: "orders OOM", status: "open", severity: "sev2", occurredAt: AT, symptoms: "x", tags: [], signals: [], scope: {}, runbookIds: [], baseRev: null });
  const { baseRev: _b, ...rest } = body;
  const w = await writeOps(undefined, "cases", null, (prev, id) => ({ ...rest, id, rev: 1, createdAt: AT, updatedAt: AT }) as never, { baseRev: null, connection: null, mayUse: () => true, title: "orders OOM" });
  assert.ok(w.ok);
  const id = (w as { item: { id: string } }).item.id;
  for (let i = 0; i < 6; i++) assert.ok((await attachEvidence(undefined, id, { takenAt: `2026-11-17T10:0${i}:00Z`, at: AT, scope: {}, sections: [] }, () => true)).ok);
  const c = (await readKnowledge(undefined, new Set())).cases[0]!;
  assert.deepEqual([c.rev, c.evidence!.length, c.evidence![0]!.takenAt], [1, 5, "2026-11-17T10:01:00Z"]);
  assert.match(read("../src/routes/ops.ts"), /\.\.\.\(prev\?\.evidence\?\.length \? \{ evidence: prev\.evidence \} : \{\}\)/, "the case PUT keeps the evidence");
  assert.equal(CaseBody.safeParse({ ...body, evidence: [] }).success, false, "evidence can't be written through the case body");
  clearOpsMemory();
});

test("public library: lib- ids, the organisation's own https page, what fixed it; the docs page lists every one with its link", () => {
  const doc = read("../../../docs/troubleshooting/public-incident-cases.md");
  assert.ok(LIBRARY.length >= 10);
  assert.equal(new Set(LIBRARY.map((c) => c.id)).size, LIBRARY.length);
  for (const c of LIBRARY) {
    assert.ok(c.id.startsWith("lib-") && OPS_ID.test(c.id), c.id);
    assert.match(c.reference!.url, /^https:\/\//);
    assert.ok(c.symptoms && c.cause && c.resolution && c.lessons, c.id);
    assert.ok(!Number.isNaN(Date.parse(c.occurredAt)), c.id);
    assert.deepEqual([c.source?.kind, c.scope], ["reference", {}]);
    assert.ok(doc.includes(c.reference!.url), `docs list ${c.id}`);
    assert.ok(doc.includes(c.id), `docs name ${c.id}`);
  }
  assert.ok(!LIBRARY.some((c) => /reddit\.com/.test(c.reference!.url)), "not confirmed on its own page — not in the library");
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Eng</title>
<item><title><![CDATA[Post-incident review: DNS outage on May 3]]></title><link>https://eng.example.com/p/dns-outage</link><pubDate>Tue, 05 May 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Root cause was an expired cert &amp; a token=abcdefabcdefabcdefabcdefabcdef</p>]]></description></item>
<item><title>Launching widgets</title><link>https://eng.example.com/p/widgets</link><pubDate>Mon, 04 May 2026 10:00:00 GMT</pubDate><description>New things</description></item>
<item><title>Off-site</title><link>http://insecure.example.com/x</link></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>RESOLVED: Multiple services were experiencing issues in region-1.</title><link rel="alternate" href="https://status.example.com/incidents/abc"/><updated>2026-11-05T12:00:00Z</updated><summary>Disruption of networking</summary></entry></feed>`;

test("feeds: RSS and Atom, https links only, plain text; incident words are words (a fact, not a score)", () => {
  const r = parseFeed(RSS);
  assert.deepEqual(r.map((x) => [x.title, x.url, x.publishedAt]), [
    ["Post-incident review: DNS outage on May 3", "https://eng.example.com/p/dns-outage", "2026-05-05T10:00:00.000Z"],
    ["Launching widgets", "https://eng.example.com/p/widgets", "2026-05-04T10:00:00.000Z"],
  ]);
  assert.match(r[0]!.summary, /^Root cause was an expired cert & a token=/);
  assert.deepEqual(parseFeed(ATOM).map((x) => [x.url, x.publishedAt]), [["https://status.example.com/incidents/abc", "2026-11-05T12:00:00.000Z"]]);
  assert.deepEqual(incidentWords("Post-incident review: DNS outage — root cause"), ["outage", "incident", "post-incident", "root cause"]);
  assert.deepEqual(incidentWords("Incidental widgets; Grace period"), [], "incidental is not incident, 'grace' is not RCA");
  assert.deepEqual(incidentWords("서비스 장애 사후 분석"), ["장애", "사후 분석"]);
  // candidates: the title or a status page incident — not words in the text (stg 2026-11-17: 22 posts with a word, 1 report)
  assert.deepEqual(candidateOf("Kubernetes v1.37: Garhwal", "https://kubernetes.io/blog/2026/v1-37/"), { candidate: false });
  assert.deepEqual(candidateOf("Cloudflare outage on November 18, 2025", "https://blog.cloudflare.com/18-november-2025-outage/"), { candidate: true, candidateBasis: "title" });
  assert.deepEqual(candidateOf("RESOLVED: Multiple services were experiencing issues in the europe-west2 region.", "https://status.cloud.google.com/incidents/abc"), { candidate: true, candidateBasis: "incidentUrl" });
  assert.equal(isIncidentUrl("https://azure.status.microsoft/en-us/status/history/?trackingId=YKYN-BWZ"), true);
  assert.equal(isIncidentUrl("https://status.openai.com/incidents/ctrsv3lwd797"), true);
  // recall on the published postmortems checked for the library (their real titles and addresses): every incident report
  // is a candidate; Uber's reliability essay (not a postmortem) is not
  const reports: Array<[string, string]> = [
    ["API, ChatGPT & Sora Facing Issues", "https://status.openai.com/incidents/ctrsv3lwd797"],
    ["A postmortem of three recent issues", "https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues"],
    ["Summary of the Amazon DynamoDB Service Disruption in the Northern Virginia (US-EAST-1) Region", "https://aws.amazon.com/message/101925/"],
    ["Summary of the Amazon Kinesis Event in the Northern Virginia (US-EAST-1) Region", "https://aws.amazon.com/message/11201/"],
    ["Summary of the Amazon S3 Service Disruption in the Northern Virginia (US-EAST-1) Region", "https://aws.amazon.com/message/41926/"],
    ["Multiple GCP products are experiencing Service issues.", "https://status.cloud.google.com/incidents/ow5i3PPK96RduMcb1SsW"],
    ["Post Incident Review (PIR) – Azure Front Door – Connectivity issues across multiple regions", "https://azure.status.microsoft/en-us/status/history/?trackingId=YKYN-BWZ"],
    ["Cloudflare outage on November 18, 2025", "https://blog.cloudflare.com/18-november-2025-outage/"],
    ["2023-03-08 Incident: Infrastructure connectivity issue affecting multiple regions", "https://www.datadoghq.com/blog/2023-03-08-multiregion-infrastructure-connectivity-issue/"],
    ["Slack's Outage on January 4th 2021", "https://slack.engineering/slacks-outage-on-january-4th-2021/"],
  ];
  for (const [t, u] of reports) assert.equal(candidateOf(t, u).candidate, true, t);
  assert.equal(candidateOf("How Uber Protects Against Retry Storms", "https://www.uber.com/us/en/blog/protecting-against-retry-storms/").candidate, false);
});

test("feeds: the URL guard — https, a public host name; addresses that resolve inside are refused", () => {
  assert.equal(feedUrlProblem("https://blog.example.com/rss"), null);
  for (const [u, why] of [["http://blog.example.com/rss", "https only"], ["https://10.0.0.5/rss", "a host name, not an address"], ["https://user:pw@blog.example.com/", "no credentials in the URL"],
    ["https://metadata/x", "a public host name"], ["https://svc.ns.svc.cluster.local/feed", "a public host name"]] as const) assert.equal(feedUrlProblem(u), why, u);
  for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.ok(FEED_PRESETS.length >= 5 && FEED_PRESETS.every((p) => feedUrlProblem(p.url) === null), "presets pass the same guard");
  assert.match(read("../src/services/opsFeeds.ts"), /redirect: "manual"/);
  assert.match(read("../src/services/opsFeeds.ts"), /addrs\.some\(\(a\) => !isPublicAddress\(a\.address\)\)/);
});

test("feeds: a check keeps new posts with first-seen times (secrets masked), a decision sticks, the list has a revision", async () => {
  clearFeedsMemory();
  assert.deepEqual(await setFeeds(env, [{ name: "Eng", url: "http://x.example.com" }], 0, "op"), { ok: false, error: "invalid", detail: "https only" });
  const s = await setFeeds(env, [{ name: "Eng", url: "https://eng.example.com/rss" }], 0, "op");
  assert.ok(s.ok);
  assert.deepEqual(await setFeeds(env, [], 0, "op"), { ok: false, error: "conflict" });
  assert.deepEqual(await checkFeeds(env, async () => RSS, undefined, new Date(AT)), { added: 2 });
  assert.deepEqual(await checkFeeds(env, async () => RSS, undefined, new Date(AT)), { added: 0 }, "seen posts are not new again");
  let r = await feedsResponse(env, true);
  assert.deepEqual(r.items.map((i) => [i.title, i.candidate, i.firstSeenAt]), [["Post-incident review: DNS outage on May 3", true, AT], ["Launching widgets", false, AT]], "incident candidates first");
  assert.doesNotMatch(r.items[0]!.summary, /abcdefabcdefabcdefabcdefabcdef/, "a token in a post is masked like any case text");
  assert.equal(await decideItem(env, r.items[1]!.id, "ignored", "op"), true);
  r = await feedsResponse(env, true);
  assert.equal(r.items[1]!.decision, "ignored");
  await checkFeeds(env, async () => { throw new Error("HTTP 503"); }, undefined, new Date(AT));
  r = await feedsResponse(env, true);
  assert.deepEqual([r.feeds[0]!.state, r.items.length], ["failed", 2], "a failed read keeps what was read");
  clearFeedsMemory();
});

test("a post → a case form → a body the API accepts (source = reference, the post's own link)", () => {
  const form = OK.emptyCase(new Date(AT), OK.feedItemPrefill({ id: "i", feedId: "f", title: "Post-incident review: DNS outage", url: "https://eng.example.com/p/dns", publishedAt: "2026-05-05T10:00:00Z", firstSeenAt: AT, summary: "Root cause …", matched: ["outage"], candidate: true, candidateBasis: "title" }, "Eng"));
  const body = OK.caseBody({ ...form, resolution: "Rotated certs" }, null);
  const parsed = CaseBody.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual([parsed.data!.source, parsed.data!.reference], [{ kind: "reference", ref: "https://eng.example.com/p/dns" }, { org: "Eng", url: "https://eng.example.com/p/dns", publishedAt: "2026-05-05" }]);
  assert.equal(OK.withLibrary({ cases: [], library: LIBRARY, runbooks: [], usage: {}, durable: false, signedIn: true, canWrite: false }).cases.length, LIBRARY.length);
});

test("wiring: routes (signed in / operator), the find view sees the library, the alert centre's recurrence line, the learn tab", () => {
  const r = read("../src/routes/ops.ts");
  assert.match(r, /router\.get\("\/api\/ops\/changes"/);
  assert.match(r, /router\.post\("\/api\/ops\/cases\/evidence", requireRole\(env, "operator"\)/);
  assert.match(r, /router\.get\("\/api\/ops\/recurrence\/alert"/);
  assert.match(r, /router\.put\("\/api\/ops\/feeds", requireRole\(env, "operator"\)/);
  assert.match(r, /findSimilar\(\{ \.\.\.body\.data, signals \}, \[\.\.\.cases, \.\.\.LIBRARY\], runbooks\)/);
  assert.match(read("../../web/src/app/notifications/page.tsx"), /<AlertRecurrence a=\{a\} \/>/);
  const page = read("../../web/src/app/runbooks/page.tsx");
  assert.match(page, /<ChangesSection c=\{c\} \/>/);
  assert.match(page, /<EvidenceSection c=\{c\} canWrite=\{canWrite\}/);
  assert.match(page, /editing\.id === null && editing\.form\.clusterId[\s\S]{0,120}\/api\/ops\/cases\/evidence/, "a new case with a cluster gets its evidence at once");
  assert.match(read("../src/env.ts"), /AUD_OPS_FEEDS_INTERVAL_SEC: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(86_400\)\.default\(3600\)/);
});

test("official RCA sources: AWS Post-Event Summaries and Azure PIR pages through their built-in extractors — none found = the page changed (an error)", () => {
  const pes = `<li><a href="https://aws.amazon.com/message/101925/">Summary of the Amazon DynamoDB Service Disruption in the Northern Virginia (US-EAST-1) Region</a> October 23, 2025<br></li>
<li><a href=\\"https://aws.amazon.com/message/74876-2/\\">Summary of the Amazon EC2 DNS Resolution Issues in the Asia Pacific (Seoul) Region (AP-NORTHEAST-2)</a> November 22, 2018<br></li>
<li><a href="/message/101925/">Summary of the Amazon DynamoDB Service Disruption in the Northern Virginia (US-EAST-1) Region</a></li>`;
  assert.deepEqual(extractAwsPes(pes).map((x) => [x.url, x.publishedAt]), [
    ["https://aws.amazon.com/message/101925/", "2025-10-23T00:00:00.000Z"], ["https://aws.amazon.com/message/74876-2/", "2018-11-22T00:00:00.000Z"],
  ], "ids with a suffix; the JSON-escaped copy; one report once, with its date");
  const pir = `<div class="col-md-8">Post Incident Review (PIR) – Network Connectivity – Gateway service degradation in multiple regions </div> <div class="col-md-3 incident-history-tracking-id"> Tracking ID: 7Q30-010 </div>`;
  assert.deepEqual(extractAzurePir(pir).map((x) => x.url), ["https://azure.status.microsoft/en-us/status/history/?trackingId=7Q30-010"]);
  assert.throws(() => extractAwsPes("<html>redesigned</html>"), /page may have changed/);
  assert.throws(() => extractAzurePir("<html>redesigned</html>"), /page may have changed/);
});

test("status pages: incident · maintenance · a postmortem that is there (not a promise) · still open — per format (live samples 2026-11-17)", () => {
  // Statuspage (GitHub, Claude, Datadog, Cloudflare): "<state> - <text>", newest first
  assert.deepEqual(statusItem("Incident with Pull Requests", "Nov 16 , 17:05 UTC Resolved - This incident has been resolved. A detailed root cause analysis will be shared as soon as it is available. Nov 16 , 16:16 UTC Update - We mitigated"), { itemKind: "incident", open: false },
    "a promised root cause analysis is not one (9 of GitHub's 25 said so)");
  assert.deepEqual(statusItem("Delayed Traces in APM", "Nov 17 , 09:12 UTC Postmortem - Read details … Nov 16 , 20:00 UTC Resolved - fixed"), { itemKind: "rca", open: false });
  assert.deepEqual(statusItem("Some users unable to sign up", "Nov 17 , 09:30 UTC Monitoring - A fix has been implemented Nov 17 , 09:00 UTC Investigating - We are"), { itemKind: "incident", open: true });
  assert.deepEqual(statusItem("PTY (Panama City) on 2026-11-27", "THIS IS A SCHEDULED EVENT Nov 27 Scheduled - We will be performing scheduled maintenance"), { itemKind: "maintenance", open: false });
  // incident.io (OpenAI): "Status: <state>"; the title's verb is not the state
  assert.deepEqual(statusItem("Investigating unexpected usage limit resets", "Status: Resolved All impacted services have now fully recovered."), { itemKind: "incident", open: false });
  assert.deepEqual(statusItem("Elevated errors on Responses API", "Status: Investigating We are looking into"), { itemKind: "incident", open: true });
  // Google Cloud: RESOLVED: / UPDATE: titles, the report in the text
  assert.deepEqual(statusItem("RESOLVED: Multiple services were experiencing issues in the europe-west2 region.", "Incident Report Summary On Monday, 19 Oct 2026 …"), { itemKind: "rca", open: false });
  assert.deepEqual(statusItem("UPDATE: Elevated latency in us-central1", "We are investigating"), { itemKind: "incident", open: true });
  // Slack / AWS Health say it in prose: no state = not claimed open
  assert.deepEqual(statusItem("Incident: Trouble with Slack", "This issue is now resolved for all users."), { itemKind: "incident", open: false });
  assert.deepEqual(statusItem("Maintenance: Scheduled maintenance for Slack Calls", "…"), { itemKind: "maintenance", open: false });
  // candidates by the source's kind
  assert.deepEqual(candidateFor("rca", { title: "GitHub availability report: October 2026", url: "https://github.blog/x" }), { candidate: true, candidateBasis: "rcaSource" });
  assert.deepEqual(candidateFor("status", { title: "PTY", url: "https://www.cloudflarestatus.com/incidents/x", itemKind: "maintenance" }), { candidate: false });
  assert.deepEqual(candidateFor("status", { title: "Incident with Pull Requests", url: "https://www.githubstatus.com/incidents/x", itemKind: "incident" }), { candidate: true, candidateBasis: "statusIncident" });
  assert.deepEqual(candidateFor("blog", { title: "Kubernetes v1.37: Garhwal", url: "https://kubernetes.io/blog/x" }), { candidate: false });
});

test("presets: official RCA reports, status page histories and blogs — every one passes the URL guard; HTML only for the two extractors", () => {
  const byKind = (k: string) => FEED_PRESETS.filter((p) => p.kind === k).length;
  assert.deepEqual([byKind("rca") >= 3, byKind("status") >= 6, byKind("blog") >= 5], [true, true, true]);
  assert.deepEqual(FEED_PRESETS.filter((p) => p.extractor).map((p) => p.extractor).sort(), ["awsPes", "azurePir"]);
  assert.ok(FEED_PRESETS.every((p) => feedUrlProblem(p.url) === null));
});

test("a status incident moves on: re-read refreshes it (open → resolved → postmortem), keeps first-seen; a page registered by URL keeps its extractor", async () => {
  clearFeedsMemory();
  const url = "https://www.githubstatus.com/history.rss";
  assert.ok((await setFeeds(env, [{ name: "GitHub", url, kind: "status" }, { name: "AWS PES", url: "https://aws.amazon.com/premiumsupport/technology/pes/" }], 0, "op")).ok);
  const rss = (state: string) => `<rss><channel><item><title>Incident with Actions</title><link>https://www.githubstatus.com/incidents/abc</link><pubDate>Tue, 17 Nov 2026 08:00:00 GMT</pubDate><description>&lt;strong&gt;${state}&lt;/strong&gt; - text</description></item></channel></rss>`;
  const pes = `<a href="https://aws.amazon.com/message/101925/">Summary of the Amazon DynamoDB Service Disruption</a> October 23, 2025`;
  const fetcher = (state: string) => async (u: string) => (u === url ? rss(state) : pes);
  await checkFeeds(env, fetcher("Investigating"), undefined, new Date("2026-11-17T08:05:00Z"));
  let r = await feedsResponse(env, true);
  const gh = () => r.items.find((i) => i.url.includes("githubstatus"))!;
  assert.deepEqual([gh().itemKind, gh().open, r.feeds.map((f) => f.kind)], ["incident", true, ["status", "rca"]]);
  assert.equal(r.items.find((i) => i.url.includes("/message/"))!.candidateBasis, "rcaSource");
  await checkFeeds(env, fetcher("Postmortem"), undefined, new Date("2026-11-18T10:00:00Z"));
  r = await feedsResponse(env, true);
  assert.deepEqual([gh().itemKind, gh().open, gh().firstSeenAt, gh().rcaSeenAt], ["rca", false, "2026-11-17T08:05:00.000Z", "2026-11-18T10:00:00.000Z"]);
  clearFeedsMemory();
});

test("a feed whose items share one <link> (AWS Health — 38 collapsed into 1 on stg): each item's own https guid is its address; the collapsed one is dropped", async () => {
  const rss = (n: number) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>Service disruption ${i}</title><link>https://status.aws.example.com/</link><guid isPermaLink="false">https://status.aws.example.com/#ec2-r${i}_17000000${i}</guid><pubDate>Tue, 17 Nov 2026 0${i}:00:00 GMT</pubDate><description>text</description></item>`).join("")}</channel></rss>`;
  assert.deepEqual(parseFeed(rss(3)).map((x) => x.url), ["https://status.aws.example.com/#ec2-r0_170000000", "https://status.aws.example.com/#ec2-r1_170000001", "https://status.aws.example.com/#ec2-r2_170000002"]);
  assert.equal(parseFeed(RSS)[0]!.url, "https://eng.example.com/p/dns-outage", "a feed with distinct links keeps them (stored ids don't move)");
  clearFeedsMemory();
  assert.ok((await setFeeds(env, [{ name: "AWS Health", url: "https://status.aws.example.com/rss/all.rss", kind: "status" }], 0, "op")).ok);
  // stored the old way: one item at the shared link
  await checkFeeds(env, async () => `<rss><channel><item><title>Service disruption 0</title><link>https://status.aws.example.com/</link><description>x</description></item></channel></rss>`, undefined, new Date(AT));
  await checkFeeds(env, async () => rss(3), undefined, new Date(AT));
  const r = await feedsResponse(env, true);
  assert.deepEqual(r.items.map((i) => i.url).sort(), ["https://status.aws.example.com/#ec2-r0_170000000", "https://status.aws.example.com/#ec2-r1_170000001", "https://status.aws.example.com/#ec2-r2_170000002"]);
  clearFeedsMemory();
});

// 2026-11-18: an implicit `auto` grid column is as wide as its widest unbreakable line — a long command (white-space:
// pre) widened the runbook step, its title and text past the detail panel (28 of 31 real runbooks, up to 1,814px).
test("runbooks screen: every grid declares its columns (minmax(0, 1fr)) — a long command scrolls in its box, never widens the panel", () => {
  const css = readFileSync(new URL("../../web/src/app/runbooks/runbooks.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const loose = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /display:\s*grid/.test(body!) && !/grid-template-columns/.test(body!) && !/(^|;)\s*width:\s*\d+px/.test(body!))
    .map(([, sel]) => sel!.trim());
  assert.deepEqual(loose, [], "grid rules without a column template (fixed-width boxes excepted)");
  // list | detail: each pane scrolls by itself on wide screens; the detail starts at its top for another item
  const page = readFileSync(new URL("../../web/src/app/runbooks/page.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/className=\{s\.pane\} scroll/g) ?? []).length, 4, "both lists and both details are scrolling panes");
  assert.match(page, /<RunbookDetail key=\{`\$\{sel\.id\}:\$\{sel\.rev\}`\}/);
  assert.match(css, /@media \(min-width: 1101px\) \{ \.pane \{ max-height: calc\(100dvh - var\(--sticky-top\) - 16px\); \} \}/);
});

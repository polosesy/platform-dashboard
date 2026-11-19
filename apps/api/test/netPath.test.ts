import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addRun, clearNetPathMemory, deleteRun, parseNetPath, readRuns, scopeOf } from "../src/services/netPath.js";
import * as vNs from "../../web/src/lib/netPathView.ts";
import * as pNs from "../../web/src/lib/netPathProbe.ts";

const V = ((vNs as unknown as { default?: typeof vNs }).default ?? vNs) as typeof vNs;
const P = ((pNs as unknown as { default?: typeof pNs }).default ?? pNs) as typeof pNs;

// Synthetic, documentation addresses (RFC 5737) — the shape of a real netpath-probe.ps1 run (2026-11-18 on a lab PC:
// 17 hops = Windows tracert to the same IP, 14 same addresses + 3 silent both, per-hop loss / average = an independent
// computation 17/17). ConvertTo-Json quirks kept: an empty hashtable is {}, a one-element array is a bare number.
const probe = (hops: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  format: "aud-netpath/1", target: "login.example.com", targetIp: "203.0.113.10", device: "lab-pc", startedAt: "2026-11-18T05:00:00.000Z",
  probes: 5, timeoutMs: 800, reached: true, hops, ...extra,
});
const H = (ttl: number, addresses: Record<string, number>, received: number, rtt: number[] | number | undefined) => ({ ttl, addresses, sent: 5, received, ...(rtt === undefined ? {} : { rtt }) });
const RUN = probe([
  H(1, { "192.168.1.1": 5 }, 5, [2, 3, 2, 2, 3]),
  H(2, { "100.64.0.1": 5 }, 5, [5, 6, 5, 5, 6]),
  H(3, { "198.51.100.1": 3, "198.51.100.2": 2 }, 5, [8, 9, 8, 9, 8]),
  H(4, { "198.51.100.9": 3 }, 3, [40, 41, 40]),            // middle-hop loss that does not carry on: ICMP limited
  H(5, {}, 0, undefined),                                      // silent hop
  H(6, { "203.0.113.10": 5 }, 5, [64, 64, 73, 64, 64]),
]);

test("parse aud-netpath/1: loss over probes, latency over answers, the busiest address first, scopes", () => {
  const r = parseNetPath("﻿" + RUN);
  assert.equal(r.source, "aud-netpath/1");
  assert.equal(r.hops.length, 6);
  assert.deepEqual(r.hops[2], { ttl: 3, ip: "198.51.100.1", others: ["198.51.100.2"], sent: 5, received: 5, lossPct: 0, rttMin: 8, rttAvg: 8.4, rttMax: 9, scope: "public" });
  assert.deepEqual({ ...r.hops[3], others: undefined }, { ttl: 4, ip: "198.51.100.9", others: undefined, sent: 5, received: 3, lossPct: 40, rttMin: 40, rttAvg: 40.3, rttMax: 41, scope: "public" });
  assert.deepEqual(r.hops[4], { ttl: 5, ip: null, others: [], sent: 5, received: 0, lossPct: 100, rttMin: null, rttAvg: null, rttMax: null, scope: null });
  assert.deepEqual([r.hops[0]!.scope, r.hops[1]!.scope], ["private", "cgnat"]);
  // one hop, one answer: ConvertTo-Json's bare number and bare object
  const one = parseNetPath(probe(H(1, { "203.0.113.10": 1 }, 1, 12) as unknown as unknown[]));
  assert.deepEqual([one.hops.length, one.hops[0]!.rttAvg], [1, 12]);
  assert.throws(() => parseNetPath("tracert output"), /netpath_not_json/);
  assert.throws(() => parseNetPath(JSON.stringify({ hello: 1 })), /netpath_unknown_format/);
  assert.throws(() => parseNetPath(probe([H(1, { "not-an-ip": 1 }, 1, 1)], { target: "bad host!" })), /netpath_unknown_format/);
  assert.deepEqual([scopeOf("10.1.2.3"), scopeOf("172.20.0.1"), scopeOf("172.32.0.1"), scopeOf("100.127.0.1"), scopeOf("x")], ["private", "private", "public", "cgnat", null]);
});

test("parse mtr --json: summaries as given, '???' = silent, reached when the last answer is the destination", () => {
  const mtr = JSON.stringify({ report: { mtr: { src: "laptop", dst: "203.0.113.10", tests: 10 }, hubs: [
    { count: 1, host: "192.168.1.1", "Loss%": 0, Snt: 10, Last: 2, Avg: 2.1, Best: 1.9, Wrst: 3.4, StDev: 0.3 },
    { count: 2, host: "???", "Loss%": 100, Snt: 10, Last: 0, Avg: 0, Best: 0, Wrst: 0, StDev: 0 },
    { count: 3, host: "203.0.113.10", "Loss%": 10, Snt: 10, Last: 50, Avg: 51.26, Best: 49.9, Wrst: 60, StDev: 2 },
  ] } });
  const r = parseNetPath(mtr);
  assert.equal(r.source, "mtr");
  assert.equal(r.reached, true);
  assert.deepEqual(r.hops.map((h) => [h.ttl, h.ip, h.received, h.lossPct, h.rttAvg]), [[1, "192.168.1.1", 10, 0, 2.1], [2, null, 0, 100, null], [3, "203.0.113.10", 9, 10, 51.3]]);
});

test("reading the path: ICMP-limited middle hop vs loss that carries on; silent hops; segments; added latency", () => {
  const v = V.pathView(parseNetPath(RUN));
  assert.deepEqual(v.hops.map((h) => h.verdict), ["ok", "ok", "ok", "icmpLimited", "silent", "ok"]);
  assert.deepEqual(v.hops.map((h) => h.segment), ["local", "transit", "transit", "transit", "transit", "destination"]);
  assert.deepEqual(v.end, { reached: true, rttAvg: 65.8, lossPct: 0, hops: 6 });
  assert.equal(v.lossFrom, null);
  assert.deepEqual(v.hops.map((h) => h.addedMs), [null, 3, 3, 31.9, null, 25.5], "2.4 → 5.4 → 8.4 → 40.3 → (silent) → 65.8");
  assert.equal(V.pathView(parseNetPath(RUN), true).hops.length, 5, "hide silent hops");
  // the same path, but the loss carries on from hop 4 to the destination → loss on the path from hop 4
  const lossy = parseNetPath(RUN.replace('"ttl":6,"addresses":{"203.0.113.10":5},"sent":5,"received":5,"rtt":[64,64,73,64,64]', '"ttl":6,"addresses":{"203.0.113.10":3},"sent":5,"received":3,"rtt":[64,64,73]'));
  const lv = V.pathView(lossy);
  assert.equal(lv.lossFrom, 4, "lossy answers back from the destination: 6, then 4 (silent hop 5 is no answer, skipped)");
  assert.equal(lv.hops.find((h) => h.ttl === 4)!.verdict, "pathLoss", "now the same 40 % carries on — loss on the path");
  assert.equal(lv.hops.find((h) => h.ttl === 6)!.verdict, "destLoss");
  // unreached: the last hop says so
  const un = V.pathView({ ...parseNetPath(RUN), reached: false });
  assert.equal(un.end.reached, false);
});

test("series: runs grouped by target × device, newest first; a changed path is said", () => {
  const a = { ...parseNetPath(RUN), id: "a", uploadedAt: "x", startedAt: "2026-11-18T05:00:00.000Z" };
  const b = { ...a, id: "b", startedAt: "2026-11-18T06:00:00.000Z" };
  const c = { ...a, id: "c", startedAt: "2026-11-18T07:00:00.000Z", hops: a.hops.map((h) => (h.ttl === 3 ? { ...h, ip: "198.51.100.77" } : h)) };
  const s = V.pathSeries([a, c, b, { ...a, id: "d", device: "other-pc" }]);
  assert.deepEqual(s.map((x) => [x.device, x.runs.map((r) => r.id)]), [["lab-pc", ["c", "b", "a"]], ["other-pc", ["d"]]]);
  assert.equal(V.samePath(a, b), true);
  assert.equal(V.samePath(c, b), false);
});

test("store: upload (device label override, author), newest first, delete; the page's script = scripts/netpath-probe.ps1", async () => {
  clearNetPathMemory();
  const r1 = await addRun(undefined, RUN, { by: "Operator One", device: "desk-12" });
  const r2 = await addRun(undefined, RUN, {});
  assert.deepEqual((await readRuns(undefined)).map((r) => r.id), [r2.id, r1.id]);
  assert.deepEqual([r1.device, r1.by, r2.device], ["desk-12", "Operator One", "lab-pc"]);
  assert.equal(await deleteRun(undefined, r1.id), true);
  assert.equal(await deleteRun(undefined, r1.id), false);
  assert.equal((await readRuns(undefined)).length, 1);
  await assert.rejects(addRun(undefined, "{}"), /netpath_unknown_format/);
  const file = readFileSync(new URL("../../../scripts/netpath-probe.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(P.NETPATH_PROBE_PS1, file, "regenerate apps/web/src/lib/netPathProbe.ts from the .ps1");
  assert.match(file, /format = 'aud-netpath\/2'/);
});

test("the target: an address bar pasted as it is → its host; bare words, IPv6 and junk refused; commands carry it", () => {
  assert.deepEqual(V.targetOf("login.microsoftonline.com"), { host: "login.microsoftonline.com", changed: false });
  assert.deepEqual(V.targetOf("  https://Outlook.Office365.com/mail/inbox?x=1#y "), { host: "outlook.office365.com", changed: true });
  assert.deepEqual(V.targetOf("http://user:pw@portal.example.com:8443/a"), { host: "portal.example.com", changed: true });
  assert.deepEqual(V.targetOf("203.0.113.10"), { host: "203.0.113.10", changed: false });
  assert.deepEqual(V.targetOf("example.com."), { host: "example.com", changed: true });
  assert.equal(V.targetOf("").reason, "empty");
  assert.equal(V.targetOf("intranet").reason, "invalid", "a bare word: the device's DNS search list decides — not measured");
  assert.equal(V.targetOf("bad_host!.com").reason, "invalid");
  assert.equal(V.targetOf("-a.example.com").reason, "invalid");
  assert.equal(V.targetOf("https://[2001:db8::1]/").reason, "ipv6");
  assert.match(V.probeCommand("login.example.com"), /-Target login\.example\.com \| Set-Clipboard$/);
  assert.ok(V.probeCommand("login.example.com").includes('-File "$HOME\\Downloads\\netpath-probe.ps1"'), "the downloaded script's path, Windows separators");
  assert.match(V.mtrCommand("login.example.com"), /^mtr --json -n -c 10 login\.example\.com /);
  assert.ok(V.TARGET_PRESETS.every((p) => V.targetOf(p.host).host === p.host), "every preset is a valid target");
});

test("the route top-down: silent runs folded, the biggest added step, the profile (answering hops only) and its axis", () => {
  const run = parseNetPath(probe([
    H(1, { "192.168.1.1": 5 }, 5, [2, 2, 2, 2, 2]), H(2, {}, 0, undefined), H(3, {}, 0, undefined), H(4, { "198.51.100.1": 5 }, 5, [10, 10, 12, 10, 8]),
    H(5, {}, 0, undefined), H(6, { "203.0.113.10": 5 }, 5, [70, 71, 72, 70, 67]),
  ]));
  const v = V.pathView(run);
  assert.deepEqual(V.routeRows(v).map((r) => (r.kind === "hop" ? r.hop.ttl : `${r.from}-${r.to}×${r.count}`)), [1, "2-3×2", 4, "5-5×1", 6]);
  assert.deepEqual(V.biggestJump(v), { ttl: 6, ms: 60 }, "2 → 10 → 70: +8 at hop 4, +60 at hop 6");
  const p = V.latencyProfile(v);
  assert.deepEqual(p.points.map((x) => [x.ttl, x.avg, x.min, x.max]), [[1, 2, 2, 2], [4, 10, 8, 12], [6, 70, 67, 72]]);
  assert.deepEqual([p.top, p.ttls], [72, 6]);
  assert.deepEqual(V.msTicks(72), [0, 20, 40, 60, 80]);
  assert.deepEqual(V.msTicks(3.2), [0, 1, 2, 3, 4]);
  assert.equal(V.biggestJump(V.pathView(parseNetPath(probe([H(1, { "203.0.113.10": 5 }, 5, [5, 5, 5, 5, 5])])))), null, "one hop: nothing added");
});

// 2026-11-18 (로그 탭 · 워크로드 전체 · ERROR): a workload's ERROR lines are stack traces up to 12,000 characters; asking
// Loki for 500 of them in one answer (≈ 5 MB) got no answer at all (held ~60 s, connection dropped → "Loki · failed")
// and 200 of them (2.5 MB) were thrown away over our 2 MB body limit. Lines are now cut on Loki's side and read in pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_LINES, SETTLE_MS, lineCut, mergePage, newest, rangeOf, readLines, windowEndNs } from "../src/services/lokiLogs.js";

test("lines are cut on Loki's side to one over what is shown (the parser marks the cut)", () => {
  assert.equal(lineCut('{namespace="shop", pod="web-1"} |~ "ERROR"'), '{namespace="shop", pod="web-1"} |~ "ERROR" | line_format "{{ __line__ | trunc 4097 }}"');
});

/** A Loki that answers backward pages like the real one (measured on stg): [start, end), newest first, at most `limit` lines */
function fakeLoki(lines: Array<{ pod: string; ts: bigint; text: string }>) {
  const calls: Array<{ query: string; limit: number }> = [];
  const fetchFn = async (input: string | URL) => {
    const u = new URL(String(input));
    const p = u.searchParams;
    const start = BigInt(p.get("start")!), end = BigInt(p.get("end")!), limit = Number(p.get("limit"));
    calls.push({ query: p.get("query")!, limit });
    const page = lines.filter((l) => l.ts >= start && l.ts < end).sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0)).slice(0, limit);
    const byPod = new Map<string, Array<[string, string]>>();
    for (const l of page) (byPod.get(l.pod) ?? byPod.set(l.pod, []).get(l.pod)!).push([String(l.ts), l.text]);
    const body = JSON.stringify({ status: "success", data: { resultType: "streams", result: [...byPod].map(([pod, values]) => ({ stream: { pod }, values })) } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}

test("paged read: the newest `limit` lines of the window, every one once, in pages of PAGE_LINES (+1 for the boundary line)", async () => {
  // 3 pods, 526 lines a second apart (like the 526 ERROR lines of the stg workload)
  const lines = Array.from({ length: 526 }, (_, i) => ({ pod: `web-${i % 3}`, ts: 1_000_000_000_000n + BigInt(i) * 1_000_000_000n, text: `ERROR line ${i}` }));
  const { calls, fetchFn } = fakeLoki(lines);
  const real = globalThis.fetch;
  globalThis.fetch = fetchFn as typeof fetch;
  try {
    const win = { start: String(lines[0]!.ts - 1n), end: String(lines.at(-1)!.ts + 1n) };
    const cfg = { url: "http://loki.test" };
    const count = (r: Awaited<ReturnType<typeof readLines>>) => (r.body.data?.result ?? []).reduce((n, s) => n + (s.values?.length ?? 0), 0);
    const r500 = await readLines(cfg, "{q}", win, 500);
    assert.equal(count(r500), 500, "exactly the limit — not 499 (the boundary line comes again)");
    const got = new Set((r500.body.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1])));
    assert.equal(got.size, 500, "no line twice");
    assert.ok(got.has("ERROR line 525") && got.has("ERROR line 26") && !got.has("ERROR line 25"), "the newest 500");
    assert.ok(calls.every((c) => c.limit <= PAGE_LINES + 1), "no page over PAGE_LINES + 1");
    assert.ok(calls.every((c) => c.query === lineCut("{q}")), "every page is cut on Loki's side");
    calls.length = 0;
    const rAll = await readLines(cfg, "{q}", win, 2000);
    assert.equal(count(rAll), 526, "a limit over what the window holds: all of them");
    assert.ok(calls.length <= 7, `pages ${calls.length}`);
  } finally {
    globalThis.fetch = real;
  }
});

test("mergePage stops on a short page, a page with nothing new, or the limit; newest keeps the newest", () => {
  const held = { seen: new Set<string>(), result: [], got: 0 } as Parameters<typeof mergePage>[0];
  const page = (vals: Array<[string, string]>) => ({ data: { result: [{ stream: { pod: "a" }, values: vals }] } });
  assert.deepEqual(mergePage(held, page([["30", "c"], ["20", "b"]]), 2, 10), { nextEnd: 21n }, "full page: next ends just after its oldest");
  assert.deepEqual(mergePage(held, page([["20", "b"]]), 2, 10), { nextEnd: null }, "short page: the window holds no more");
  assert.equal(held.got, 2, "the repeated boundary line is not counted twice");
  const h2 = { seen: new Set<string>(), result: [], got: 0 } as Parameters<typeof mergePage>[0];
  mergePage(h2, page([["5", "x"], ["5", "y"]]), 2, 10);
  assert.deepEqual(mergePage(h2, page([["5", "x"], ["5", "y"]]), 2, 10), { nextEnd: null }, "lines sharing one timestamp: nothing new — stop, no loop");
  const kept = newest([{ stream: { pod: "a" }, values: [["1", "old"], ["3", "new"]] }, { stream: { pod: "b" }, values: [["2", "mid"]] }], 2);
  assert.deepEqual(kept.flatMap((s) => s.values!.map((v) => v[1])).sort(), ["mid", "new"]);
});

test("a count and the lines are the same lines: one settled end, the read's edges = count_over_time's (t − m, t]", async () => {
  // 2026-11-19: WARN+ 180 m read 1,322 lines where Loki counted 1,323 — a live window still taking lines (on stg a window
  // ending at the cluster's now grew for 1–4 s after it), and query_range [start, end) vs count_over_time (t − m, t]
  const before = Date.now();
  const e = windowEndNs();
  assert.ok(e <= BigInt(before - SETTLE_MS + 50) * 1_000_000n && e >= BigInt(before - SETTLE_MS) * 1_000_000n, "a now window ends SETTLE_MS ago");
  assert.equal(windowEndNs(1_800_000_000), 1_800_000_000_000_000_000n, "a past window ends at `at`");
  const E = 5_000_000_000_000n, m = 1;
  const at = (dt: bigint) => ({ pod: "a", ts: E + dt, text: `line ${dt}` });
  // exactly at the start edge (not counted), just inside it, at the end (counted), just after it
  const lines = [at(-60_000_000_000n), at(-60_000_000_000n + 1n), at(0n), at(1n)];
  const counted = lines.filter((l) => l.ts > E - 60_000_000_000n && l.ts <= E).map((l) => l.text);
  const { fetchFn } = fakeLoki(lines);
  const real = globalThis.fetch;
  globalThis.fetch = fetchFn as typeof fetch;
  try {
    const r = await readLines({ url: "http://loki.test" }, "{q}", rangeOf(m, E), 100);
    const read = (r.body.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1])).sort();
    assert.deepEqual(read, counted.sort(), "the read holds exactly the lines count_over_time([1m]) at E counts");
  } finally {
    globalThis.fetch = real;
  }
});

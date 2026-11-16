// AKS 모니터링 › 로그 — the viewer and the log insights read the same scope with the same rules (2026-11-16: the
// insights said ERROR 4 for a workload over 60 minutes; the viewer showed ERROR 0 and 3 — it filtered, in the browser,
// the newest 300 lines of ONE pod, which for a gateway writing ~900 lines an hour per pod were 25 of the 60 minutes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ERROR_FILTER, ERROR_LINE, LEVEL_MAX_MINUTES, LEVEL_RULE_SOURCES, WARN_FILTER, WARN_LINE, WARN_PLUS_FILTER, insightQueries, passesLevelRule } from "../src/services/lokiLogs.js";
import * as viewNs from "../../web/src/lib/podLogView.ts";

const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// Synthetic lines in the shape of a Spring service's log pattern (no real names)
const line = (lv: string, msg: string) => `2026-01-01T00:00:00,000 [http-nio-8080-exec-1] ${lv} [svc,0123456789abcdef0123456789abcdef,0123456789abcdef,] 1 c.e.Handler [T:] - ${msg}`;

test("level rules: the LogQL text and the JavaScript regex are the same rule (one definition)", () => {
  // LogQL carries the regex inside a double-quoted string: unescaped once it is the JavaScript source
  assert.equal(LEVEL_RULE_SOURCES.error.replace(/\\\\/g, "\\"), ERROR_LINE.source);
  assert.equal(LEVEL_RULE_SOURCES.warn.replace(/\\\\/g, "\\"), WARN_LINE.source);
  assert.equal(ERROR_FILTER, `|~ "${LEVEL_RULE_SOURCES.error}"`);
  assert.equal(WARN_FILTER, `|~ "${LEVEL_RULE_SOURCES.warn}"`);
  assert.equal(WARN_PLUS_FILTER, `|~ "${LEVEL_RULE_SOURCES.error}|${LEVEL_RULE_SOURCES.warn}"`, "WARN+ is one regex — LogQL line filters cannot be OR-ed");
  // The insights count with exactly these filters
  const q = insightQueries('{namespace="ns"}', 60);
  assert.ok(q.errors.includes(ERROR_FILTER) && q.timeline.includes(ERROR_FILTER) && q.warns.includes(WARN_FILTER));
});

test("level rules: which lines pass ERROR and WARN+ (kubelet / Container Insights lines are filtered with the same rule)", () => {
  const error = line("ERROR", "[500] Unexpected error");
  const warn = line("WARN", "Error Response: GET /x -> Status: 500");
  const info = line("INFO", "Authorization header resolved");
  const debug = line("DEBUG", "Security Chain START");
  assert.deepEqual([error, warn, info, debug].map((l) => passesLevelRule(l, "error")), [true, false, false, false]);
  assert.deepEqual([error, warn, info, debug].map((l) => passesLevelRule(l, "warn")), [true, true, false, false]);
  // "Error" in a WARN line's text is not an ERROR line; the bracketed form and ANSI colours count
  assert.equal(passesLevelRule("[error]: boom", "error"), true);
  assert.equal(passesLevelRule("\x1b[31mERROR\x1b[0m boom", "error"), true);
  assert.equal(passesLevelRule("no level here", "warn"), false);
  assert.equal(LEVEL_MAX_MINUTES, 360, "regex over a day overloads a small Loki — the insights stop at 6 h too");
});

test("view: the level numbers are Loki's window counts, never the loaded lines; coverage says how much of the window is listed", () => {
  assert.deepEqual(V.levelNumbers({ error: 4, warn: 40 }), { error: 4, warnPlus: 44 });
  assert.deepEqual(V.levelNumbers({ error: 4, warn: null }), { error: 4, warnPlus: null }, "an unanswered count is no number — not 0");
  assert.deepEqual(V.levelNumbers(null), { error: null, warnPlus: null });
  const end = "2026-01-01T01:00:00.000Z";
  assert.deepEqual(V.coverageOf({ complete: true, from: null }, 60, end), { kind: "complete" });
  // The reported case: 300 lines reached back 25 minutes of 60
  assert.deepEqual(V.coverageOf({ complete: false, from: "2026-01-01T00:35:04.000Z" }, 60, end), { kind: "partial", from: "2026-01-01T00:35:04.000Z", minutes: 25 });
  assert.deepEqual(V.coverageOf({ complete: false, from: "2025-12-31T00:00:00.000Z" }, 60, end), { kind: "partial", from: "2025-12-31T00:00:00.000Z", minutes: 60 }, "never more than the window");
  assert.deepEqual(V.coverageOf(undefined, 60, end), { kind: "unknown" });
  assert.equal(V.podTail("svc-6ffc9b6b76-drjd7"), "drjd7");
});

test("route and tab: the level filter and the workload scope are the API's — the browser no longer filters loaded lines", () => {
  const route = read("../src/routes/observability.ts");
  const logs = route.slice(route.indexOf('"/api/observability/logs"'), route.indexOf("function parseKubeletLogs"));
  assert.match(logs, /queryString\(req, "level"\)/);
  assert.match(logs, /queryString\(req, "workload"\)/);
  assert.match(logs, /invalid_level/);
  assert.match(logs, /passesLevelRule/, "kubelet / Container Insights lines: the same rule, on the server");
  assert.match(logs, /state: "lokiOnly"/, "a whole workload is read from Loki only — said, not silently empty");
  assert.match(logs, /coverage: \{ complete: rawCount < limit/);
  assert.match(logs, /counts: picked\?\.source === "loki" \? counts : null/);
  // A level filter Loki answered with no lines is the answer — not a fall-through to kubelet's newest lines
  assert.match(logs, /r\.lines\.length \|\| \(level && !r\.truncated\)/);

  const svc = read("../src/services/lokiLogs.ts");
  const reader = svc.slice(svc.indexOf("export async function getPodLogsFromLoki"), svc.indexOf("// ── Hubble drops"));
  assert.match(reader, /workloadSelector\(opts\.namespace, opts\.workload\)/);
  assert.match(reader, /WARN_PLUS_FILTER/);
  assert.match(reader, /count\(ERROR_FILTER\), count\(WARN_FILTER\)/);
  assert.match(reader, /:\$\{opts\.level \?\? "all"\}:/, "the cache key carries the level");

  const tab = read("../../web/src/app/observability/components/LogsTab.tsx");
  assert.doesNotMatch(tab, /passesLevel\(/, "no level filter over the loaded lines in the browser");
  assert.doesNotMatch(tab, /levelCounts\(/, "no level numbers from the loaded lines");
  assert.match(tab, /level: levelFilter === "all" \? undefined : levelFilter/);
  assert.match(tab, /setScope\("workload"\)/, "picking a workload in the insights opens the same scope in the viewer");
  assert.match(tab, /meta\?\.key === readKey/, "numbers are shown only for the read they belong to");
  assert.match(read("../../web/src/app/observability/components/PodLogList.tsx"), /showPod/);
});

test("every new viewer string exists in ko and en", () => {
  const ops = read("../../web/src/lib/i18nOps.ts") + read("../../web/src/lib/i18nMessages.ts");
  for (const k of ["ob.pl.lv.allPlain", "ob.pl.lv.warnPlain", "ob.pl.lv.errorPlain", "ob.pl.scope", "ob.pl.scope.pod", "ob.pl.scope.workload",
    "ob.pl.cov.complete", "ob.pl.cov.completeHint", "ob.pl.cov.partial", "ob.pl.cov.partialHint", "ob.pl.levelWindow", "ob.pl.levelWindowHint",
    "ob.pl.countsNote", "ob.pl.noLevelLines", "ob.logs.state.lokiOnly"]) {
    assert.match(ops, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`), k);
  }
});

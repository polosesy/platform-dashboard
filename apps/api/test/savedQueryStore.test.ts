import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QUERY_ID, SavedQueryBody, clearSavedQueryMemory, newQueryId, readSavedQueries, writeSavedQuery } from "../src/services/savedQueryStore.js";

const SUB = "00000000-0000-0000-0000-0000000000aa";
const NOW = new Date("2026-10-30T00:00:00Z");
const body = (over: Partial<SavedQueryBody> = {}): SavedQueryBody => ({ name: "Exposed vuln", q: "exposed.vulnSevere", includeManaged: false, watch: true, sev: "high", baseRev: null, ...over });

test("saved questions: body shape (keys only, ≤ 8), ids are ASCII slugs numbered on collision", () => {
  assert.ok(SavedQueryBody.safeParse(body()).success);
  assert.equal(SavedQueryBody.safeParse(body({ q: "exposed;drop" })).success, false);
  assert.equal(SavedQueryBody.safeParse(body({ q: "a.b.c.d.e.f.g.h.i" })).success, false, "at most 8 conditions");
  assert.equal(SavedQueryBody.safeParse({ ...body(), extra: 1 }).success, false, "strict");
  assert.equal(newQueryId("Exposed + vuln!", new Set()), "exposed-vuln");
  assert.equal(newQueryId("Exposed + vuln", new Set(["exposed-vuln"])), "exposed-vuln-2");
  assert.equal(newQueryId("노출 질문", new Set()), "q", "no ASCII → q");
  assert.ok(QUERY_ID.test("q-2") && !QUERY_ID.test("../x"));
});

test("saved questions: create, stale write gets the current one, delete needs the seen revision", async () => {
  clearSavedQueryMemory();
  const a = await writeSavedQuery(undefined, SUB, null, body(), { by: "Kim", now: NOW });
  assert.ok(a.ok && a.query && a.query.id === "exposed-vuln" && a.query.rev === 1 && a.query.updatedBy === "Kim");
  const b = await writeSavedQuery(undefined, SUB, null, body(), { now: NOW });
  assert.ok(b.ok && b.query?.id === "exposed-vuln-2", "same name twice = two questions");
  const stale = await writeSavedQuery(undefined, SUB, "exposed-vuln", body({ watch: false, baseRev: null }), { now: NOW });
  assert.ok(!stale.ok && stale.error === "conflict");
  const upd = await writeSavedQuery(undefined, SUB, "exposed-vuln", body({ watch: false, baseRev: 1 }), { now: NOW });
  assert.ok(upd.ok && upd.query?.rev === 2 && upd.query.watch === false);
  assert.equal((await writeSavedQuery(undefined, SUB, "exposed-vuln", { baseRev: 1 }, { remove: true })).ok, false, "stale delete");
  assert.ok((await writeSavedQuery(undefined, SUB, "exposed-vuln", { baseRev: 2 }, { remove: true })).ok);
  assert.deepEqual((await readSavedQueries(undefined, SUB)).map((x) => x.id), ["exposed-vuln-2"]);
  assert.equal((await writeSavedQuery(undefined, SUB, "../evil", body())).ok, false);
});

test("saved questions: a directory makes them durable next to the issue states (<sub>.queries.json)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aud-queries-"));
  try {
    assert.ok((await writeSavedQuery(dir, SUB.toUpperCase(), null, body(), { now: NOW })).ok);
    const raw = JSON.parse(await readFile(path.join(dir, `${SUB}.queries.json`), "utf8"));
    assert.equal(raw.v, 1);
    assert.deepEqual(Object.keys(raw.queries), ["exposed-vuln"]);
    assert.equal((await readSavedQueries(dir, SUB))[0]!.q, "exposed.vulnSevere");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

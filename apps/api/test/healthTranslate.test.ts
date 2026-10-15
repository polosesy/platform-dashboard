import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.js";
import { AZ_MAX_CHARS, AZ_MAX_ITEMS, chunkTexts, translateTexts } from "../src/services/health.js";

// translateTexts caches per text for a day (module state): every test uses its own texts
type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (c: Call) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { calls, fetch: f };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const azureOk = (c: Call) => json((JSON.parse(String(c.init?.body)) as Array<{ Text: string }>).map((x) => ({ translations: [{ text: `KO:${x.Text}`, to: "ko" }] })));
const env = (extra: Partial<Env> = {}) => ({ ...extra }) as Env;

test("chunkTexts: no group over the item or character limit, order kept", () => {
  assert.deepEqual(chunkTexts(["aa", "bb", "cc"], 2, 100), [[0, 1], [2]]);
  assert.deepEqual(chunkTexts(["aaaa", "bb", "cccccc"], 10, 6), [[0, 1], [2]]);
  assert.deepEqual(chunkTexts(["x".repeat(50)], 10, 6), [[0]], "a text longer than the limit goes alone, never dropped");
  assert.deepEqual(chunkTexts([], 10, 10), []);
  assert.ok(AZ_MAX_ITEMS <= 1000 && AZ_MAX_CHARS <= 50_000, "inside Translator v3 request limits");
});

test("Azure Translator: key and region headers, requests split to the limits, empty strings untouched", async () => {
  const f = fakeFetch(azureOk);
  const texts = [...Array.from({ length: 150 }, (_, i) => `event-a-${i}`), ""];
  const r = await translateTexts(env({ AZURE_TRANSLATOR_KEY: "k", AZURE_TRANSLATOR_REGION: "koreacentral" }), texts, "ko", "en", f.fetch);
  assert.ok(r.ok);
  assert.equal(r.ok && r.provider, "azure");
  assert.equal(f.calls.length, 2, `${AZ_MAX_ITEMS} per request`);
  const h = f.calls[0]!.init!.headers as Record<string, string>;
  assert.equal(h["Ocp-Apim-Subscription-Key"], "k");
  assert.equal(h["Ocp-Apim-Subscription-Region"], "koreacentral");
  assert.ok(f.calls.every((c) => c.url.startsWith("https://api.cognitive.microsofttranslator.com/translate?")));
  assert.equal(r.ok && r.translations[0], "KO:event-a-0");
  assert.equal(r.ok && r.translations[150], "");
  // a second call is answered from the cache
  const again = await translateTexts(env({ AZURE_TRANSLATOR_KEY: "k" }), ["event-a-3"], "ko", "en", f.fetch);
  assert.deepEqual(again, { ok: true, translations: ["KO:event-a-3"], provider: "cache" });
  assert.equal(f.calls.length, 2);
});

test("Azure Translator: no region header unless configured (a global resource needs none)", async () => {
  const f = fakeFetch(azureOk);
  await translateTexts(env({ AZURE_TRANSLATOR_KEY: "k" }), ["event-b"], "ko", "en", f.fetch);
  assert.equal((f.calls[0]!.init!.headers as Record<string, string>)["Ocp-Apim-Subscription-Region"], undefined);
});

test("Azure Translator failures are named; with a key set, nothing is sent anywhere else", async () => {
  for (const [status, reason] of [[401, "translator_auth"], [403, "translator_auth"], [429, "translator_quota"], [500, "translator_error"]] as const) {
    const f = fakeFetch(() => json({ error: { code: status * 1000, message: "secret-ish body" } }, status));
    const r = await translateTexts(env({ AZURE_TRANSLATOR_KEY: "bad" }), [`event-c-${status}`], "ko", "en", f.fetch);
    assert.deepEqual(r, { ok: false, reason, status });
    assert.equal(f.calls.length, 1, "no keyless fallback once a key is configured");
    assert.ok(!JSON.stringify(r).includes("secret-ish"), "the translator's error body is not passed on");
  }
});

test("no key: the keyless endpoint; when it refuses (429) the reason says so", async () => {
  const ok = fakeFetch((c) => json([[[`KO(${decodeURIComponent(new URL(c.url).searchParams.get("q") ?? "")})`, "x"]]]));
  const r = await translateTexts(env(), ["event-d"], "ko", "en", ok.fetch);
  assert.deepEqual(r, { ok: true, translations: ["KO(event-d)"], provider: "free" });
  assert.ok(ok.calls[0]!.url.startsWith("https://translate.googleapis.com/"));

  const blocked = fakeFetch(() => new Response("", { status: 429 }));
  assert.deepEqual(await translateTexts(env(), ["event-e"], "ko", "en", blocked.fetch), { ok: false, reason: "not_configured", freeStatus: 429 });
  const offline = fakeFetch(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await translateTexts(env(), ["event-f"], "ko", "en", offline.fetch), { ok: false, reason: "not_configured", freeStatus: "network" });
});

test("no key: the sample events use the built-in table without any request", async () => {
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  const r = await translateTexts(env(), ["Azure SQL Database — Planned Maintenance Window"], "ko", "en", f.fetch);
  assert.deepEqual(r, { ok: true, translations: ["Azure SQL Database — 계획된 유지 관리 기간"], provider: "builtin" });
  assert.equal(f.calls.length, 0);
});

// 리소스 상태 — Korean where Azure answers in English although ko-KR was asked (measured 2026-11-12: Load Balancer
// and NAT gateway summaries; every Service Health event). Known fixed sentences are translated from a table — whole
// sentence or nothing; the rest goes to the configured Translator; Azure's text is always kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ResourceHealthStatus } from "@aud/types";
import { hasHangul, koreanSummary } from "../src/services/rhSummaryKo.js";
import { koreanSummaries } from "../src/services/health.js";

test("known sentences Azure leaves in English → Korean in Azure's own wording; the resource is named", () => {
  assert.equal(koreanSummary("There are no known issues affecting this Load Balancer."), "이 부하 분산 장치에 영향을 미치는 알려진 문제가 없습니다.");
  assert.equal(koreanSummary("There aren't any known Azure platform problems affecting this NAT gateway."), "이 NAT 게이트웨이에 영향을 미치는 알려진 Azure 플랫폼 문제가 없습니다.");
  assert.equal(koreanSummary("There aren't any known Azure platform problems affecting this widget"), "이 리소스에 영향을 미치는 알려진 Azure 플랫폼 문제가 없습니다.", "a noun we do not know = 리소스");
  assert.match(koreanSummary("Some of your load balancing endpoints may be unavailable.  Please see the metrics blade for availability information and troubleshooting steps for recommended solutions.")!,
    /^부하 분산 엔드포인트 일부를 사용하지 못할 수 있습니다\. 가용성 정보는 메트릭 블레이드에서/);
});

test("whole sentence or nothing: Korean already, empty, unknown or only partly known texts are left to Azure's wording", () => {
  assert.equal(koreanSummary("이 리소스에 영향을 미치는 알려진 Azure 플랫폼 문제가 없습니다."), null);
  assert.equal(koreanSummary(""), null);
  assert.equal(koreanSummary(undefined), null);
  assert.equal(koreanSummary("The virtual machine is stopping as requested by an authorized user."), null);
  assert.equal(koreanSummary("There are no known issues affecting this Load Balancer. However, a zone is degraded."), null, "an extra clause must not be dropped");
  assert.ok(hasHangul("한국어") && !hasHangul("English"));
});

const res = (summary: string | undefined): ResourceHealthStatus => ({
  resourceId: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Network/loadBalancers/lb", resourceName: "lb",
  resourceType: "loadBalancers", resourceGroup: "rg", subscriptionId: "00000000-0000-0000-0000-000000000001", availabilityState: "Available", summary,
});

test("summaries: the table first (no network), Azure's text kept; without a Translator key the rest stays English", async () => {
  let calls = 0;
  const noFetch = (async () => { calls++; throw new Error("no network"); }) as unknown as typeof fetch;
  const rows = [res("There are no known issues affecting this Load Balancer."), res("이미 한국어입니다."), res("Something new Azure wrote."), res(undefined)];
  await koreanSummaries({} as never, rows, noFetch);
  assert.deepEqual([rows[0]!.summaryTranslated, rows[0]!.summaryOriginal], ["platform", "There are no known issues affecting this Load Balancer."]);
  assert.ok(hasHangul(rows[0]!.summary));
  assert.equal(rows[1]!.summaryTranslated, undefined, "Azure's own Korean is not marked");
  assert.deepEqual([rows[2]!.summary, rows[2]!.summaryTranslated], ["Something new Azure wrote.", undefined]);
  assert.equal(calls, 0, "no translator call without a key");
});

test("summaries: with a Translator key the unknown sentences are machine-translated once per distinct text and marked", async () => {
  const sent: string[][] = [];
  const fake = (async (_url: unknown, init?: { body?: string }) => {
    const texts = (JSON.parse(init?.body ?? "[]") as { Text: string }[]).map((x) => x.Text);
    sent.push(texts);
    return new Response(JSON.stringify(texts.map((t) => ({ translations: [{ text: `번역: ${t}` }] }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const rows = [res("A brand new sentence 1."), res("A brand new sentence 1."), res("There are no known issues affecting this Load Balancer.")];
  await koreanSummaries({ AZURE_TRANSLATOR_KEY: "k", AZURE_TRANSLATOR_REGION: "koreacentral" } as never, rows, fake);
  assert.deepEqual(sent.flat(), ["A brand new sentence 1."], "the table's sentence is not sent; a repeated text once");
  assert.deepEqual([rows[0]!.summaryTranslated, rows[1]!.summaryTranslated, rows[2]!.summaryTranslated], ["machine", "machine", "platform"]);
  assert.equal(rows[0]!.summaryOriginal, "A brand new sentence 1.");
});

test("web: a Korean screen translates the service events by itself, marks translated summaries, and says when Azure gave English only", () => {
  const page = readFileSync(new URL("../../web/src/app/health/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(locale !== "ko" \|\| !data\?\.events\.length \|\| autoFor\.current === data\.generatedAt\) return;/);
  assert.match(page, /void handleTranslateToggle\(true\);/);
  const panel = readFileSync(new URL("../../web/src/app/health/InstanceHealthPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /health\.summary\.\$\{r\.summaryTranslated\}/);
  assert.match(panel, /health\.summary\.englishOnly/);
  const msgs = readFileSync(new URL("../../web/src/lib/i18nMessages.ts", import.meta.url), "utf8");
  for (const k of ["health.summary.platform", "health.summary.machine", "health.summary.englishOnly", "health.level.Error", "health.level.Warning", "health.level.Informational"]) {
    assert.ok(msgs.includes(`"${k}": { ko: "`), k);
  }
});

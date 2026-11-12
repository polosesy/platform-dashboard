// 위협 탐지 한국어 (Azure answers alert texts in English only — measured 2026-11-12) and 비용 '지난달 같은 기간 대비'.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PostureAlert } from "@aud/types";
import { ALERT_KO, koreanAlertText, localizeAlerts } from "../src/services/alertTextsKo.js";
import { costChange, previousSamePeriod } from "../src/services/cost.js";

const alert = (over: Partial<PostureAlert>): PostureAlert => ({
  id: "a1", title: "Container with a sensitive volume mount detected", severity: "Medium", status: "Active", detectedAt: "2026-11-12T00:00:00Z",
  description: "Kubernetes audit log analysis detected a new container with a sensitive volume mount. The volume that was detected is a hostPath type which mounts a sensitive file or folder from the node to the container. If the container gets compromised, the attacker can use this mount for gaining access to the node.",
  resources: [], remediation: ["Review the container and the path in the alert details.", "Some step the table does not know."], ...over,
});

test("alert texts: only a whole known text is translated by the table (never a partial match)", () => {
  assert.equal(koreanAlertText("Container with a sensitive volume mount detected"), "중요한 볼륨 탑재가 있는 컨테이너가 검색됨");
  assert.equal(koreanAlertText("  Container with a sensitive   volume mount detected "), "중요한 볼륨 탑재가 있는 컨테이너가 검색됨", "whitespace only");
  assert.equal(koreanAlertText("Container with a sensitive volume mount detected on node x"), null);
  for (const [en, ko] of Object.entries(ALERT_KO)) {
    assert.ok(/[가-힣]/.test(ko), en);
    assert.ok(!/[가-힣]/.test(en), en);
  }
});

test("alert texts: table → 'platform', the original is kept; unknown texts stay English without a translator", async () => {
  const { alerts, translated } = await localizeAlerts([alert({}), alert({ id: "a2", title: "Something new detected", description: "Unknown text.", remediation: undefined })]);
  assert.equal(translated, 1);
  const a = alerts[0]!;
  assert.equal(a.title, "중요한 볼륨 탑재가 있는 컨테이너가 검색됨");
  assert.equal(a.textTranslated, "platform");
  assert.equal(a.original!.title, "Container with a sensitive volume mount detected");
  assert.deepEqual(a.remediation, ["경고 세부 정보에서 컨테이너와 경로를 검토합니다.", "Some step the table does not know."], "an unknown step is left as Azure wrote it");
  assert.equal(alerts[1]!.title, "Something new detected");
  assert.equal(alerts[1]!.textTranslated, undefined, "left in English = not marked translated (the screen says English only)");
});

test("alert texts: the translator fills what the table does not know ('machine'); a failure or an echo changes nothing", async () => {
  const seen: string[][] = [];
  const tr = async (texts: string[]) => { seen.push(texts); return texts.map((t) => (t === "Unknown text." ? "알 수 없는 문구." : t)); };
  const { alerts } = await localizeAlerts([alert({ id: "a2", title: "Something new detected", description: "Unknown text.", remediation: undefined })], tr);
  assert.deepEqual(seen, [["Something new detected", "Unknown text."]], "only what the table does not know is sent");
  assert.equal(alerts[0]!.description, "알 수 없는 문구.");
  assert.equal(alerts[0]!.title, "Something new detected", "an echoed text is not a translation");
  assert.equal(alerts[0]!.textTranslated, "machine");
  const failed = await localizeAlerts([alert({ id: "a3", title: "X detected", description: "Y.", remediation: undefined })], async () => { throw new Error("quota"); });
  assert.equal(failed.translated, 0);
  const already = await localizeAlerts([alert({ title: "이미 한국어", description: "", remediation: undefined })]);
  assert.equal(already.translated, 0);
});

test("alert texts: wired into ?lang=ko and marked on the screen", () => {
  const loc = readFileSync(new URL("../src/services/assessmentTexts.ts", import.meta.url), "utf8");
  assert.match(loc, /lang === "ko" && posture\.alerts\.length \? \(await localizeAlerts\(/);
  const page = readFileSync(new URL("../../web/src/app/security/threats/page.tsx", import.meta.url), "utf8");
  assert.match(page, /a0\.textTranslated \?/);
  assert.match(page, /health\.summary\.englishOnly/);
});

test("cost: month-to-date is compared with the same days of the previous month, not the whole month", () => {
  const p = previousSamePeriod(new Date("2026-11-12T05:00:00Z"));
  assert.deepEqual([p.from.toISOString().slice(0, 10), p.to.toISOString().slice(0, 10), p.days], ["2026-10-01", "2026-10-12", 12]);
  // a shorter previous month: 31 March → February ends on the 28th
  const feb = previousSamePeriod(new Date("2026-03-31T12:00:00Z"));
  assert.deepEqual([feb.to.toISOString().slice(0, 10), feb.days], ["2026-02-28", 28]);
  const jan = previousSamePeriod(new Date("2026-01-05T00:00:00Z"));
  assert.deepEqual([jan.from.toISOString().slice(0, 10), jan.to.toISOString().slice(0, 10)], ["2025-12-01", "2025-12-05"]);
  assert.equal(costChange(110, 100), 10);
  assert.equal(costChange(40, 100), -60);
  assert.equal(costChange(50, 0), null, "nothing to compare with is not 0 %");
  const page = readFileSync(new URL("../../web/src/app/cost/page.tsx", import.meta.url), "utf8");
  assert.match(page, /cost\.vsSamePeriod/);
  assert.match(page, /changePercentage === null \? t\("cost\.vsSamePeriodNone"\)/);
});

// 보안 권고 문구: (1) Defender's HTML entities — `&emsp;` (its indentation for sub-steps) reached the screen as text;
// (2) Korean — Microsoft's own localized texts from the assessmentMetadata list (Accept-Language), overlaid by
// assessment key; a key without one keeps English and the response says which language it carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PostureRecommendation } from "@aud/types";
import { plainText } from "../src/services/securityPosture.js";
import { TEXT_LANGUAGES, getAssessmentTexts, localizeRecommendations, textsFromMetadata } from "../src/services/assessmentTexts.js";

test("plainText: entities are decoded — &emsp; is indentation, numeric and named ones are characters, unknown ones stay", () => {
  // the reported text (Defender, container vulnerability recommendations)
  assert.equal(
    plainText("2. Update to a Secure Version<br><br>&emsp;a. Upgrade the software to the latest version &amp; verify."),
    "2. Update to a Secure Version\n\n  a. Upgrade the software to the latest version & verify.",
  );
  assert.equal(plainText("&emsp;&emsp;i. one<br />&ensp;x&nbsp;y"), "i. one\n x y", "leading indentation of the whole text is trimmed, inner kept");
  assert.equal(plainText("a<br>&emsp;&emsp;b"), "a\n    b");
  assert.equal(plainText("it&#39;s &#x2014; &quot;ok&quot; &rarr; done &hellip;"), "it's — \"ok\" → done …");
  assert.equal(plainText("&amp;lt;b&amp;gt;"), "&lt;b&gt;", "decoded once: escaped markup stays text");
  assert.equal(plainText("R&D; &unknownentity; &#0; &#xD800;"), "R&D; &unknownentity; &#0; &#xD800;", "not ours / control / invalid = left as written");
  assert.equal(plainText("line   \n\n\n\nnext"), "line\n\nnext");
});

test("remediation is no longer cut at 1,200 characters (step 4 of 4 ended mid-sentence)", () => {
  const src = readFileSync(new URL("../src/services/securityPosture.ts", import.meta.url), "utf8");
  assert.match(src, /remediation: plainText\(md\.remediationDescription, 4000\)/);
});

const rec = (key: string, title: string): PostureRecommendation => ({
  key, title, severity: "High", domain: "other", threats: [], unhealthy: 1, healthy: 0, samples: [],
  description: "English description", remediation: "English remediation", portalUrl: "https://portal.azure.com/",
});

test("Korean texts: Microsoft's catalogue by assessment key (case-insensitive), field by field; no entry = English kept", () => {
  const texts = textsFromMetadata({ value: [
    { name: "AAAA1111-0000-0000-0000-000000000001", properties: { displayName: "컨테이너 이미지의 취약성을 해결해야 합니다", description: "설명<br>둘째 줄", remediationDescription: "1. 확인<br>&emsp;a. 업그레이드" } },
    { name: "bbbb2222-0000-0000-0000-000000000002", properties: { displayName: "제목만 있음" } },
    { name: "", properties: { displayName: "이름 없음" } },
    { name: "cccc3333-0000-0000-0000-000000000003", properties: {} },
  ] });
  assert.equal(texts.size, 2, "no name / no text = not an entry");
  const out = localizeRecommendations([
    rec("aaaa1111-0000-0000-0000-000000000001", "Container images should have vulnerabilities resolved"),
    rec("BBBB2222-0000-0000-0000-000000000002", "Title only"),
    rec("dddd4444-0000-0000-0000-000000000004", "A custom recommendation"),
  ], texts);
  assert.equal(out.localized, 2);
  assert.deepEqual([out.recommendations[0]!.title, out.recommendations[0]!.description, out.recommendations[0]!.remediation],
    ["컨테이너 이미지의 취약성을 해결해야 합니다", "설명\n둘째 줄", "1. 확인\n  a. 업그레이드"]);
  assert.deepEqual([out.recommendations[1]!.title, out.recommendations[1]!.remediation], ["제목만 있음", "English remediation"], "a missing field keeps the English one");
  assert.equal(out.recommendations[2]!.title, "A custom recommendation");
  assert.equal(out.recommendations[0]!.key, "aaaa1111-0000-0000-0000-000000000001", "the key (the Portal link) is untouched");
});

test("only the app's other languages are read, never anonymously, and nothing goes to a translator", async () => {
  assert.deepEqual(TEXT_LANGUAGES, { ko: "ko-KR" });
  assert.equal(await getAssessmentTexts({} as never, "token", "00000000-0000-0000-0000-000000000001", "en"), null, "English needs no overlay");
  assert.equal(await getAssessmentTexts({} as never, undefined, "00000000-0000-0000-0000-000000000001", "ko"), null, "anonymous: the sample data stays as it is");
  const src = readFileSync(new URL("../src/services/assessmentTexts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /translateTexts|translator\.|googleapis/i, "Microsoft's texts — not machine translation");
  assert.match(src, /page\.nextLink\.startsWith\("https:\/\/management\.azure\.com\/"\)/, "only Azure's own next page is followed");
  const route = readFileSync(new URL("../src/routes/security.ts", import.meta.url), "utf8");
  assert.match(route, /localizePosture\(env, req\.auth\?\.bearerToken, posture, .*queryLang\(req\)\)/);
  const web = readFileSync(new URL("../../web/src/app/security/SecurityContext.tsx", import.meta.url), "utf8");
  assert.match(web, /`posture:\$\{subscriptionId\}:\$\{locale\}`/, "the query key carries the language");
  assert.match(web, /lang: locale/);
});

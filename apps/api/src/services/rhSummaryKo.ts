// 리소스 상태 › 인스턴스 — Korean for the Resource Health summaries Azure answers in English only.
//
// Resource Health writes `summary` in the Accept-Language for most resource types, but not all: measured 2026-11-12
// with ko-KR, Load Balancer and NAT gateway summaries came back in English ("There are no known issues affecting this
// Load Balancer.") while VMSS · Storage · Key Vault · PostgreSQL · Application Gateway · Front Door were Korean. Those
// sentences are fixed platform texts, so the ones seen are translated here from a table — worded like Azure's own
// Korean ("이 리소스에 영향을 미치는 알려진 Azure 플랫폼 문제가 없습니다"). A sentence the table does not know stays as
// Azure wrote it (then the Translator, when one is configured — services/health.ts); nothing is guessed from a
// partial match, and the original is always kept beside the translation (`summaryOriginal`).

/** Whether a text already reads Korean (Azure localized it) */
export const hasHangul = (s: string | undefined): boolean => /[가-힣]/.test(s ?? "");

/** What Azure calls the resource in the sentence → Korean (the Portal's names) */
const NOUNS: Record<string, string> = {
  "load balancer": "부하 분산 장치",
  "nat gateway": "NAT 게이트웨이",
  "public ip address": "공용 IP 주소",
  "virtual network gateway": "가상 네트워크 게이트웨이",
  "connection": "연결",
  "application gateway": "Application Gateway",
  "virtual machine": "가상 머신",
  "resource": "리소스",
};
const noun = (en: string): string => NOUNS[en.trim().toLowerCase()] ?? "리소스";

type Rule = { re: RegExp; ko: (m: RegExpExecArray) => string };
const SEE_METRICS = "가용성 정보는 메트릭 블레이드에서 확인하고, 권장 해결 방법은 문제 해결 단계를 참조하세요.";
const RULES: Rule[] = [
  { re: /^There aren't any known Azure platform problems affecting this ([A-Za-z ]{2,40})\.?$/, ko: (m) => `이 ${noun(m[1]!)}에 영향을 미치는 알려진 Azure 플랫폼 문제가 없습니다.` },
  { re: /^There are no known (?:Azure platform )?(?:issues|problems) affecting this ([A-Za-z ]{2,40})\.?$/, ko: (m) => `이 ${noun(m[1]!)}에 영향을 미치는 알려진 문제가 없습니다.` },
  {
    re: /^Some of your load balancing endpoints may be unavailable\. Please see the metrics blade for availability information and troubleshooting steps for recommended solutions\.?$/,
    ko: () => `부하 분산 엔드포인트 일부를 사용하지 못할 수 있습니다. ${SEE_METRICS}`,
  },
  {
    re: /^None of your load balancing endpoints are available\. Please see the metrics blade for availability information and troubleshooting steps for recommended solutions\.?$/,
    ko: () => `사용할 수 있는 부하 분산 엔드포인트가 없습니다. ${SEE_METRICS}`,
  },
  { re: /^We're sorry, we couldn't determine the health status of this resource\.?$/, ko: () => "이 리소스의 상태를 확인하지 못했습니다." },
  { re: /^We are currently unable to determine the health of this ([A-Za-z ]{2,40})\.?$/, ko: (m) => `지금은 이 ${noun(m[1]!)}의 상태를 확인할 수 없습니다.` },
];

/**
 * Pure: the Korean for a summary Azure left in English, or null — the whole sentence must match a known one
 * (white space aside); a text that is already Korean, empty, or unknown gives null
 */
export function koreanSummary(summary: string | undefined): string | null {
  if (!summary || hasHangul(summary)) return null;
  const s = summary.replace(/\s+/g, " ").trim();
  for (const r of RULES) {
    const m = r.re.exec(s);
    if (m) return r.ko(m);
  }
  return null;
}

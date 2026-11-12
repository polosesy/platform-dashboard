// 위협 탐지 — Korean for Defender alert texts. Measured 2026-11-12: the Defender Alerts API
// (Microsoft.Security/alerts 2022-01-01) answers the title, description and remediation steps in English whatever
// Accept-Language says (en-US and ko-KR byte-identical) — unlike assessmentMetadata, there is no official Korean.
//
// So, in order: ① a table of whole sentences this platform translated (only when the whole text matches — the same
// rule as rhSummaryKo.ts; marked "platform") ② Azure Translator when a key is configured (marked "machine"; never the
// keyless public endpoint) ③ left in English, which the screen says ("Azure가 영어로만 제공"). The English original is
// kept on the alert. Alert texts carry no resource names (those are in `entity` / `k8s`, which are not translated).

import type { PostureAlert } from "@aud/types";
import type { Env } from "../env.js";
import { translateTexts } from "./health.js";
import { hasHangul } from "./rhSummaryKo.js";

/** Whole English text → Korean (Azure's Korean wording: 검색됨 · 액세스 · 탑재 · 에스컬레이션) */
export const ALERT_KO: Record<string, string> = {
  // K8S.NODE_KubeConfigAccess
  "Access to kubelet kubeconfig file detected": "kubelet kubeconfig 파일에 대한 액세스가 검색됨",
  "Analysis of processes running on a Kubernetes cluster node detected access to kubeconfig file on the host. The kubeconfig file, normally used by the Kubelet process, contains credentials to the Kubernetes cluster API server. Access to this file is often associated with attackers attempting to access those credentials, or with security scanning tools which check if the file is accessible.":
    "Kubernetes 클러스터 노드에서 실행 중인 프로세스를 분석한 결과 호스트의 kubeconfig 파일에 대한 액세스가 검색되었습니다. 일반적으로 Kubelet 프로세스가 사용하는 kubeconfig 파일에는 Kubernetes 클러스터 API 서버에 대한 자격 증명이 들어 있습니다. 이 파일에 대한 액세스는 해당 자격 증명에 접근하려는 공격자, 또는 파일에 접근할 수 있는지 확인하는 보안 검사 도구와 관련된 경우가 많습니다.",
  "Determine whether the command line or pod specified in this alert is involved in an active penetration test or part of a security scanning / benchmark tool. If not, escalate the alert to the information security team.":
    "이 경고에 지정된 명령줄 또는 Pod가 진행 중인 침투 테스트나 보안 검사·벤치마크 도구의 일부인지 확인합니다. 그렇지 않으면 경고를 정보 보안 팀에 에스컬레이션합니다.",
  // K8S_SensitiveMount
  "Container with a sensitive volume mount detected": "중요한 볼륨 탑재가 있는 컨테이너가 검색됨",
  "Kubernetes audit log analysis detected a new container with a sensitive volume mount. The volume that was detected is a hostPath type which mounts a sensitive file or folder from the node to the container. If the container gets compromised, the attacker can use this mount for gaining access to the node.":
    "Kubernetes 감사 로그 분석에서 중요한 볼륨 탑재가 있는 새 컨테이너가 검색되었습니다. 검색된 볼륨은 노드의 중요한 파일 또는 폴더를 컨테이너에 탑재하는 hostPath 유형입니다. 컨테이너가 손상되면 공격자가 이 탑재를 사용해 노드에 대한 액세스 권한을 얻을 수 있습니다.",
  "Review the container and the path in the alert details.": "경고 세부 정보에서 컨테이너와 경로를 검토합니다.",
  "If possible, consider mounting only specific folders or files that are necessary to the container operation.":
    "가능하면 컨테이너 작동에 필요한 특정 폴더나 파일만 탑재하는 것을 고려합니다.",
  "If the container is not legitimate, escalate the alert to the information security team.":
    "컨테이너가 정상적인 것이 아니면 경고를 정보 보안 팀에 에스컬레이션합니다.",
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const TABLE = new Map(Object.entries(ALERT_KO).map(([en, ko]) => [norm(en), ko]));

/** Pure: the platform's Korean for one whole text, or null (never a partial match) */
export function koreanAlertText(text: string): string | null {
  return TABLE.get(norm(text)) ?? null;
}

type Translate = (texts: string[]) => Promise<(string | null)[]>;

/**
 * Pure apart from `translate`: Korean titles, descriptions and remediation steps. Every text is looked up on its own;
 * the alert is marked "platform" when every changed text came from the table, "machine" when any came from the
 * translator. The English is kept in `original`. Texts already in Korean, empty or hidden are left alone.
 */
export async function localizeAlerts(alerts: PostureAlert[], translate?: Translate): Promise<{ alerts: PostureAlert[]; translated: number }> {
  const texts = new Set<string>();
  for (const a of alerts) for (const t of [a.title, a.description, ...(a.remediation ?? [])]) if (t && !hasHangul(t)) texts.add(t);
  const ko = new Map<string, { text: string; by: "platform" | "machine" }>();
  const rest: string[] = [];
  for (const t of texts) {
    const hit = koreanAlertText(t);
    if (hit) ko.set(t, { text: hit, by: "platform" });
    else rest.push(t);
  }
  if (rest.length && translate) {
    const out = await translate(rest.slice(0, 100)).catch(() => [] as (string | null)[]);
    rest.slice(0, 100).forEach((t, i) => {
      const v = out[i];
      if (v && v !== t && hasHangul(v)) ko.set(t, { text: v, by: "machine" });
    });
  }
  let translated = 0;
  const next = alerts.map((a) => {
    const used = [a.title, a.description, ...(a.remediation ?? [])].map((t) => ko.get(t)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!used.length) return a;
    translated++;
    const of = (t: string) => ko.get(t)?.text ?? t;
    return {
      ...a,
      title: of(a.title),
      description: of(a.description),
      ...(a.remediation ? { remediation: a.remediation.map(of) } : {}),
      textTranslated: used.some((u) => u.by === "machine") ? ("machine" as const) : ("platform" as const),
      original: { title: a.title, description: a.description, ...(a.remediation ? { remediation: a.remediation } : {}) },
    };
  });
  return { alerts: next, translated };
}

/** The translator for `localizeAlerts`: Azure Translator only when a key is configured */
export function alertTranslator(env: Env, doFetch: typeof fetch = fetch): Translate | undefined {
  if (!env.AZURE_TRANSLATOR_KEY) return undefined;
  return async (texts) => {
    const out = await translateTexts(env, texts, "ko", "en", doFetch);
    return out.ok ? out.translations : texts.map(() => null);
  };
}

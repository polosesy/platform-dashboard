// 사례·런북 — the agent seam (stage 2, docs/architecture/ops-knowledge.md §8). SKELETON: no model is called.
//
// What is real now:
//   - agentContext() — exactly what an agent would be given: the operator's text and the team's closest experience
//     (from findSimilar), masked (services/logRedaction.ts) and cut to fixed limits. Pure and tested, so the decision
//     "what leaves the platform" can be reviewed on the real thing before any provider exists.
//   - OpsAgentProvider — the one call a provider implements (a draft, never a write, never a command).
//   - agentStatus() / GET /api/ops/agent and POST /api/ops/agent/draft (501 until a provider is configured).
// What waits for the decisions in §8: where the model runs (Microsoft Foundry in the customer's tenant · Anthropic
// API · none), what may be sent, and who approves it. AUD_OPS_AGENT accepts only "off" until then.

import type { OpsAgentContext, OpsAgentDraft, OpsAgentStatus, OpsCase, OpsRunbook, OpsSimilarResponse } from "@aud/types";
import { redactLogText } from "./logRedaction.js";

export const AGENT_LIMITS = { textChars: 4000, cases: 3, runbooks: 2, fieldChars: 800 } as const;

/** The one thing a provider does: a draft from the context (no tools, no writes, no commands run) */
export interface OpsAgentProvider {
  readonly name: string;
  draftCase(ctx: OpsAgentContext, signal: AbortSignal): Promise<OpsAgentDraft>;
}

const cut = (s: string | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined);

/**
 * Pure: the agent's input — the text and the top similar cases / runbooks in the order findSimilar ranked them,
 * every free-text field masked and cut. Nothing else (no names of other tenants' clusters: the caller's visible
 * knowledge only, as the route reads it).
 */
export function agentContext(text: string, similar: OpsSimilarResponse, cases: OpsCase[], runbooks: OpsRunbook[]): OpsAgentContext {
  let redactions = 0;
  const mask = (s: string | undefined, n: number) => {
    const c = cut(s, n);
    if (c === undefined) return undefined;
    const r = redactLogText(c);
    redactions += r.n;
    return r.text;
  };
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const byBook = new Map(runbooks.map((r) => [r.id, r]));
  const L = AGENT_LIMITS;
  const ctxCases = similar.cases.slice(0, L.cases).map((m) => byCase.get(m.id)).filter((c): c is OpsCase => !!c).map((c) => ({
    id: c.id, title: mask(c.title, 120)!, status: c.status, symptoms: mask(c.symptoms, L.fieldChars)!,
    ...(c.cause ? { cause: mask(c.cause, L.fieldChars)! } : {}), ...(c.resolution ? { resolution: mask(c.resolution, L.fieldChars)! } : {}),
  }));
  const bookIds = [...similar.suggested.map((s) => s.runbookId), ...similar.runbooks.map((m) => m.id)].filter((id, i, a) => a.indexOf(id) === i);
  const ctxBooks = bookIds.slice(0, L.runbooks).map((id) => byBook.get(id)).filter((r): r is OpsRunbook => !!r).map((r) => ({
    id: r.id, title: mask(r.title, 120)!, when: mask(r.when, L.fieldChars)!, steps: r.steps.slice(0, 10).map((s) => mask(s.title, 160)!),
  }));
  return { text: mask(text, L.textChars) ?? "", signals: similar.extracted, cases: ctxCases, runbooks: ctxBooks, redactions };
}

/** The configured provider — none exists yet (AUD_OPS_AGENT is "off" only) */
export function agentProvider(env: { AUD_OPS_AGENT?: string }): OpsAgentProvider | null {
  void env;
  return null;
}

export function agentStatus(env: { AUD_OPS_AGENT?: string }): OpsAgentStatus {
  return { state: agentProvider(env) ? "ready" : "notConfigured", provider: "none", limits: { ...AGENT_LIMITS } };
}

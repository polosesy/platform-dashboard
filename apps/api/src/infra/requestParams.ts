import type { Request, Response } from "express";
import type { Env } from "../env.js";
import { registrySubscriptions } from "./connectionRegistry.js";

/** Error carrying an HTTP status — thrown by input validators, mapped by `sendError`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Subscription / object IDs never leave the API — keep only the last 4 characters for disambiguation. */
export const maskGuids = (v: string): string => v.replace(GUID_RE, (g) => `…${g.slice(-4)}`);
/** An error message safe to return: ARM scopes and GUIDs masked, 200 characters at most */
export function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return maskGuids(raw.replace(/\/subscriptions\/[^\s'",]+/gi, "[scope]")).slice(0, 200);
}

/** Respond with an HttpError's status (401 also with WWW-Authenticate), or 500 with the given code. */
export function sendError(res: Response, e: unknown, fallbackCode: string, logTag?: string): void {
  if (res.headersSent) return;
  if (e instanceof HttpError) {
    if (e.status === 401) res.setHeader("WWW-Authenticate", `Bearer error="${e.code}"`);
    const claims = (e as { claims?: string }).claims;
    res.status(e.status).json({ error: e.code, message: safeMessage(e), ...(claims ? { claims } : {}) });
    return;
  }
  const message = safeMessage(e);
  if (logTag) console.error(`[${logTag}] ${fallbackCode}:`, message);
  res.status(500).json({ error: fallbackCode, message });
}

/** The caller must sign in (anonymous, dev mode off) — routes with sample data answer with the sample */
export const isSigninRequired = (e: unknown) => e instanceof HttpError && e.code === "signin_required";

/**
 * An Azure call failure (fetcher message `ARM|LogAnalytics <status>: …`) as a coded error: 429 → 429
 * `azure_throttled`, 401/403 → 403 `azure_forbidden` (the connection lacks the role), anything else → 502
 * `azure_upstream_failed`. Messages are masked.
 */
export function upstreamError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const message = safeMessage(e);
  const status = Number(/^(?:ARM|LogAnalytics|Prometheus)\s+(\d{3})\b/.exec(message)?.[1] ?? 0);
  if (status === 429) return new HttpError(429, "azure_throttled", message);
  if (status === 401 || status === 403) return new HttpError(403, "azure_forbidden", message);
  return new HttpError(502, "azure_upstream_failed", message);
}

/**
 * Live Azure data; sample data only when there is nothing live to show and the response says so
 * (`source:"mock"` + `note`): the loader returns null (feature off, or not signed in) or the caller must sign in.
 * A failure of a live read is an error response (`upstreamError`) — never sample numbers dressed as the
 * caller's (the cost page showed sample totals under an Azure 429). Guards against an already-closed response.
 */
export async function respondWithFallback<T extends object>(
  res: Response,
  load: () => Promise<T | null>,
  fallback: T,
  logTag: string,
): Promise<void> {
  let body: object;
  try {
    const live = await load();
    if (live) body = live;
    else {
      const signedIn = !!(res.req as Request | undefined)?.auth?.bearerToken;
      const note = (fallback as { note?: unknown }).note;
      body = { ...fallback, source: "mock", note: signedIn ? (typeof note === "string" && note ? note : "mock data") : "signin_required" };
    }
  } catch (e: unknown) {
    if (isSigninRequired(e)) body = { ...fallback, source: "mock", note: "signin_required" };
    else {
      const err = upstreamError(e);
      if (!(e instanceof HttpError)) console.error(`[${logTag}] ${err.code}:`, err.message);
      return sendError(res, err, logTag);
    }
  }
  if (res.headersSent || res.writableEnded) return;
  res.json(body);
}

/**
 * Live data for signed-in users, sample data only for anonymous callers: signin_required → 200 with the sample
 * (`source:"mock"`, `note:"signin_required"`); any other failure → its status (HttpError) or 500 with a masked
 * message — a signed-in user never sees sample numbers dressed as theirs.
 */
export async function respondLiveOrSignin<T extends object>(res: Response, load: () => Promise<T>, sample: () => T, code: string): Promise<void> {
  let body: object;
  try {
    body = await load();
  } catch (e: unknown) {
    if (!isSigninRequired(e)) return sendError(res, e, code, code);
    body = { ...sample(), source: "mock", note: "signin_required" };
  }
  if (res.headersSent || res.writableEnded) return;
  res.json(body);
}

/** Read a string query parameter (ignores arrays / objects). */
export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Read an integer query parameter clamped to [min, max]. */
export function queryInt(req: Request, name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(String(req.query[name] ?? ""), 10);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
}

/**
 * Managed subscriptions (the allow-list): every subscription of the tenant registry — the home tenant's
 * every subscription of the Azure connections (infra/connectionRegistry.ts).
 */
export function parseSubscriptionIds(env: Env): string[] {
  return registrySubscriptions(env);
}

function isAllowedSubscription(env: Env, subscriptionId: string): boolean {
  const wanted = subscriptionId.toLowerCase();
  return parseSubscriptionIds(env).some((s) => s.toLowerCase() === wanted);
}

/**
 * Validate a requested subscriptionId against the allow-list.
 * Without this, the service-principal fallback could be pointed at any
 * subscription the SP can read.
 */
export function assertAllowedSubscription(env: Env, subscriptionId: string | undefined): string | undefined {
  if (!subscriptionId) return undefined;
  if (!isAllowedSubscription(env, subscriptionId)) {
    throw new HttpError(400, "subscription_not_allowed", "subscriptionId is not a managed subscription");
  }
  return subscriptionId;
}

/** `?subscriptionId=` validated against the allow-list. */
export function querySubscriptionId(req: Request, env: Env): string | undefined {
  return assertAllowedSubscription(env, queryString(req, "subscriptionId"));
}

/** Demo diagrams use "/subscriptions/mock/..." IDs — they can never resolve in ARM, so they bypass the allow-list. */
const MOCK_SUBSCRIPTION = "mock";
const SAMPLE_SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
const ARM_ID_RE = /^\/subscriptions\/([0-9a-f-]{36}|mock)\/resourcegroups\/[^/?#\s]+\/providers\/[^?#\s]+$/i;

/**
 * Validate an Azure resource ID taken from user input before it is spliced
 * into an ARM URL: strict shape, no query/fragment/traversal, subscription in allow-list.
 * `allowMock` admits the demo "/subscriptions/mock/..." IDs (Live Diagram only).
 */
export function assertArmResourceId(env: Env, raw: string | undefined, paramName = "resourceId", allowMock = false): string {
  const id = (raw ?? "").trim();
  const m = ARM_ID_RE.exec(id);
  if (!m || id.includes("/../") || id.includes("/./")) {
    throw new HttpError(400, "invalid_resource_id", `${paramName} must be an Azure resource ID`);
  }
  // The sample data (shown to anonymous callers) uses the all-zero subscription: asking about it means "sign in"
  if (m[1]! === SAMPLE_SUBSCRIPTION && !allowMock) {
    throw new HttpError(401, "signin_required", "Sample resource — sign in to read your own Azure resources");
  }
  const isMock = m[1]!.toLowerCase() === MOCK_SUBSCRIPTION;
  if (isMock && !allowMock) {
    throw new HttpError(400, "invalid_resource_id", `${paramName} must be a real Azure resource ID`);
  }
  if (!isMock && !isAllowedSubscription(env, m[1]!)) {
    throw new HttpError(400, "subscription_not_allowed", `${paramName} belongs to a subscription that is not managed here`);
  }
  return id;
}

/** Required `?<name>=` query parameter holding an Azure resource ID. */
export function queryArmResourceId(req: Request, env: Env, name: string, allowMock = false): string {
  return assertArmResourceId(env, queryString(req, name), name, allowMock);
}

/** Quote a value as a KQL string literal (escapes backslash, quotes and line breaks). */
export function kqlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

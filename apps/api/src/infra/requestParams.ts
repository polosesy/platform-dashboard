import type { Request, Response } from "express";
import type { Env } from "../env.js";

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

/** Respond with an HttpError's status, or 500 with the given code for anything else. */
export function sendError(res: Response, e: unknown, fallbackCode: string, logTag?: string): void {
  if (res.headersSent) return;
  if (e instanceof HttpError) {
    res.status(e.status).json({ error: e.code, message: e.message });
    return;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (logTag) console.error(`[${logTag}] ${fallbackCode}:`, message);
  res.status(500).json({ error: fallbackCode, message });
}

/**
 * Serve live Azure data, falling back to mock data (with the failure in `note`)
 * when the loader returns null or throws. Validation errors (HttpError) still
 * produce their HTTP status. Guards against writing to an already-closed response.
 */
export async function respondWithFallback<T extends object>(
  res: Response,
  load: () => Promise<T | null>,
  fallback: T,
  logTag: string,
): Promise<void> {
  let body: object;
  try {
    body = (await load()) ?? fallback;
  } catch (e: unknown) {
    if (e instanceof HttpError) return sendError(res, e, logTag);
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[${logTag}] falling back to mock data:`, message);
    body = { ...fallback, note: message };
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

/** Subscription IDs configured in AZURE_SUBSCRIPTION_IDS (the allow-list). */
export function parseSubscriptionIds(env: Env): string[] {
  return (env.AZURE_SUBSCRIPTION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    throw new HttpError(400, "subscription_not_allowed", "subscriptionId is not in AZURE_SUBSCRIPTION_IDS allow-list");
  }
  return subscriptionId;
}

/** `?subscriptionId=` validated against the allow-list. */
export function querySubscriptionId(req: Request, env: Env): string | undefined {
  return assertAllowedSubscription(env, queryString(req, "subscriptionId"));
}

/** Demo diagrams use "/subscriptions/mock/..." IDs — they can never resolve in ARM, so they bypass the allow-list. */
const MOCK_SUBSCRIPTION = "mock";
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
  const isMock = m[1]!.toLowerCase() === MOCK_SUBSCRIPTION;
  if (isMock && !allowMock) {
    throw new HttpError(400, "invalid_resource_id", `${paramName} must be a real Azure resource ID`);
  }
  if (!isMock && !isAllowedSubscription(env, m[1]!)) {
    throw new HttpError(400, "subscription_not_allowed", `${paramName} belongs to a subscription outside AZURE_SUBSCRIPTION_IDS`);
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

// Facts only. Sample (mock) data is for the anonymous "look around" mode and nothing else — one guard in front of
// every /api response, so a route added later cannot leak it:
//   signed-in caller + a sample body  → 503 `live_data_unavailable` (the feature is off or nothing is readable — said,
//                                       never sample numbers dressed as the caller's)
//   anonymous caller, sample mode off → 401 `signin_required` (production default: no sample data at all)
//   anonymous caller, sample mode on  → the sample, always stamped `source:"mock"` so every screen can mark it
//
// 2026-11-12: a sample Service Health event ("AKS — Connectivity Issue in Korea Central") was read as a real Azure
// outage on a running deployment — `respondWithFallback` answered the sample to a signed-in user whenever the loader
// had nothing (feature off / no readable subscription).

import type { NextFunction, Request, Response } from "express";
import type { Env } from "../env.js";

/** Sample data is offered at all: AUD_SAMPLE_DATA, unset = on in development / test, off in production */
export function sampleDataEnabled(env: Pick<Env, "AUD_SAMPLE_DATA" | "NODE_ENV">): boolean {
  return env.AUD_SAMPLE_DATA ?? env.NODE_ENV !== "production";
}

const SAMPLE_NOTES = new Set(["signin_required", "mock", "mock data"]);

/** Pure: does this response body carry sample data (any of the markers the routes use)? */
export function isSampleBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.source === "mock" || b.dataSource === "mock" || b._source === "mock" || (typeof b.note === "string" && SAMPLE_NOTES.has(b.note));
}

export type SampleDecision = "pass" | "live_data_unavailable" | "signin_required";

/** Pure: what happens to a sample body — only an anonymous caller with sample mode on receives it */
export function sampleDecision(enabled: boolean, signedIn: boolean, body: unknown): SampleDecision {
  if (!isSampleBody(body)) return "pass";
  if (signedIn) return "live_data_unavailable";
  return enabled ? "pass" : "signin_required";
}

export const LIVE_DATA_UNAVAILABLE = {
  error: "live_data_unavailable",
  message: "No live data for this request (the feature is turned off, or no subscription is readable). Sample data is never shown to a signed-in user.",
};

/** Express middleware: wraps res.json for everything registered after it */
export function createSampleGuard(env: Pick<Env, "AUD_SAMPLE_DATA" | "NODE_ENV">) {
  const enabled = sampleDataEnabled(env);
  return (req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => {
      const decision = sampleDecision(enabled, !!req.auth?.bearerToken, body);
      if (decision === "live_data_unavailable") return json.call(res.status(503), LIVE_DATA_UNAVAILABLE);
      if (decision === "signin_required") return json.call(res.status(401), { error: "signin_required", message: "Sign in to see this data." });
      // A sample that goes out is always marked the same way (some routes only set a note)
      return json(isSampleBody(body) ? { ...(body as object), source: (body as { source?: unknown }).source ?? "mock", sample: true } : body);
    }) as Response["json"];
    next();
  };
}

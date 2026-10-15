// On-behalf-of failures → a stable HTTP error the web can act on (re-sign-in, consent, blocked …).
// Pure; unit-tested from apps/api/test/credentialPolicy.test.ts.
import { HttpError } from "./requestParams.js";

/** Optional `claims` challenge for MFA / Conditional Access step-up (passed to MSAL acquireTokenPopup) */
export class OboError extends HttpError {
  constructor(status: number, code: string, message: string, readonly claims?: string) {
    super(status, code, message);
  }
}

const masked = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (g) => `…${g.slice(-4)}`).slice(0, 200);

export function mapOboError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const raw = e instanceof Error ? e.message : String(e);
  const aadsts = /AADSTS(\d+)/.exec(raw)?.[1];
  const claims = /"claims"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  switch (aadsts) {
    case "50076": case "50079": case "50158":
      return new OboError(401, "interaction_required", "Additional sign-in is required (MFA or Conditional Access)", claims);
    case "65001":
      return new OboError(403, "consent_required", "The API is not consented for this user or tenant");
    case "53003":
      return new OboError(403, "access_blocked", "Blocked by Conditional Access");
    case "500133": case "700082":
      return new OboError(401, "token_expired", "The sign-in has expired");
  }
  if (/timed out/i.test(raw)) return new OboError(504, "obo_timeout", "Token exchange timed out");
  return new OboError(502, "obo_failed", masked(raw));
}
